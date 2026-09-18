import type { Env } from "../types";
import { queryAll, queryFirst } from "./db";

export interface RosterEntry {
  studentId: number;
  indexNumber: number;
  firstName: string;
  lastName: string;
  xp: number | null; // null when rankings are off
  level: number | null;
  tasksCompleted: number;
  badgesCount: number;
  retries: number;
}

/** Builds the class roster respecting the `rankings_enabled` toggle exactly as
 * specified in scope §6: off -> index_number order, xp/level hidden; on ->
 * level/xp order, xp/level shown. Used identically by the pupil-facing and
 * parent-facing routes — there's deliberately no separate permission layer
 * between the two, per that decision. */
export async function getClassRoster(
  env: Env,
  classId: number
): Promise<{ rankingsEnabled: boolean; roster: RosterEntry[] }> {
  const cls = await queryFirst<{ rankings_enabled: number }>(
    env,
    "SELECT rankings_enabled FROM classes WHERE id = ?",
    classId
  );
  const rankingsEnabled = cls?.rankings_enabled === 1;

  const students = await queryAll<{
    id: number;
    index_number: number;
    first_name: string;
    last_name: string;
    xp: number;
    level: number;
  }>(
    env,
    `SELECT id, index_number, first_name, last_name, xp, level
     FROM students WHERE class_id = ? AND archived = 0`,
    classId
  );

  const roster: RosterEntry[] = [];
  for (const s of students) {
    const tasksCompleted = await queryFirst<{ n: number }>(
      env,
      "SELECT COUNT(*) as n FROM task_progress WHERE student_id = ? AND passed = 1",
      s.id
    );
    const badgesCount = await queryFirst<{ n: number }>(
      env,
      "SELECT COUNT(*) as n FROM badges WHERE student_id = ?",
      s.id
    );
    // "retries" = attempts beyond the first, summed across every task the
    // pupil has touched — i.e. attempts_count - 1 per task, floored at 0.
    const retries = await queryFirst<{ n: number }>(
      env,
      `SELECT COALESCE(SUM(MAX(attempts_count - 1, 0)), 0) as n
       FROM task_progress WHERE student_id = ?`,
      s.id
    );

    roster.push({
      studentId: s.id,
      indexNumber: s.index_number,
      firstName: s.first_name,
      lastName: s.last_name,
      xp: rankingsEnabled ? s.xp : null,
      level: rankingsEnabled ? s.level : null,
      tasksCompleted: tasksCompleted?.n ?? 0,
      badgesCount: badgesCount?.n ?? 0,
      retries: retries?.n ?? 0,
    });
  }

  if (rankingsEnabled) {
    roster.sort((a, b) => (b.level! - a.level!) || (b.xp! - a.xp!));
  } else {
    roster.sort((a, b) => a.indexNumber - b.indexNumber);
  }

  return { rankingsEnabled, roster };
}
