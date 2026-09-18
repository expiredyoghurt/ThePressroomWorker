import type { Env } from "../types";
import { queryFirst, execute } from "../lib/db";
import { requireTeacher, HttpError } from "../middleware/tenancy";
import { readSession, bearerToken } from "../lib/auth";

// Thumbnails are stored directly in D1 as a data URL string
// ("data:<contentType>;base64,<data>") in articles.thumbnail_data_url —
// no R2 bucket needed. One value per article, overwritten on re-upload.
// D1's row size limit is generous (1MB+ per row) relative to the 5MB cap
// below being enforced on the *decoded* bytes (base64 text runs ~33% larger
// again), so this comfortably fits for a downsized newspaper thumbnail;
// it would NOT be an appropriate pattern for large/original-resolution
// images at scale, but is fine for this use case.

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5MB — generous for a downsized newspaper clipping/thumbnail

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** POST /api/admin/articles/:id/thumbnail
 * body: { dataBase64: string, contentType: "image/png" | "image/jpeg" | "image/webp" }
 *
 * Teacher-only. Optional step in the Breaking News flow — since ingestion no
 * longer routes an uploaded photo through this app (it goes straight into
 * whatever external AI tool the teacher uses, per the master prompt design),
 * this is a separate, deliberately optional upload for a nicer badge image
 * than a placeholder. No resizing/compositing happens server-side (no image
 * processing library wired up here) — the raw upload is stored as-is; the
 * "PUBLISHED" ribbon is drawn client-side as a CSS overlay on top of this
 * image, not baked into the stored file. */
export async function uploadThumbnail(request: Request, env: Env, articleId: number): Promise<Response> {
  await requireTeacher(request, env);

  const article = await queryFirst<{ id: number }>(
    env,
    "SELECT id FROM articles WHERE id = ?",
    articleId
  );
  if (!article) throw new HttpError(404, "Article not found");

  const body = await request.json<{ dataBase64: string; contentType: string }>();
  if (!ALLOWED_TYPES.has(body.contentType)) {
    throw new HttpError(400, `contentType must be one of: ${[...ALLOWED_TYPES].join(", ")}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(body.dataBase64);
  } catch {
    throw new HttpError(400, "dataBase64 is not valid base64");
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new HttpError(413, `Image too large — max ${MAX_BYTES / 1024 / 1024}MB`);
  }

  const dataUrl = `data:${body.contentType};base64,${body.dataBase64}`;
  await execute(env, "UPDATE articles SET thumbnail_data_url = ? WHERE id = ?", dataUrl, articleId);

  return Response.json({ ok: true });
}

/** GET /api/thumbnail/:articleId
 * Open to any authenticated session kind (pupil/teacher/parent) — readSession
 * doesn't discriminate by kind, so whichever token is presented is accepted.
 * Thumbnails aren't sensitive, but this still isn't a fully public endpoint,
 * mainly so article images aren't trivially scrapeable by URL guessing from
 * outside the app. Returns 404 if no thumbnail has been uploaded, so the
 * frontend can fall back to a placeholder rather than showing a broken
 * image. Decodes the stored base64 back to bytes here so the response
 * contract (binary image + Content-Type) is unchanged from when this was
 * backed by R2 — ThumbnailImage.tsx on the frontend doesn't need to know
 * the storage moved. */
export async function serveThumbnail(request: Request, env: Env, articleId: number): Promise<Response> {
  const token = bearerToken(request);
  const session = await readSession(env, token);
  if (!session) throw new HttpError(401, "Login required");

  const article = await queryFirst<{ thumbnail_data_url: string | null }>(
    env,
    "SELECT thumbnail_data_url FROM articles WHERE id = ?",
    articleId
  );
  if (!article?.thumbnail_data_url) throw new HttpError(404, "No thumbnail uploaded for this article yet");

  const match = article.thumbnail_data_url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) throw new HttpError(500, "Stored thumbnail is malformed");
  const [, contentType, base64Data] = match;
  const bytes = base64ToBytes(base64Data);

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(bytes, { headers });
}
