import type { Env } from "../types";
import { queryFirst } from "./db";

/** classes.similarity_threshold overrides school_settings.default_similarity_threshold
 * when set; falls back to the school-wide default (and finally 0.85 as an
 * absolute last resort if even the settings row is somehow missing). */
export async function getSimilarityThreshold(env: Env, classId: number): Promise<number> {
  const cls = await queryFirst<{ similarity_threshold: number | null }>(
    env,
    "SELECT similarity_threshold FROM classes WHERE id = ?",
    classId
  );
  if (cls?.similarity_threshold != null) return cls.similarity_threshold;

  const settings = await queryFirst<{ default_similarity_threshold: number }>(
    env,
    "SELECT default_similarity_threshold FROM school_settings WHERE id = 1"
  );
  return settings?.default_similarity_threshold ?? 0.85;
}
