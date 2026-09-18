import type {
  Env,
  TaskRow,
  ComprehensionPayload,
  VocabularyPayload,
  ReflectPayload,
} from "../types";
import { queryFirst } from "../lib/db";
import { requirePupil, HttpError } from "../middleware/tenancy";
import { shuffledIndices, applyShuffle } from "../lib/shuffle";

interface ArticleRow {
  id: number;
  title: string;
  source_name: string;
  publish_date: string;
  section: string | null;
  full_text: string;
  text_chunks: string; // JSON
  status: string;
}

const SEED_TTL_SECONDS = 60 * 30; // 30 min, per scope §9

function seedKey(studentId: number, taskId: number, attemptNumber: number) {
  return `seed:${studentId}:${taskId}:${attemptNumber}`;
}

async function nextAttemptNumber(env: Env, studentId: number, taskId: number): Promise<number> {
  const row = await queryFirst<{ n: number }>(
    env,
    "SELECT COUNT(*) as n FROM attempts WHERE student_id = ? AND task_id = ?",
    studentId,
    taskId
  );
  return (row?.n ?? 0) + 1;
}

/** GET /api/tasks/:taskId
 * Returns the article text plus a freshly (or seed-resumed) shuffled question
 * set, with correct_index / role labels stripped — the client only ever sees
 * option text and a position to click. */
export async function getTask(request: Request, env: Env, taskId: number): Promise<Response> {
  const session = await requirePupil(request, env);

  const task = await queryFirst<TaskRow>(env, "SELECT * FROM tasks WHERE id = ?", taskId);
  if (!task) throw new HttpError(404, "Task not found");

  const article = await queryFirst<ArticleRow>(
    env,
    "SELECT * FROM articles WHERE id = ? AND status = 'active'",
    task.article_id
  );
  if (!article) throw new HttpError(404, "Article not found or not active");

  const attemptNumber = await nextAttemptNumber(env, session.studentId, task.id);

  const articlePayload = {
    id: article.id,
    title: article.title,
    sourceName: article.source_name,
    publishDate: article.publish_date,
    section: article.section,
    fullText: article.full_text,
    textChunks: JSON.parse(article.text_chunks),
  };

  if (task.type === "reflect") {
    // No shuffle needed; model answers are withheld until after first submit
    // (enforced in routes/submit.ts, not here — this endpoint never returns them).
    const payload: ReflectPayload = JSON.parse(task.payload);
    return Response.json({
      taskId: task.id,
      type: task.type,
      attemptNumber,
      article: articlePayload,
      prompt: payload.prompt,
    });
  }

  // comprehension / vocabulary — both need a shuffle seed
  const seed = crypto.randomUUID();
  await env.SHUFFLE_SEEDS.put(seedKey(session.studentId, task.id, attemptNumber), seed, {
    expirationTtl: SEED_TTL_SECONDS,
  });

  if (task.type === "comprehension") {
    const payload: ComprehensionPayload = JSON.parse(task.payload);
    const qOrder = shuffledIndices(payload.questions.length, seed, "question-order");
    const questions = applyShuffle(payload.questions, qOrder).map((q, qi) => {
      const optOrder = shuffledIndices(q.options.length, seed, `options:${q.id}`);
      return {
        id: q.id,
        question: q.question,
        evidenceChunkId: q.evidence_chunk_id,
        options: applyShuffle(q.options, optOrder), // shuffled text only, no correct_index
      };
    });
    return Response.json({
      taskId: task.id,
      type: task.type,
      attemptNumber,
      article: articlePayload,
      questions,
    });
  }

  // vocabulary
  const payload: VocabularyPayload = JSON.parse(task.payload);
  const qOrder = shuffledIndices(payload.questions.length, seed, "question-order");
  const questions = applyShuffle(payload.questions, qOrder).map((q) => {
    const optOrder = shuffledIndices(q.options.length, seed, `options:${q.id}`);
    return {
      id: q.id,
      targetWord: q.target_word,
      contextSentence: q.context_sentence,
      options: applyShuffle(q.options.map((o) => o.text), optOrder), // strip `role` too
    };
  });
  return Response.json({
    taskId: task.id,
    type: task.type,
    attemptNumber,
    article: articlePayload,
    questions,
  });
}
