import type { Env } from "../types";
import { queryAll } from "../lib/db";
import { requirePupil } from "../middleware/tenancy";

interface ArticleWithTasksRow {
  article_id: number;
  title: string;
  section: string | null;
  publish_date: string;
  task_id: number;
  task_type: "comprehension" | "vocabulary" | "reflect";
  passed: number | null;
  attempts_count: number | null;
}

/** GET /api/articles
 * Everything the pressroom hub needs to render its 4 zones with per-task
 * completion counters: every active article, each of its 3 tasks, and this
 * pupil's task_progress for each (if any — LEFT JOIN, so an untouched task
 * just comes back with passed=null). */
export async function listArticles(request: Request, env: Env): Promise<Response> {
  const session = await requirePupil(request, env);

  const rows = await queryAll<ArticleWithTasksRow>(
    env,
    `SELECT
        art.id as article_id, art.title, art.section, art.publish_date,
        t.id as task_id, t.type as task_type,
        tp.passed, tp.attempts_count
     FROM articles art
     JOIN tasks t ON t.article_id = art.id
     LEFT JOIN task_progress tp ON tp.task_id = t.id AND tp.student_id = ?
     WHERE art.status = 'active'
     ORDER BY art.publish_date DESC, art.id, t.type`,
    session.studentId
  );

  const byArticle = new Map<
    number,
    {
      articleId: number;
      title: string;
      section: string | null;
      publishDate: string;
      tasks: Record<string, { taskId: number; passed: boolean; attemptsCount: number }>;
    }
  >();

  for (const r of rows) {
    if (!byArticle.has(r.article_id)) {
      byArticle.set(r.article_id, {
        articleId: r.article_id,
        title: r.title,
        section: r.section,
        publishDate: r.publish_date,
        tasks: {},
      });
    }
    byArticle.get(r.article_id)!.tasks[r.task_type] = {
      taskId: r.task_id,
      passed: r.passed === 1,
      attemptsCount: r.attempts_count ?? 0,
    };
  }

  const articles = [...byArticle.values()].map((a) => ({
    ...a,
    published:
      Object.values(a.tasks).length === 3 && Object.values(a.tasks).every((t) => t.passed),
  }));

  return Response.json({ articles });
}

interface WallRow {
  article_id: number;
  title: string;
  awarded_at: string;
}

/** GET /api/wall
 * The pupil's own Published Articles pin-board — one entry per badge. Each
 * badge's image is resolved live via GET /api/thumbnail/:articleId (see
 * ThumbnailImage.tsx on the frontend), not stored on the badge itself. */
export async function getWall(request: Request, env: Env): Promise<Response> {
  const session = await requirePupil(request, env);

  const rows = await queryAll<WallRow>(
    env,
    `SELECT art.id as article_id, art.title, b.awarded_at
     FROM badges b
     JOIN articles art ON art.id = b.article_id
     WHERE b.student_id = ?
     ORDER BY b.awarded_at DESC`,
    session.studentId
  );

  return Response.json({
    badges: rows.map((r) => ({
      articleId: r.article_id,
      title: r.title,
      awardedAt: r.awarded_at,
    })),
  });
}
