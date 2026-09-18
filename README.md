# The Pressroom — Worker

Cloudflare Worker implementing the API described in `Newsroom_Game_Scope.md`.

**Single-school deployment.** This Worker serves one school. It supports
multiple classes and multiple teachers underneath that one school, but there
is no cross-school/tenant concept — no `schools` table, no `school_id`
anywhere. Deploy a separate instance (separate D1 database, separate Worker)
per school.

## Verified working (not just type-checked)

Tested against a real local Cloudflare environment (`wrangler dev --local`,
running actual Miniflare-simulated D1 + KV — the same engine Cloudflare runs
in production, just local), with the seed data applied and real password
hashes generated via the Worker's own `hashPassword()`. Confirmed end-to-end
via raw HTTP:

- Teacher login → real PBKDF2 password verification → session token
- Pupil login → article list with per-task pass/attempt status via a live D1 join
- Comprehension task fetch → confirmed the question AND option order actually
  changes between attempt 1 and attempt 2 (shuffle-per-attempt working correctly)
- Wrong-answer submission → correctly scored 0/4 (chunk-matching requirement enforced)
- Reflect task: attempt 1 submits cleanly and reveals model answers; a near-copy
  retry gets soft-blocked (0.95 token-overlap similarity, no AI binding needed);
  resubmitting the same near-copy text a second time is let through but flagged
- Breaking News import: a deliberately broken bundle is rejected with all
  specific errors named; a valid bundle imports as a draft, publishes, and
  immediately appears in a pupil's article list

`routes/media.ts` (thumbnail upload/serving, added this session) type-checks
clean and follows the same patterns as everything above, but wasn't re-run
through the live `wrangler dev` end-to-end test — worth a quick manual check
before relying on it in production.

## Setup

```bash
npm install
wrangler d1 create the-pressroom-db          # paste the returned id into wrangler.toml
wrangler kv namespace create SESSIONS         # repeat for SHUFFLE_SEEDS and RATE_LIMIT
npm run migrate:local                         # applies migrations/0001 + 0002 to local D1
npm run dev
```

No R2 bucket is needed — thumbnails are stored as base64 data URLs directly
in D1 (see "Thumbnail upload/serving" below).

The seed migration (`0002_seed_demo_data.sql`) creates one default admin
account with a real, working password hash:

- **Username:** `Palpatine`
- **Password:** `Order-66`

**Change this password before any real pupil/parent traffic reaches the
deployment** — it's public in this repo. Log in as Palpatine, then either
add real staff accounts by hand (no in-app "create teacher" UI exists yet —
insert directly via `wrangler d1 execute`) or rotate the password:

```bash
wrangler d1 execute the-pressroom-db --local --command \
  "UPDATE teachers SET password_hash = '<hash from hashPassword()>' WHERE email = 'Palpatine';"
```

Ms Tan's account (`ms.tan@demoprimary.edu.sg`, a plain `teacher`) still has
a placeholder hash — set a real one the same way, or delete the row, before
deploying for real.

## What's implemented

- **Auth** (`routes/auth.ts`) — single-school deployment: pupil (Reporter ID + Press-Pass, reporter ID unique across the whole school), teacher/admin (username-or-email + password), parent (classId + shared password).
- **Article list + wall** (`routes/articles.ts`) — `GET /api/articles` powers the pressroom hub's per-zone counters; `GET /api/wall` lists a pupil's published badges.
- **Task fetch with shuffle** (`routes/tasks.ts`, `lib/shuffle.ts`) — per-attempt seeded shuffle; answer key never reaches the client.
- **Grading** (`routes/submit.ts`) — comprehension requires both the correct option AND the correct evidence chunk; first-attempt-only XP; best-score-across-retries gates the 75% pass threshold.
- **Reflect soft-block flow** (`routes/reflect.ts`, `lib/similarity.ts`) — attempt 1 always goes through; retries checked against the 3 model answers (Workers AI cosine similarity, with a token-overlap fallback), soft-blocked once then let through flagged.
- **XP/leveling** (`lib/xp.ts`, `lib/awardXp.ts`), **publishing/badges** (`lib/publish.ts`), **rankings + parent view** (`lib/classView.ts`, `routes/rankings.ts`, `routes/parent.ts`).
- **"Breaking News" article import** (`routes/admin.ts`, `lib/importPromptTemplate.ts`) — no AI API key lives in this app; teacher pastes a master prompt into any external AI tool, pastes the JSON reply back, gets strict validation, reviews the draft, publishes.
- **Classes/roster admin** (`routes/admin.ts`) — classes/roster listing, rankings + similarity-threshold settings, add/remove/bulk-import/password-reset/reclass.
- **Review queue** (`routes/review.ts`) — flagged reflect submissions surface first; once-per-task bonus XP.
- **Thumbnail upload/serving** (`routes/media.ts`) — `POST /api/admin/articles/:id/thumbnail` lets a teacher optionally upload the newspaper photo they already used with the external AI tool. Stored as a base64 data URL directly in `articles.thumbnail_data_url` (no R2/object storage — no server-side resize/compositing either; the "PUBLISHED" ribbon is a client-side CSS overlay, not baked into the image). `GET /api/thumbnail/:articleId` decodes it back to bytes and serves it to any authenticated session as a blob with the original `Content-Type`; returns 404 if nothing's been uploaded so the frontend can show a placeholder instead of a broken image. The served image is resolved live off `articleId` on every request — badges don't snapshot a thumbnail reference at award time.

## Deliberately NOT implemented yet

- **Article editing UI/endpoint** — a teacher can import and publish a draft, but there's no `PATCH` route to tweak a question's wording before publishing.
- **Rate limiting** — `RATE_LIMIT` KV namespace is bound but unused.
- **Thumbnail resizing/compositing** — uploads are stored at whatever size the teacher provides; no downsizing, no server-side ribbon baking.

## Known limitations to revisit before production

- `lib/awardXp.ts` does a read-then-write across two round-trips rather than one atomic D1 batch (documented inline) — fine at classroom write volume.
- CORS in `index.ts` is wide open (`*`) — narrow to the actual deployed app origins before shipping.
- `similarity.ts` embedding model is a placeholder constant — confirm the exact Workers AI model to bind, or accept the token-overlap fallback (which is what was actually exercised in testing).
- Thumbnails are stored as base64 in a D1 TEXT column (see `routes/media.ts`) rather than object storage. Simple and fine at classroom scale (a handful of downsized images per class), but base64 runs ~33% larger than the original bytes and every row lives in the SQL database itself — this would NOT be the right pattern if this app later needed to store many large/original-resolution images.
- Wrangler 3.114 was used for local testing; 4.x is available.
