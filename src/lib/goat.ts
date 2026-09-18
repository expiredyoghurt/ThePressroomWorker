import type { Env, GoatScope } from "../types";
import { queryFirst, queryAll } from "../lib/db";

/** Resolves a pupil-chosen scope to the set of class_ids their GOAT list
 * query should include. Returns null for "no filter" (school-wide).
 *
 * "level" groups every class sharing the viewer's classes.grade_level. If
 * the viewer's own class has no grade_level set, there's nothing to group
 * by, so "level" quietly falls back to class-only — the toggle still works,
 * it just can't broaden past a class that isn't labelled with a level. */
export async function resolveGoatScopeClassIds(
  env: Env,
  viewerClassId: number,
  scope: GoatScope
): Promise<number[] | null> {
  if (scope === "school") return null;

  if (scope === "class") return [viewerClassId];

  // scope === "level"
  const viewerClass = await queryFirst<{ grade_level: string | null }>(
    env,
    "SELECT grade_level FROM classes WHERE id = ?",
    viewerClassId
  );
  if (!viewerClass?.grade_level) return [viewerClassId];

  const rows = await queryAll<{ id: number }>(
    env,
    "SELECT id FROM classes WHERE grade_level = ?",
    viewerClass.grade_level
  );
  return rows.map((r) => r.id);
}
