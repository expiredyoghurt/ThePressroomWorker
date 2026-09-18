import type { Env, TaskRow, ReflectPayload, TaskProgressRow } from "../types";
import { queryFirst, execute } from "../lib/db";
import { requirePupil, HttpError } from "../middleware/tenancy";
import { highestSimilarity } from "../lib/similarity";
import { getSimilarityThreshold } from "../lib/threshold";
import { awardXp } from "../lib/awardXp";
import { checkAndAwardPublish } from "../lib/publish";
import { XP_VALUES } from "../lib/xp";

async function nextAttemptNumber(env: Env, studentId: number, taskId: number): Promise<number> {
  const row = await queryFirst<{ n: number }>(
    env,
    "SELECT COUNT(*) as n FROM attempts WHERE student_id = ? AND task_id = ?",
    studentId,
    taskId
  );
  return (row?.n ?? 0) + 1;
}

function warnKey(studentId: number, taskId: number, attemptNumber: number) {
  return `similarity_warn:${studentId}:${taskId}:${attemptNumber}`;
}
const WARN_TTL_SECONDS = 60 * 15;

async function loadTask(env: Env, taskId: number): Promise<{ task: TaskRow; payload: ReflectPayload }> {
  const task = await queryFirst<TaskRow>(env, "SELECT * FROM tasks WHERE id = ?", taskId);
  if (!task) throw new HttpError(404, "Task not found");
  if (task.type !== "reflect") throw new HttpError(400, "Not a reflect task");
  return { task, payload: JSON.parse(task.payload) as ReflectPayload };
}

/** POST /api/tasks/:taskId/reflect/check
 * body: { short: string, long: string }
 *
 * Called by the client BEFORE the real submit, while the pupil is drafting a
 * retry. Attempt 1 is never checked — the model answers haven't been shown
 * yet, so there's nothing to have copied. From attempt 2 onward: first time
 * over threshold -> soft block. Still over threshold after the warning ->
 * let it through, but the eventual submit will carry the flag. */
export async function checkReflectSimilarity(
  request: Request,
  env: Env,
  taskId: number
): Promise<Response> {
  const session = await requirePupil(request, env);
  const { short, long } = await request.json<{ short: string; long: string }>();
  const { payload } = await loadTask(env, taskId);

  const attemptNumber = await nextAttemptNumber(env, session.studentId, taskId);
  if (attemptNumber === 1) {
    return Response.json({ blocked: false, flagged: false });
  }

  const threshold = await getSimilarityThreshold(env, session.classId);
  const candidate = `${short}\n${long}`;
  const { score, method } = await highestSimilarity(env, candidate, payload.model_answers);

  if (score <= threshold) {
    return Response.json({ blocked: false, flagged: false, score, method });
  }

  const key = warnKey(session.studentId, taskId, attemptNumber);
  const alreadyWarned = await env.SHUFFLE_SEEDS.get(key);

  if (!alreadyWarned) {
    await env.SHUFFLE_SEEDS.put(key, "1", { expirationTtl: WARN_TTL_SECONDS });
    return Response.json({
      blocked: true,
      score,
      method,
      message: "This looks very close to one of the sample answers — try putting it in your own words.",
    });
  }

  // Warned once already this attempt and still similar — let it through, flagged.
  return Response.json({ blocked: false, flagged: true, score, method });
}

/** POST /api/tasks/:taskId/reflect/submit
 * body: { short: string, long: string }
 *
 * Re-derives flagged/warned status from KV server-side rather than trusting
 * anything the client claims — the /check call above is what a well-behaved
 * client uses to decide whether to let the pupil submit, but this endpoint
 * doesn't rely on that having happened correctly. */
export async function submitReflectTask(
  request: Request,
  env: Env,
  taskId: number
): Promise<Response> {
  const session = await requirePupil(request, env);
  const { short, long } = await request.json<{ short: string; long: string }>();
  const { task, payload } = await loadTask(env, taskId);

  const attemptNumber = await nextAttemptNumber(env, session.studentId, taskId);

  let similarityFlag = 0;
  let similarityScore: number | null = null;
  let warnedBeforeSubmit = 0;

  if (attemptNumber > 1) {
    const threshold = await getSimilarityThreshold(env, session.classId);
    const candidate = `${short}\n${long}`;
    const { score } = await highestSimilarity(env, candidate, payload.model_answers);
    similarityScore = score;
    if (score > threshold) {
      similarityFlag = 1;
      const key = warnKey(session.studentId, taskId, attemptNumber);
      warnedBeforeSubmit = (await env.SHUFFLE_SEEDS.get(key)) ? 1 : 0;
      await env.SHUFFLE_SEEDS.delete(key);
    }
  }

  await execute(
    env,
    `INSERT INTO attempts
       (student_id, task_id, attempt_number, answers, similarity_flag, similarity_score, warned_before_submit)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    session.studentId,
    task.id,
    attemptNumber,
    JSON.stringify({ short, long }),
    similarityFlag,
    similarityScore,
    warnedBeforeSubmit
  );

  const existing = await queryFirst<TaskProgressRow>(
    env,
    "SELECT * FROM task_progress WHERE student_id = ? AND task_id = ?",
    session.studentId,
    task.id
  );

  if (!existing) {
    // Reflect "passes" on submission — there's no objectively correct opinion
    // to score against a percentage threshold.
    await execute(
      env,
      `INSERT INTO task_progress (student_id, task_id, attempts_count, passed, xp_awarded)
       VALUES (?, ?, 1, 1, 0)`,
      session.studentId,
      task.id
    );
  } else {
    await execute(
      env,
      `UPDATE task_progress SET attempts_count = attempts_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE student_id = ? AND task_id = ?`,
      session.studentId,
      task.id
    );
  }

  let leveledUp = false;
  if (attemptNumber === 1) {
    const result = await awardXp(
      env,
      session.studentId,
      XP_VALUES.REFLECT_SUBMISSION,
      "reflect_first_attempt",
      true
    );
    leveledUp = result.leveledUp;
    await execute(
      env,
      "UPDATE task_progress SET xp_awarded = 1 WHERE student_id = ? AND task_id = ?",
      session.studentId,
      task.id
    );
  }

  const { newlyPublished } = await checkAndAwardPublish(env, session.studentId, task.article_id);

  return Response.json({
    modelAnswers: payload.model_answers, // revealed now that a submission exists
    similarityFlagged: similarityFlag === 1,
    xpAwardedThisAttempt: attemptNumber === 1,
    leveledUp,
    newlyPublished,
  });
}
