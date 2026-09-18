import type { Env, GoatScope, ReflectPayload } from "../types";
import { queryFirst, queryAll, execute } from "../lib/db";
import { requirePupil, requireTeacher, requireAnySession, HttpError } from "../middleware/tenancy";
import { assertClassAccess } from "./admin";
import { resolveGoatScopeClassIds } from "../lib/goat";

function parseScope(raw: string | null): GoatScope {
  if (raw === "level" || raw === "school") return raw;
  return "class"; // default AND fallback for anything unrecognized — the safe, narrowest option
}

interface GoatListRow {
  id: number;
  student_id: number;
  first_name: string;
  last_name: string;
  class_id: number;
  class_name: string;
  article_id: number;
  article_title: string;
  created_at: string;
}

/** GET /api/goat?scope=class|level|school
 * Pupil-facing list. Defaults to "class" (their own class only) — level/school
 * are opt-in broadenings via the toggle, never the default. Lightweight: just
 * enough to render the clickable name list; full content comes from
 * GET /api/goat/:id when a pupil taps a name. */
export async function listGoatPicks(request: Request, env: Env): Promise<Response> {
  const session = await requirePupil(request, env);
  const url = new URL(request.url);
  const scope = parseScope(url.searchParams.get("scope"));

  const classIds = await resolveGoatScopeClassIds(env, session.classId, scope);

  const rows = classIds
    ? await queryAll<GoatListRow>(
        env,
        `SELECT g.id, g.student_id, s.first_name, s.last_name, g.class_id, c.name as class_name,
                g.article_id, art.title as article_title, g.created_at
         FROM goat_picks g
         JOIN students s ON s.id = g.student_id
         JOIN classes c ON c.id = g.class_id
         JOIN articles art ON art.id = g.article_id
         WHERE g.class_id IN (${classIds.map(() => "?").join(",")})
         ORDER BY g.created_at DESC`,
        ...classIds
      )
    : await queryAll<GoatListRow>(
        env,
        `SELECT g.id, g.student_id, s.first_name, s.last_name, g.class_id, c.name as class_name,
                g.article_id, art.title as article_title, g.created_at
         FROM goat_picks g
         JOIN students s ON s.id = g.student_id
         JOIN classes c ON c.id = g.class_id
         JOIN articles art ON art.id = g.article_id
         ORDER BY g.created_at DESC`
      );

  return Response.json({
    scope,
    picks: rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      className: r.class_name,
      articleTitle: r.article_title,
      isYou: r.student_id === session.studentId,
    })),
  });
}

interface GoatDetailRow {
  id: number;
  student_id: number;
  first_name: string;
  last_name: string;
  class_name: string;
  article_title: string;
  answers: string; // JSON {short, long}
  note: string | null;
  added_by_name: string;
  created_at: string;
  payload: string; // reflect task payload JSON, for the prompt text
}

/** GET /api/goat/:id
 * The pop-up: question + this pupil's response + the teacher's note. Open to
 * any logged-in session kind — see requireAnySession's comment for why. */
export async function getGoatPickDetail(request: Request, env: Env, id: number): Promise<Response> {
  await requireAnySession(request, env);

  const row = await queryFirst<GoatDetailRow>(
    env,
    `SELECT g.id, g.student_id, s.first_name, s.last_name, c.name as class_name,
            art.title as article_title, a.answers, g.note, t.name as added_by_name,
            g.created_at, tk.payload
     FROM goat_picks g
     JOIN students s ON s.id = g.student_id
     JOIN classes c ON c.id = g.class_id
     JOIN attempts a ON a.id = g.attempt_id
     JOIN tasks tk ON tk.id = a.task_id
     JOIN articles art ON art.id = g.article_id
     JOIN teachers t ON t.id = g.added_by
     WHERE g.id = ?`,
    id
  );
  if (!row) throw new HttpError(404, "GOAT pick not found");

  const payload = JSON.parse(row.payload) as ReflectPayload;
  const answers = JSON.parse(row.answers) as { short: string; long: string };

  return Response.json({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    className: row.class_name,
    articleTitle: row.article_title,
    question: payload.prompt,
    answer: answers,
    note: row.note,
    addedByName: row.added_by_name,
    addedAt: row.created_at,
  });
}

interface AttemptForPick {
  id: number;
  student_id: number;
  task_id: number;
}

/** POST /api/admin/goat
 * body: { attemptId, note? }
 * Manual curation — a teacher (their own classes only) or admin (any class)
 * picks one specific reflect submission to feature. Re-picking an attempt
 * that's already on the list updates its note instead of erroring, so
 * "override which answers are on the list" is a single action either way. */
export async function addGoatPick(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const { attemptId, note } = await request.json<{ attemptId: number; note?: string }>();
  if (!attemptId) throw new HttpError(400, "attemptId is required");

  const attempt = await queryFirst<AttemptForPick>(
    env,
    "SELECT id, student_id, task_id FROM attempts WHERE id = ?",
    attemptId
  );
  if (!attempt) throw new HttpError(404, "Attempt not found");

  const task = await queryFirst<{ type: string; article_id: number }>(
    env,
    "SELECT type, article_id FROM tasks WHERE id = ?",
    attempt.task_id
  );
  if (!task || task.type !== "reflect") {
    throw new HttpError(400, "Only Think & Respond (reflect) submissions can go on the GOAT list");
  }

  const student = await queryFirst<{ class_id: number }>(
    env,
    "SELECT class_id FROM students WHERE id = ?",
    attempt.student_id
  );
  if (!student) throw new HttpError(404, "Pupil not found");
  await assertClassAccess(env, session, student.class_id);

  const existing = await queryFirst<{ id: number }>(
    env,
    "SELECT id FROM goat_picks WHERE attempt_id = ?",
    attemptId
  );

  if (existing) {
    await execute(
      env,
      "UPDATE goat_picks SET note = ?, added_by = ?, class_id = ? WHERE id = ?",
      note ?? null,
      session.teacherId,
      student.class_id,
      existing.id
    );
    return Response.json({ id: existing.id, ok: true });
  }

  const result = await execute(
    env,
    `INSERT INTO goat_picks (attempt_id, student_id, class_id, article_id, note, added_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    attemptId,
    attempt.student_id,
    student.class_id,
    task.article_id,
    note ?? null,
    session.teacherId
  );

  return Response.json({ id: result.meta.last_row_id, ok: true }, { status: 201 });
}

interface GoatPickOwnerRow {
  id: number;
  class_id: number;
}

async function assertGoatPickAccess(
  env: Env,
  session: Awaited<ReturnType<typeof requireTeacher>>,
  goatPickId: number
): Promise<GoatPickOwnerRow> {
  const pick = await queryFirst<GoatPickOwnerRow>(env, "SELECT id, class_id FROM goat_picks WHERE id = ?", goatPickId);
  if (!pick) throw new HttpError(404, "GOAT pick not found");
  await assertClassAccess(env, session, pick.class_id);
  return pick;
}

/** PATCH /api/admin/goat/:id
 * body: { note } — edit the teacher's note without touching which response is featured. */
export async function updateGoatPick(request: Request, env: Env, id: number): Promise<Response> {
  const session = await requireTeacher(request, env);
  await assertGoatPickAccess(env, session, id);

  const { note } = await request.json<{ note?: string }>();
  await execute(env, "UPDATE goat_picks SET note = ? WHERE id = ?", note ?? null, id);
  return Response.json({ ok: true });
}

/** DELETE /api/admin/goat/:id — un-feature a response. */
export async function removeGoatPick(request: Request, env: Env, id: number): Promise<Response> {
  const session = await requireTeacher(request, env);
  await assertGoatPickAccess(env, session, id);

  await execute(env, "DELETE FROM goat_picks WHERE id = ?", id);
  return Response.json({ ok: true });
}

interface AdminGoatRow {
  id: number;
  attempt_id: number;
  student_id: number;
  first_name: string;
  last_name: string;
  article_title: string;
  note: string | null;
  created_at: string;
}

/** GET /api/admin/goat?classId=123
 * Current picks for a class, for the teacher's curation view — pair this
 * with GET /api/admin/review-queue?classId=123 (already lists every reflect
 * submission for the class) to browse candidates and pick from there. */
export async function listGoatPicksForClass(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const url = new URL(request.url);
  const classId = Number(url.searchParams.get("classId"));
  if (!classId) throw new HttpError(400, "classId query param required");
  await assertClassAccess(env, session, classId);

  const rows = await queryAll<AdminGoatRow>(
    env,
    `SELECT g.id, g.attempt_id, g.student_id, s.first_name, s.last_name, art.title as article_title, g.note, g.created_at
     FROM goat_picks g
     JOIN students s ON s.id = g.student_id
     JOIN articles art ON art.id = g.article_id
     WHERE g.class_id = ?
     ORDER BY g.created_at DESC`,
    classId
  );

  return Response.json({
    picks: rows.map((r) => ({
      id: r.id,
      attemptId: r.attempt_id,
      studentId: r.student_id,
      firstName: r.first_name,
      lastName: r.last_name,
      articleTitle: r.article_title,
      note: r.note,
      addedAt: r.created_at,
    })),
  });
}
