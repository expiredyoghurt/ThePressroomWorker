import type { Env } from "../types";
import { requirePupil } from "../middleware/tenancy";
import { getClassRoster } from "../lib/classView";

/** GET /api/rankings
 * Pupil's own class, governed by the same `rankings_enabled` toggle as the
 * parent view (scope §6/§14) — no separate permission gate. */
export async function getRankings(request: Request, env: Env): Promise<Response> {
  const session = await requirePupil(request, env);
  const { rankingsEnabled, roster } = await getClassRoster(env, session.classId);

  return Response.json({
    rankingsEnabled,
    roster: roster.map((r) => ({
      studentId: r.studentId,
      isYou: r.studentId === session.studentId,
      indexNumber: r.indexNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      xp: r.xp,
      level: r.level,
      tasksCompleted: r.tasksCompleted,
      badgesCount: r.badgesCount,
      retries: r.retries,
    })),
  });
}
