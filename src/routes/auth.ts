import type { Env, StudentRow } from "../types";
import { queryFirst } from "../lib/db";
import { createSession, verifyPassword } from "../lib/auth";
import { HttpError } from "../middleware/tenancy";

interface TeacherRow {
  id: number;
  email: string;
  password_hash: string;
  role: "teacher" | "admin";
}

interface ClassRow {
  id: number;
  parent_view_password_hash: string | null;
}

/** POST /api/auth/pupil/login
 * body: { reporterId: string, pressPass: string }
 * Single-school deployment — reporterId is globally unique, so there's no
 * school picker/slug step before this. */
export async function pupilLogin(request: Request, env: Env): Promise<Response> {
  const { reporterId, pressPass } = await request.json<{
    reporterId: string;
    pressPass: string;
  }>();

  if (!reporterId || !pressPass) {
    throw new HttpError(400, "reporterId and pressPass are required");
  }

  const student = await queryFirst<StudentRow>(
    env,
    "SELECT * FROM students WHERE reporter_id = ? AND archived = 0",
    reporterId
  );
  if (!student) throw new HttpError(401, "Invalid login");

  const ok = await verifyPassword(pressPass, student.press_pass_hash);
  if (!ok) throw new HttpError(401, "Invalid login");

  const token = await createSession(env, {
    kind: "pupil",
    studentId: student.id,
    classId: student.class_id,
  });

  return Response.json({
    token,
    student: {
      id: student.id,
      firstName: student.first_name,
      lastName: student.last_name,
      xp: student.xp,
      level: student.level,
    },
  });
}

/** POST /api/auth/teacher/login
 * body: { email: string, password: string }
 * Covers both teacher and admin uniformly — role comes back in the session
 * and gates which admin routes are usable. */
export async function teacherLogin(request: Request, env: Env): Promise<Response> {
  const { email, password } = await request.json<{ email: string; password: string }>();
  if (!email || !password) throw new HttpError(400, "email and password are required");

  const teacher = await queryFirst<TeacherRow>(
    env,
    "SELECT id, email, password_hash, role FROM teachers WHERE email = ?",
    email
  );
  if (!teacher) throw new HttpError(401, "Invalid login");

  const ok = await verifyPassword(password, teacher.password_hash);
  if (!ok) throw new HttpError(401, "Invalid login");

  const token = await createSession(env, {
    kind: "teacher",
    teacherId: teacher.id,
    role: teacher.role,
  });

  return Response.json({ token, role: teacher.role });
}

/** POST /api/auth/parent/login
 * body: { classId: number, password: string }
 * One shared credential per class, set by the teacher/admin. */
export async function parentLogin(request: Request, env: Env): Promise<Response> {
  const { classId, password } = await request.json<{ classId: number; password: string }>();
  if (!classId || !password) throw new HttpError(400, "classId and password are required");

  const cls = await queryFirst<ClassRow>(
    env,
    "SELECT id, parent_view_password_hash FROM classes WHERE id = ?",
    classId
  );
  if (!cls || !cls.parent_view_password_hash) throw new HttpError(401, "Invalid login");

  const ok = await verifyPassword(password, cls.parent_view_password_hash);
  if (!ok) throw new HttpError(401, "Invalid login");

  const token = await createSession(env, {
    kind: "parent",
    classId: cls.id,
  });

  return Response.json({ token });
}
