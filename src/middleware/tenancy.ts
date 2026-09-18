// Resolves the caller's session. Every route handler should go through one
// of these rather than trusting class_id / student_id values from the
// request body or query string — those always come from the session, never
// the client. Class-level access (a plain teacher only touching classes they
// own) is checked separately in routes/admin.ts's assertClassAccess.

import type { Env, PupilSession, TeacherSession, ParentSession, Role } from "../types";
import { bearerToken, readSession } from "../lib/auth";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requirePupil(request: Request, env: Env): Promise<PupilSession> {
  const session = await readSession(env, bearerToken(request));
  if (!session || session.kind !== "pupil") {
    throw new HttpError(401, "Pupil session required");
  }
  return session;
}

export async function requireTeacher(
  request: Request,
  env: Env,
  allowedRoles?: Role[]
): Promise<TeacherSession> {
  const session = await readSession(env, bearerToken(request));
  if (!session || session.kind !== "teacher") {
    throw new HttpError(401, "Staff session required");
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    throw new HttpError(403, `Requires one of: ${allowedRoles.join(", ")}`);
  }
  return session;
}

export async function requireParent(request: Request, env: Env): Promise<ParentSession> {
  const session = await readSession(env, bearerToken(request));
  if (!session || session.kind !== "parent") {
    throw new HttpError(401, "Parent session required");
  }
  return session;
}

/** Any authenticated session kind — pupil, teacher, or parent. Used where a
 * route's own data is already appropriately scoped/filtered and there's no
 * extra restriction tied to *which* kind of session is asking (e.g. the GOAT
 * pick detail pop-up: once something is visible in a pupil's GOAT list at
 * all, there's no further secret to protect by session kind). */
export async function requireAnySession(request: Request, env: Env) {
  const session = await readSession(env, bearerToken(request));
  if (!session) throw new HttpError(401, "Login required");
  return session;
}

