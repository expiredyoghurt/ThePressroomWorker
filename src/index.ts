import type { Env } from "./types";
import { HttpError } from "./middleware/tenancy";
import { pupilLogin, teacherLogin, parentLogin } from "./routes/auth";
import { getTask } from "./routes/tasks";
import { submitMcqTask } from "./routes/submit";
import { checkReflectSimilarity, submitReflectTask } from "./routes/reflect";
import { getRankings } from "./routes/rankings";
import { listArticles, getWall } from "./routes/articles";
import { getParentClassView } from "./routes/parent";
import {
  addPupil,
  removePupil,
  importRoster,
  resetPupilPassword,
  changePupilClass,
  getImportPrompt,
  importArticleJson,
  publishArticle,
  getClasses,
  getRoster,
  updateClassSettings,
} from "./routes/admin";
import { getReviewQueue, submitReview } from "./routes/review";
import { uploadThumbnail, serveThumbnail } from "./routes/media";
import {
  listGoatPicks,
  getGoatPickDetail,
  addGoatPick,
  updateGoatPick,
  removeGoatPick,
  listGoatPicksForClass,
} from "./routes/goat";

const JSON_HEADERS = { "content-type": "application/json" };

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*"); // TODO: restrict to the deployed pupil/teacher/parent app origins
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

/** Matches "/api/tasks/123/submit" style paths and pulls out the numeric id. */
function matchNumericSegment(pattern: RegExp, pathname: string): number | null {
  const m = pathname.match(pattern);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // ---- Auth ----
      if (method === "POST" && pathname === "/api/auth/pupil/login") {
        return withCors(await pupilLogin(request, env));
      }
      if (method === "POST" && pathname === "/api/auth/teacher/login") {
        return withCors(await teacherLogin(request, env));
      }
      if (method === "POST" && pathname === "/api/auth/parent/login") {
        return withCors(await parentLogin(request, env));
      }

      // ---- Tasks (pupil) ----
      const taskGetId = method === "GET" ? matchNumericSegment(/^\/api\/tasks\/(\d+)$/, pathname) : null;
      if (taskGetId !== null) {
        return withCors(await getTask(request, env, taskGetId));
      }

      const taskSubmitId =
        method === "POST" ? matchNumericSegment(/^\/api\/tasks\/(\d+)\/submit$/, pathname) : null;
      if (taskSubmitId !== null) {
        return withCors(await submitMcqTask(request, env, taskSubmitId));
      }

      const reflectCheckId =
        method === "POST" ? matchNumericSegment(/^\/api\/tasks\/(\d+)\/reflect\/check$/, pathname) : null;
      if (reflectCheckId !== null) {
        return withCors(await checkReflectSimilarity(request, env, reflectCheckId));
      }

      const reflectSubmitId =
        method === "POST" ? matchNumericSegment(/^\/api\/tasks\/(\d+)\/reflect\/submit$/, pathname) : null;
      if (reflectSubmitId !== null) {
        return withCors(await submitReflectTask(request, env, reflectSubmitId));
      }

      // ---- Pupil: article list + published wall ----
      if (method === "GET" && pathname === "/api/articles") {
        return withCors(await listArticles(request, env));
      }
      if (method === "GET" && pathname === "/api/wall") {
        return withCors(await getWall(request, env));
      }

      // ---- Rankings / parent view ----
      if (method === "GET" && pathname === "/api/rankings") {
        return withCors(await getRankings(request, env));
      }
      if (method === "GET" && pathname === "/api/parent/class") {
        return withCors(await getParentClassView(request, env));
      }

      // ---- Admin: roster ----
      // ---- Admin: classes / roster ----
      if (method === "GET" && pathname === "/api/admin/classes") {
        return withCors(await getClasses(request, env));
      }
      if (method === "GET" && pathname === "/api/admin/roster") {
        return withCors(await getRoster(request, env));
      }
      const classSettingsId =
        method === "PATCH" ? matchNumericSegment(/^\/api\/admin\/classes\/(\d+)\/settings$/, pathname) : null;
      if (classSettingsId !== null) {
        return withCors(await updateClassSettings(request, env, classSettingsId));
      }
      if (method === "POST" && pathname === "/api/admin/roster/add") {
        return withCors(await addPupil(request, env));
      }
      if (method === "POST" && pathname === "/api/admin/roster/remove") {
        return withCors(await removePupil(request, env));
      }
      if (method === "POST" && pathname === "/api/admin/roster/import") {
        return withCors(await importRoster(request, env));
      }
      if (method === "POST" && pathname === "/api/admin/roster/reset-password") {
        return withCors(await resetPupilPassword(request, env));
      }
      if (method === "POST" && pathname === "/api/admin/roster/change-class") {
        return withCors(await changePupilClass(request, env));
      }

      // ---- Admin: content ("Breaking News" tab) ----
      if (method === "GET" && pathname === "/api/admin/import-prompt") {
        return withCors(await getImportPrompt(request, env));
      }
      if (method === "POST" && pathname === "/api/admin/articles/import-json") {
        return withCors(await importArticleJson(request, env));
      }
      const publishArticleId =
        method === "POST" ? matchNumericSegment(/^\/api\/admin\/articles\/(\d+)\/publish$/, pathname) : null;
      if (publishArticleId !== null) {
        return withCors(await publishArticle(request, env, publishArticleId));
      }
      const thumbnailUploadId =
        method === "POST" ? matchNumericSegment(/^\/api\/admin\/articles\/(\d+)\/thumbnail$/, pathname) : null;
      if (thumbnailUploadId !== null) {
        return withCors(await uploadThumbnail(request, env, thumbnailUploadId));
      }

      // ---- Media (thumbnail serving — any authenticated session kind) ----
      const thumbnailGetId = method === "GET" ? matchNumericSegment(/^\/api\/thumbnail\/(\d+)$/, pathname) : null;
      if (thumbnailGetId !== null) {
        return withCors(await serveThumbnail(request, env, thumbnailGetId));
      }

      // ---- Admin: review queue ----
      if (method === "GET" && pathname === "/api/admin/review-queue") {
        return withCors(await getReviewQueue(request, env));
      }
      const reviewAttemptId =
        method === "POST" ? matchNumericSegment(/^\/api\/admin\/review\/(\d+)$/, pathname) : null;
      if (reviewAttemptId !== null) {
        return withCors(await submitReview(request, env, reviewAttemptId));
      }

      // ---- GOAT list (pupil-facing) ----
      if (method === "GET" && pathname === "/api/goat") {
        return withCors(await listGoatPicks(request, env));
      }
      const goatDetailId = method === "GET" ? matchNumericSegment(/^\/api\/goat\/(\d+)$/, pathname) : null;
      if (goatDetailId !== null) {
        return withCors(await getGoatPickDetail(request, env, goatDetailId));
      }

      // ---- GOAT list (teacher/admin curation) ----
      if (method === "GET" && pathname === "/api/admin/goat") {
        return withCors(await listGoatPicksForClass(request, env));
      }
      if (method === "POST" && pathname === "/api/admin/goat") {
        return withCors(await addGoatPick(request, env));
      }
      const goatUpdateId = method === "PATCH" ? matchNumericSegment(/^\/api\/admin\/goat\/(\d+)$/, pathname) : null;
      if (goatUpdateId !== null) {
        return withCors(await updateGoatPick(request, env, goatUpdateId));
      }
      const goatDeleteId = method === "DELETE" ? matchNumericSegment(/^\/api\/admin\/goat\/(\d+)$/, pathname) : null;
      if (goatDeleteId !== null) {
        return withCors(await removeGoatPick(request, env, goatDeleteId));
      }

      return withCors(Response.json({ error: "Not found" }, { status: 404 }));
    } catch (err) {
      if (err instanceof HttpError) {
        return withCors(Response.json({ error: err.message }, { status: err.status, headers: JSON_HEADERS }));
      }
      console.error(err);
      return withCors(Response.json({ error: "Internal error" }, { status: 500, headers: JSON_HEADERS }));
    }
  },
};
