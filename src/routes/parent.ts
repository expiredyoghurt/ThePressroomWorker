import type { Env } from "../types";
import { requireParent } from "../middleware/tenancy";
import { getClassRoster } from "../lib/classView";

/** GET /api/parent/class
 * Read-only. Display name is "initial + last name" per spec (e.g. "J. Lim") —
 * never the pupil's full first name, and never individual written answers or
 * anything from the review queue. Ordering/xp-visibility follows the exact
 * same `rankings_enabled` toggle as the pupil-facing view (§6/§14). */
export async function getParentClassView(request: Request, env: Env): Promise<Response> {
  const session = await requireParent(request, env);
  const { rankingsEnabled, roster } = await getClassRoster(env, session.classId);

  return Response.json({
    rankingsEnabled,
    roster: roster.map((r) => ({
      displayName: `${r.firstName.charAt(0)}. ${r.lastName}`,
      xp: r.xp,
      level: r.level,
      tasksCompleted: r.tasksCompleted,
      badgesCount: r.badgesCount,
      retries: r.retries,
    })),
  });
}
