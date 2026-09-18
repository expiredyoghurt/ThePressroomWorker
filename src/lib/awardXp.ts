import type { Env } from "../types";
import { execute, queryFirst } from "./db";
import { levelForXp } from "./xp";

/** Logs an XP delta and updates the student's running total + level.
 *
 * NOTE on atomicity: D1 batch() runs multiple statements atomically but
 * doesn't let a later statement branch on an earlier statement's result
 * within the same batch, and this function needs the post-update XP total
 * to compute the new level. So this is two sequential round-trips, not one
 * atomic batch. For a classroom-scale write volume this is an acceptable
 * trade-off, but it does mean a crash between the two calls could in theory
 * leave xp updated with a stale `level` for a moment — self-heals on the
 * next award since level is always recomputed from the current xp total,
 * never incremented independently. Flagging as a known limitation rather
 * than silently assuming it's fully atomic. */
export async function awardXp(
  env: Env,
  studentId: number,
  delta: number,
  reason: string,
  countsTowardLeaderboard = true
): Promise<{ newXp: number; newLevel: number; leveledUp: boolean }> {
  const before = await queryFirst<{ xp: number; level: number }>(
    env,
    "SELECT xp, level FROM students WHERE id = ?",
    studentId
  );
  if (!before) throw new Error(`Student ${studentId} not found`);

  await execute(
    env,
    "INSERT INTO xp_log (student_id, delta, reason, counts_toward_leaderboard) VALUES (?, ?, ?, ?)",
    studentId,
    delta,
    reason,
    countsTowardLeaderboard ? 1 : 0
  );

  const newXp = before.xp + delta;
  const { level: newLevel } = levelForXp(newXp);

  await execute(env, "UPDATE students SET xp = ?, level = ? WHERE id = ?", newXp, newLevel, studentId);

  return { newXp, newLevel, leveledUp: newLevel > before.level };
}
