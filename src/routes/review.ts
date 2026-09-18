import type { Env } from "../types";
import { queryAll, queryFirst, execute } from "../lib/db";
import { requireTeacher, HttpError } from "../middleware/tenancy";
import { awardXp } from "../lib/awardXp";
import { XP_VALUES } from "../lib/xp";

interface QueueRow {
  attempt_id: number;
  student_id: number;
  first_name: string;
  last_name: string;
  task_id: number;
  article_title: string;
  attempt_number: number;
  answers: string;
  similarity_flag: number;
  similarity_score: number | null;
  submitted_at: string;
  reviewed_by: number | null;
}

/** GET /api/admin/review-queue?classId=123
 * Flagged (possible close paraphrase) submissions surface first, then
 * unreviewed ones by submission time — matches scope §12. */
export async function getReviewQueue(request: Request, env: Env): Promise<Response> {
  const session = await requireTeacher(request, env);
  const url = new URL(request.url);
  const classId = Number(url.searchParams.get("classId"));
  if (!classId) throw new HttpError(400, "classId query param required");

  const rows = await queryAll<QueueRow>(
    env,
    `SELECT
        a.id as attempt_id, a.student_id, s.first_name, s.last_name,
        a.task_id, art.title as article_title, a.attempt_number,
        a.answers, a.similarity_flag, a.similarity_score, a.submitted_at, a.reviewed_by
     FROM attempts a
     JOIN tasks t ON t.id = a.task_id
     JOIN articles art ON art.id = t.article_id
     JOIN students s ON s.id = a.student_id
     WHERE t.type = 'reflect' AND s.class_id = ?
     ORDER BY a.similarity_flag DESC, a.submitted_at ASC`,
    classId
  );

  return Response.json({
    queue: rows.map((r) => ({
      attemptId: r.attempt_id,
      studentName: `${r.first_name} ${r.last_name}`,
      articleTitle: r.article_title,
      attemptNumber: r.attempt_number,
      answers: JSON.parse(r.answers),
      similarityFlagged: r.similarity_flag === 1,
      similarityScore: r.similarity_score,
      submittedAt: r.submitted_at,
      alreadyReviewed: r.reviewed_by !== null,
    })),
  });
}

/** POST /api/admin/review/:attemptId
 * body: { bonusXp?: number, note?: string }
 * Bonus XP is awarded once per TASK (not per attempt) — guarded by
 * task_progress.review_bonus_awarded — so a teacher reviewing several
 * retries from the same pupil can't accidentally pay out multiple bonuses. */
export async function submitReview(request: Request, env: Env, attemptId: number): Promise<Response> {
  const session = await requireTeacher(request, env);
  const { bonusXp, note } = await request.json<{ bonusXp?: number; note?: string }>();

  const attempt = await queryFirst<{ student_id: number; task_id: number }>(
    env,
    "SELECT student_id, task_id FROM attempts WHERE id = ?",
    attemptId
  );
  if (!attempt) throw new HttpError(404, "Attempt not found");

  await execute(
    env,
    "UPDATE attempts SET reviewed_by = ?, review_note = ? WHERE id = ?",
    session.teacherId,
    note ?? null,
    attemptId
  );

  if (bonusXp && bonusXp > 0) {
    const progress = await queryFirst<{ review_bonus_awarded: number }>(
      env,
      "SELECT review_bonus_awarded FROM task_progress WHERE student_id = ? AND task_id = ?",
      attempt.student_id,
      attempt.task_id
    );
    if (progress && progress.review_bonus_awarded === 1) {
      throw new HttpError(409, "A review bonus has already been awarded for this task");
    }
    const clamped = Math.min(bonusXp, XP_VALUES.REFLECT_REVIEW_BONUS_MAX);
    await awardXp(env, attempt.student_id, clamped, "reflect_review_bonus", true);
    await execute(
      env,
      "UPDATE task_progress SET review_bonus_awarded = 1 WHERE student_id = ? AND task_id = ?",
      attempt.student_id,
      attempt.task_id
    );
  }

  return Response.json({ ok: true });
}
