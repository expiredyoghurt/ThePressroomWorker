import type { Env } from "../types";
import { queryAll, queryFirst, execute } from "./db";
import { awardXp } from "./awardXp";
import { XP_VALUES } from "./xp";

/** Call after any task_progress update. Checks whether all 3 tasks for the
 * article are now `passed`, and if so — and a badge hasn't already been
 * awarded — awards the Published badge + bonus XP. Idempotent: safe to call
 * on every submit, since the UNIQUE(student_id, article_id) on `badges`
 * combined with the existence check below means it only ever fires once. */
export async function checkAndAwardPublish(
  env: Env,
  studentId: number,
  articleId: number
): Promise<{ newlyPublished: boolean }> {
  const alreadyBadged = await queryFirst<{ id: number }>(
    env,
    "SELECT id FROM badges WHERE student_id = ? AND article_id = ?",
    studentId,
    articleId
  );
  if (alreadyBadged) return { newlyPublished: false };

  const taskStatuses = await queryAll<{ passed: number }>(
    env,
    `SELECT tp.passed FROM task_progress tp
     JOIN tasks t ON t.id = tp.task_id
     WHERE t.article_id = ? AND tp.student_id = ?`,
    articleId,
    studentId
  );

  // Must have progress rows for all 3 task types, all passed.
  if (taskStatuses.length < 3 || taskStatuses.some((t) => t.passed !== 1)) {
    return { newlyPublished: false };
  }

  await execute(
    env,
    "INSERT INTO badges (student_id, article_id) VALUES (?, ?)",
    studentId,
    articleId
  );

  await awardXp(env, studentId, XP_VALUES.ARTICLE_PUBLISHED, "article_published", true);

  return { newlyPublished: true };
}
