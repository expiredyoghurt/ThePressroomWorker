import type {
  Env,
  TaskRow,
  ComprehensionPayload,
  VocabularyPayload,
  TaskProgressRow,
} from "../types";
import { queryFirst, execute } from "../lib/db";
import { requirePupil, HttpError } from "../middleware/tenancy";
import { shuffledIndices, originalPositionOf } from "../lib/shuffle";
import { awardXp } from "../lib/awardXp";
import { checkAndAwardPublish } from "../lib/publish";
import { XP_VALUES } from "../lib/xp";

function seedKey(studentId: number, taskId: number, attemptNumber: number) {
  return `seed:${studentId}:${taskId}:${attemptNumber}`;
}

async function nextAttemptNumber(env: Env, studentId: number, taskId: number): Promise<number> {
  const row = await queryFirst<{ n: number }>(
    env,
    "SELECT COUNT(*) as n FROM attempts WHERE student_id = ? AND task_id = ?",
    studentId,
    taskId
  );
  return (row?.n ?? 0) + 1;
}

interface McqAnswer {
  selectedIndex: number; // position in the SHUFFLED options array the pupil clicked
  chunkId?: string; // comprehension only — which text chunk the pupil clicked as evidence
}
type McqSubmission = Record<string, McqAnswer>; // keyed by question id

/** POST /api/tasks/:taskId/submit
 * body: { answers: { [questionId]: { selectedIndex, chunkId? } } }
 *
 * For comprehension, a question only counts correct if BOTH the chunk AND the
 * option are right — matches the "must click evidence AND pick the answer"
 * requirement in the scope. */
export async function submitMcqTask(
  request: Request,
  env: Env,
  taskId: number
): Promise<Response> {
  const session = await requirePupil(request, env);
  const { answers } = await request.json<{ answers: McqSubmission }>();

  const task = await queryFirst<TaskRow>(env, "SELECT * FROM tasks WHERE id = ?", taskId);
  if (!task) throw new HttpError(404, "Task not found");
  if (task.type !== "comprehension" && task.type !== "vocabulary") {
    throw new HttpError(400, "Use /reflect endpoints for reflect tasks");
  }

  const attemptNumber = await nextAttemptNumber(env, session.studentId, task.id);
  const seed = await env.SHUFFLE_SEEDS.get(seedKey(session.studentId, task.id, attemptNumber));
  if (!seed) {
    throw new HttpError(
      410,
      "This attempt has expired (30 min limit) — reload the task to get a fresh set of questions."
    );
  }

  let correctCount = 0;
  let total = 0;
  const perQuestionResult: Record<string, { correct: boolean; correctOptionText: string }> = {};

  if (task.type === "comprehension") {
    const payload: ComprehensionPayload = JSON.parse(task.payload);
    total = payload.questions.length;
    for (const q of payload.questions) {
      const optOrder = shuffledIndices(q.options.length, seed, `options:${q.id}`);
      const submitted = answers[q.id];
      const optionCorrect =
        submitted !== undefined &&
        originalPositionOf(submitted.selectedIndex, optOrder) === q.correct_index;
      const chunkCorrect = submitted?.chunkId === q.evidence_chunk_id;
      const isCorrect = optionCorrect && chunkCorrect;
      if (isCorrect) correctCount++;
      perQuestionResult[q.id] = { correct: isCorrect, correctOptionText: q.options[q.correct_index] };
    }
  } else {
    const payload: VocabularyPayload = JSON.parse(task.payload);
    total = payload.questions.length;
    for (const q of payload.questions) {
      const optOrder = shuffledIndices(q.options.length, seed, `options:${q.id}`);
      const submitted = answers[q.id];
      const isCorrect =
        submitted !== undefined &&
        originalPositionOf(submitted.selectedIndex, optOrder) === q.correct_index;
      if (isCorrect) correctCount++;
      perQuestionResult[q.id] = {
        correct: isCorrect,
        correctOptionText: q.options[q.correct_index].text,
      };
    }
  }

  const score = total === 0 ? 0 : correctCount / total;

  const existing = await queryFirst<TaskProgressRow>(
    env,
    "SELECT * FROM task_progress WHERE student_id = ? AND task_id = ?",
    session.studentId,
    task.id
  );

  const newBestScore = existing ? Math.max(existing.best_score ?? 0, score) : score;
  const passed = newBestScore >= task.pass_threshold ? 1 : 0;

  await execute(
    env,
    `INSERT INTO attempts (student_id, task_id, attempt_number, shuffle_seed, answers, score)
     VALUES (?, ?, ?, ?, ?, ?)`,
    session.studentId,
    task.id,
    attemptNumber,
    seed,
    JSON.stringify(answers),
    score
  );

  if (!existing) {
    await execute(
      env,
      `INSERT INTO task_progress
         (student_id, task_id, attempts_count, first_attempt_score, best_score, passed, xp_awarded)
       VALUES (?, ?, 1, ?, ?, ?, 0)`,
      session.studentId,
      task.id,
      score,
      newBestScore,
      passed
    );
  } else {
    await execute(
      env,
      `UPDATE task_progress
         SET attempts_count = attempts_count + 1, best_score = ?, passed = ?, updated_at = CURRENT_TIMESTAMP
       WHERE student_id = ? AND task_id = ?`,
      newBestScore,
      passed,
      session.studentId,
      task.id
    );
  }

  // XP only ever pays out on attempt_number === 1, guarded by xp_awarded so a
  // retry (or a double-submit race) can never double-pay.
  let leveledUp = false;
  if (attemptNumber === 1) {
    const perCorrect =
      task.type === "comprehension" ? XP_VALUES.COMPREHENSION_CORRECT : XP_VALUES.VOCABULARY_CORRECT;
    const delta = correctCount * perCorrect;
    if (delta > 0) {
      const result = await awardXp(env, session.studentId, delta, `${task.type}_first_attempt`, true);
      leveledUp = result.leveledUp;
    }
    await execute(
      env,
      "UPDATE task_progress SET xp_awarded = 1 WHERE student_id = ? AND task_id = ?",
      session.studentId,
      task.id
    );
  }

  const { newlyPublished } = await checkAndAwardPublish(env, session.studentId, task.article_id);

  await env.SHUFFLE_SEEDS.delete(seedKey(session.studentId, task.id, attemptNumber));

  return Response.json({
    score,
    correctCount,
    total,
    passed: passed === 1,
    passThreshold: task.pass_threshold,
    perQuestionResult,
    xpAwardedThisAttempt: attemptNumber === 1,
    leveledUp,
    newlyPublished,
  });
}
