// Similarity check for the reflect-task soft-block flow (scope §5).
//
// Primary path: embed via Workers AI and take cosine similarity — this is what
// "cosine similarity > 0.85" in the scope doc refers to. Falls back to a plain
// token-overlap (Jaccard) score if the AI binding isn't configured, so the
// feature degrades instead of breaking local dev / early deployment.
//
// TODO before production: confirm the exact Workers AI embedding model to bind
// (e.g. "@cf/baai/bge-base-en-v1.5") and pin it here — left as a constant below
// so it's a one-line change once decided.

import type { Env } from "../types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    // Shape of the Workers AI embedding response varies slightly by model;
    // adjust the `.data[0]` access if the bound model's response differs.
    const result: any = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
    return result?.data?.[0] ?? null;
  } catch {
    return null; // fail open to the token-overlap fallback below
  }
}

/** Returns the highest similarity score between `candidate` and any of `modelAnswers`,
 * plus which method was used (useful for debugging / teacher-facing transparency). */
export async function highestSimilarity(
  env: Env,
  candidate: string,
  modelAnswers: string[]
): Promise<{ score: number; method: "embedding" | "token-overlap" }> {
  const candidateEmbedding = await embed(env, candidate);

  if (candidateEmbedding) {
    let best = 0;
    for (const answer of modelAnswers) {
      const answerEmbedding = await embed(env, answer);
      if (!answerEmbedding) continue;
      best = Math.max(best, cosineSimilarity(candidateEmbedding, answerEmbedding));
    }
    return { score: best, method: "embedding" };
  }

  // Fallback — no AI binding available
  let best = 0;
  for (const answer of modelAnswers) {
    best = Math.max(best, jaccardSimilarity(candidate, answer));
  }
  return { score: best, method: "token-overlap" };
}
