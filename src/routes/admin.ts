import type { Env, TeacherImportBundle } from "../types";
import { queryFirst, queryAll, execute } from "../lib/db";
import { requireTeacher, HttpError } from "../middleware/tenancy";
import { hashPassword } from "../lib/auth";
import { MASTER_IMPORT_PROMPT } from "../lib/importPromptTemplate";

export interface ClassOwnerRow {
  id: number;
  teacher_id: number | null;
}

/** A plain `teacher` may only touch classes they own; `admin` can touch any
 * class in the school. */
export async function assertClassAccess(
  env: Env,
  session: Awaited<ReturnType<typeof requireTeacher>>,
  classId: number
): Promise<ClassOwnerRow> {
  const cls = await queryFirst<ClassOwnerRow>(
    env,
    "SELECT id, teacher_id FROM classes WHERE id = ?",
    classId
  );
  if (!cls) throw new HttpError(404, "Class not found");
  if (session.role === "teacher" && cls.teacher_id !== session.teacherId) {
    throw new HttpError(403, "You don't own this class");
  }
  return cls;
}

/** GET /api/admin/classes
 * Classes the caller can manage: a plain `teacher` sees only classes they
 * own; `admin` sees every class in the school. */
export async function getClasses(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);

  const rows =
    session.role === "teacher"
      ? await queryAll<{ id: number; name: string; rankings_enabled: number; similarity_threshold: number | null; grade_level: string | null }>(
          env,
          "SELECT id, name, rankings_enabled, similarity_threshold, grade_level FROM classes WHERE teacher_id = ?",
          session.teacherId
        )
      : await queryAll<{ id: number; name: string; rankings_enabled: number; similarity_threshold: number | null; grade_level: string | null }>(
          env,
          "SELECT id, name, rankings_enabled, similarity_threshold, grade_level FROM classes"
        );

  return Response.json({
    classes: rows.map((r) => ({
      id: r.id,
      name: r.name,
      rankingsEnabled: r.rankings_enabled === 1,
      similarityThreshold: r.similarity_threshold,
      gradeLevel: r.grade_level,
    })),
  });
}

/** GET /api/admin/roster?classId=123 */
export async function getRoster(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const url = new URL(request.url);
  const classId = Number(url.searchParams.get("classId"));
  if (!classId) throw new HttpError(400, "classId query param required");

  await assertClassAccess(env, session, classId);

  const rows = await queryAll<{
    id: number;
    reporter_id: string;
    first_name: string;
    last_name: string;
    index_number: number;
    xp: number;
    level: number;
    archived: number;
  }>(
    env,
    `SELECT id, reporter_id, first_name, last_name, index_number, xp, level, archived
     FROM students WHERE class_id = ? ORDER BY index_number`,
    classId
  );

  return Response.json({
    students: rows.map((r) => ({
      id: r.id,
      reporterId: r.reporter_id,
      firstName: r.first_name,
      lastName: r.last_name,
      indexNumber: r.index_number,
      xp: r.xp,
      level: r.level,
      archived: r.archived === 1,
    })),
  });
}

/** PATCH /api/admin/classes/:id/settings
 * body: { rankingsEnabled?: boolean, similarityThreshold?: number | null }
 * similarityThreshold: null means "inherit the school default" (scope §5). */
export async function updateClassSettings(request: Request, env: Env, classId: number): Promise<Response> {
  const session = await requireTeacher(request, env);
  await assertClassAccess(env, session, classId);

  const body = await request.json<{
    rankingsEnabled?: boolean;
    similarityThreshold?: number | null;
    gradeLevel?: string | null;
  }>();

  if (body.rankingsEnabled !== undefined) {
    await execute(
      env,
      "UPDATE classes SET rankings_enabled = ? WHERE id = ?",
      body.rankingsEnabled ? 1 : 0,
      classId
    );
  }
  if (body.similarityThreshold !== undefined) {
    if (body.similarityThreshold !== null && (body.similarityThreshold < 0.5 || body.similarityThreshold > 0.99)) {
      throw new HttpError(400, "similarityThreshold must be between 0.5 and 0.99, or null to inherit the school default");
    }
    await execute(env, "UPDATE classes SET similarity_threshold = ? WHERE id = ?", body.similarityThreshold, classId);
  }
  if (body.gradeLevel !== undefined) {
    await execute(env, "UPDATE classes SET grade_level = ? WHERE id = ?", body.gradeLevel, classId);
  }

  return Response.json({ ok: true });
}

/** POST /api/admin/roster/add
 * body: { classId, reporterId, firstName, lastName, indexNumber, pressPass } */
export async function addPupil(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const body = await request.json<{
    classId: number;
    reporterId: string;
    firstName: string;
    lastName: string;
    indexNumber: number;
    pressPass: string;
  }>();

  await assertClassAccess(env, session, body.classId);

  const dupe = await queryFirst<{ id: number }>(
    env,
    "SELECT id FROM students WHERE reporter_id = ?",
    body.reporterId
  );
  if (dupe) throw new HttpError(409, `reporterId "${body.reporterId}" already exists`);

  const pressPassHash = await hashPassword(body.pressPass);
  const result = await execute(
    env,
    `INSERT INTO students (reporter_id, press_pass_hash, first_name, last_name, index_number, class_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    body.reporterId,
    pressPassHash,
    body.firstName,
    body.lastName,
    body.indexNumber,
    body.classId
  );

  return Response.json({ studentId: result.meta.last_row_id }, { status: 201 });
}

/** POST /api/admin/roster/remove
 * body: { studentId } — soft delete (archived=1); preserves XP/attempts/badges history. */
export async function removePupil(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const { studentId } = await request.json<{ studentId: number }>();

  const student = await queryFirst<{ class_id: number }>(
    env,
    "SELECT class_id FROM students WHERE id = ?",
    studentId
  );
  if (!student) throw new HttpError(404, "Pupil not found");
  await assertClassAccess(env, session, student.class_id);

  await execute(env, "UPDATE students SET archived = 1 WHERE id = ?", studentId);
  return Response.json({ ok: true });
}

/** POST /api/admin/roster/import
 * body: { classId, rows: [{ reporterId, firstName, lastName, indexNumber, pressPass }] }
 * CREATE-ONLY: any row whose reporterId already exists is skipped (never
 * overwritten) and reported back — re-importing is safe to repeat without
 * risk of clobbering an existing pupil's data. */
export async function importRoster(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const body = await request.json<{
    classId: number;
    rows: {
      reporterId: string;
      firstName: string;
      lastName: string;
      indexNumber: number;
      pressPass: string;
    }[];
  }>();

  await assertClassAccess(env, session, body.classId);

  const created: string[] = [];
  const skipped: { reporterId: string; reason: string }[] = [];

  for (const row of body.rows) {
    if (!row.reporterId || !row.firstName || !row.lastName || row.indexNumber == null || !row.pressPass) {
      skipped.push({ reporterId: row.reporterId ?? "(missing)", reason: "missing required field" });
      continue;
    }
    const dupe = await queryFirst<{ id: number }>(
      env,
      "SELECT id FROM students WHERE reporter_id = ?",
      row.reporterId
    );
    if (dupe) {
      skipped.push({ reporterId: row.reporterId, reason: "reporterId already exists — not overwritten" });
      continue;
    }
    const indexDupe = await queryFirst<{ id: number }>(
      env,
      "SELECT id FROM students WHERE class_id = ? AND index_number = ?",
      body.classId,
      row.indexNumber
    );
    if (indexDupe) {
      skipped.push({ reporterId: row.reporterId, reason: `indexNumber ${row.indexNumber} already used in this class` });
      continue;
    }

    const pressPassHash = await hashPassword(row.pressPass);
    await execute(
      env,
      `INSERT INTO students (reporter_id, press_pass_hash, first_name, last_name, index_number, class_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.reporterId,
      pressPassHash,
      row.firstName,
      row.lastName,
      row.indexNumber,
      body.classId
    );
    created.push(row.reporterId);
  }

  return Response.json({ createdCount: created.length, created, skipped });
}

/** POST /api/admin/roster/reset-password
 * body: { studentId, newPressPass } — admin types the new password directly,
 * no auto-generated reset flow, per decision. */
export async function resetPupilPassword(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const { studentId, newPressPass } = await request.json<{ studentId: number; newPressPass: string }>();

  const student = await queryFirst<{ class_id: number }>(
    env,
    "SELECT class_id FROM students WHERE id = ?",
    studentId
  );
  if (!student) throw new HttpError(404, "Pupil not found");
  await assertClassAccess(env, session, student.class_id);

  const pressPassHash = await hashPassword(newPressPass);
  await execute(env, "UPDATE students SET press_pass_hash = ? WHERE id = ?", pressPassHash, studentId);
  return Response.json({ ok: true });
}

/** POST /api/admin/roster/change-class
 * body: { studentId, newClassId }
 * Admin-only — a plain teacher cannot move a pupil out of (or into) their
 * own class, per decision. History (XP, attempts, badges) travels with the
 * pupil automatically since it's keyed by student_id, not class_id. */
export async function changePupilClass(request: Request, env: Env): Promise<Response> {
  await requireTeacher(request, env, ["admin"]);
  const { studentId, newClassId } = await request.json<{ studentId: number; newClassId: number }>();

  const student = await queryFirst<{ id: number }>(
    env,
    "SELECT id FROM students WHERE id = ?",
    studentId
  );
  if (!student) throw new HttpError(404, "Pupil not found");

  const newClass = await queryFirst<{ id: number }>(
    env,
    "SELECT id FROM classes WHERE id = ?",
    newClassId
  );
  if (!newClass) throw new HttpError(404, "Target class not found");

  await execute(env, "UPDATE students SET class_id = ? WHERE id = ?", newClassId, studentId);
  return Response.json({ ok: true });
}

/** GET /api/admin/import-prompt
 * Returns the exact prompt text for the "Breaking News" tab's "Copy Prompt"
 * button. The teacher pastes this into an external AI chat tool (ChatGPT,
 * Gemini, Claude, etc.) alongside a photo of the newspaper page — no AI
 * binding or API key lives inside this app. See lib/importPromptTemplate.ts. */
export async function getImportPrompt(request: Request, env: Env): Promise<Response> {
  await requireTeacher(request, env, ["teacher", "admin"]);
  return Response.json({ prompt: MASTER_IMPORT_PROMPT });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Deliberately strict, hand-rolled validation rather than a schema library —
 * this is the one place where a malformed paste from an external AI tool
 * could otherwise land bad data in front of pupils, so every shape
 * requirement from the master prompt is checked explicitly and named in the
 * error, not just "invalid input". Returns a list of problems; empty = valid. */
function validateImportBundle(body: unknown): string[] {
  const errors: string[] = [];
  const b = body as Partial<TeacherImportBundle> | null;

  if (!b || typeof b !== "object") return ["Body must be a JSON object"];

  if (!isNonEmptyString(b.title)) errors.push("title is required");
  if (!isNonEmptyString(b.sourceName)) errors.push("sourceName is required");
  if (!isNonEmptyString(b.publishDate) || !/^\d{4}-\d{2}-\d{2}$/.test(b.publishDate)) {
    errors.push("publishDate must be a YYYY-MM-DD string");
  }
  if (!isNonEmptyString(b.fullText)) errors.push("fullText is required");

  const chunkIds = new Set<string>();
  if (!Array.isArray(b.textChunks) || b.textChunks.length === 0) {
    errors.push("textChunks must be a non-empty array");
  } else {
    for (const [i, c] of b.textChunks.entries()) {
      if (!isNonEmptyString(c?.chunk_id) || !isNonEmptyString(c?.text)) {
        errors.push(`textChunks[${i}] must have non-empty chunk_id and text`);
      } else {
        chunkIds.add(c.chunk_id);
      }
    }
  }

  if (!b.comprehension || !Array.isArray(b.comprehension.questions)) {
    errors.push("comprehension.questions is required");
  } else {
    if (b.comprehension.questions.length !== 4) {
      errors.push(`comprehension.questions must have exactly 4 items (got ${b.comprehension.questions.length})`);
    }
    b.comprehension.questions.forEach((q, i) => {
      if (!isNonEmptyString(q?.question)) errors.push(`comprehension.questions[${i}].question is required`);
      if (!Array.isArray(q?.options) || q.options.length !== 4) {
        errors.push(`comprehension.questions[${i}].options must have exactly 4 items`);
      }
      if (typeof q?.correct_index !== "number" || q.correct_index < 0 || q.correct_index > 3) {
        errors.push(`comprehension.questions[${i}].correct_index must be 0-3`);
      }
      if (!isNonEmptyString(q?.evidence_chunk_id) || !chunkIds.has(q.evidence_chunk_id)) {
        errors.push(`comprehension.questions[${i}].evidence_chunk_id must match a chunk_id from textChunks`);
      }
    });
  }

  if (!b.vocabulary || !Array.isArray(b.vocabulary.questions) || b.vocabulary.questions.length !== 1) {
    errors.push("vocabulary.questions must have exactly 1 item");
  } else {
    const q = b.vocabulary.questions[0];
    if (!isNonEmptyString(q?.target_word)) errors.push("vocabulary.questions[0].target_word is required");
    if (!isNonEmptyString(q?.context_sentence)) errors.push("vocabulary.questions[0].context_sentence is required");
    const roles = (q?.options ?? []).map((o) => o?.role);
    const expectedRoles = ["correct_synonym", "distant_synonym", "antonym", "lookalike"];
    if (!Array.isArray(q?.options) || q.options.length !== 4 || !expectedRoles.every((r) => roles.includes(r as any))) {
      errors.push(
        "vocabulary.questions[0].options must have exactly 4 items covering roles: " + expectedRoles.join(", ")
      );
    }
    if (typeof q?.correct_index !== "number" || q.correct_index < 0 || q.correct_index > 3) {
      errors.push("vocabulary.questions[0].correct_index must be 0-3");
    }
  }

  if (!b.reflect || !isNonEmptyString(b.reflect.prompt)) {
    errors.push("reflect.prompt is required");
  }
  if (!b.reflect || !Array.isArray(b.reflect.model_answers) || b.reflect.model_answers.length !== 3) {
    errors.push("reflect.model_answers must have exactly 3 items");
  }

  return errors;
}

/** POST /api/admin/articles/import-json
 * body: TeacherImportBundle (see src/types.ts) — the JSON a teacher pastes
 * from the external AI tool's output, after running MASTER_IMPORT_PROMPT.
 * Creates the article as status='draft' plus its 3 tasks; nothing is visible
 * to pupils until a separate publish call (below) flips it to 'active' —
 * this is where a teacher's in-app review/edit step belongs, before that
 * publish call, even though the editing UI itself isn't built in this
 * skeleton yet. */
export async function importArticleJson(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env, ["teacher", "admin"]);
  const body = await request.json<TeacherImportBundle>();

  const errors = validateImportBundle(body);
  if (errors.length > 0) {
    throw new HttpError(422, `Import JSON failed validation:\n- ${errors.join("\n- ")}`);
  }

  const articleResult = await execute(
    env,
    `INSERT INTO articles
       (title, source_name, publish_date, section, full_text, text_chunks, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
    body.title,
    body.sourceName,
    body.publishDate,
    body.section ?? "",
    body.fullText,
    JSON.stringify(body.textChunks),
    session.teacherId
  );
  const articleId = articleResult.meta.last_row_id as number;

  for (const [type, payload] of [
    ["comprehension", body.comprehension],
    ["vocabulary", body.vocabulary],
    ["reflect", body.reflect],
  ] as const) {
    await execute(
      env,
      "INSERT INTO tasks (article_id, type, payload) VALUES (?, ?, ?)",
      articleId,
      type,
      JSON.stringify(payload)
    );
  }

  return Response.json({ articleId, status: "draft" }, { status: 201 });
}

/** POST /api/admin/articles/:id/publish
 * Flips a reviewed draft to 'active', making it visible to pupils. Kept as
 * its own explicit step so a teacher always has a chance to review the
 * imported JSON's content in the app before pupils can see it — the import
 * endpoint above never does this automatically. */
export async function publishArticle(request: Request, env: Env, articleId: number): Promise<Response> {
  await requireTeacher(request, env, ["teacher", "admin"]);

  const article = await queryFirst<{ status: string }>(
    env,
    "SELECT status FROM articles WHERE id = ?",
    articleId
  );
  if (!article) throw new HttpError(404, "Article not found");

  await execute(env, "UPDATE articles SET status = 'active' WHERE id = ?", articleId);
  return Response.json({ ok: true });
}
