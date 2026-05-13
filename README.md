# githost

Local "GitHub clone" that mirrors an upstream repo:
- Receives GitHub App webhooks → mirrors PRs / issues / comments / labels into D1.
- Manual + scheduled re-sync repairs drift.
- Local-only AI reviews (you choose what to post upstream).
- Custom views, local labels, saved filters — none of which spam upstream.
- Create branches in the upstream repo from the UI.

Single Cloudflare Worker with Static Assets serves both the React SPA (`web/`)
and the API (`src/`). Designed for the **Workers Free plan** — no Queues, no R2,
no payment method required.

## Layout

```
src/                    # Worker source (TypeScript)
  worker.ts             #   entry: fetch + queue + scheduled
  routes/{webhook,api,auth}.ts
  jobs/{consumer,sync-pr,full-resync,ai-review}.ts
  db/{mirror,app}/{schema,index}.ts
  lib/{env,verify-webhook,crypto,github-app}.ts
  scheduled.ts          # cron: nightly resync + nightly D1→R2 backup
migrations/
  mirror/0001_init.sql  # githost-mirror DB (regenerable cache of GitHub state)
  app/0001_init.sql     # githost-app    DB (irreplaceable local data)
web/                    # React + Vite + Tailwind SPA, builds to web/dist
```

## One-time setup

```bash
# 1. install
npm install

# 2. create a GitHub App
#    Settings → Developer settings → GitHub Apps → New GitHub App
#    Permissions: contents (RW), pull_requests (RW), issues (RW), metadata (R)
#    Subscribe to events: pull_request, pull_request_review,
#                         pull_request_review_comment, issues, issue_comment, push
#    Webhook URL:    https://<your-worker-domain>/webhook/github
#    Webhook secret: <generate a random string — save it>
#    Generate a private key (.pem) and save it.
#    Install the app on your upstream repo (or your fork of it).

# 3. create Cloudflare resources
npx wrangler login
npx wrangler d1 create githost-mirror      # copy database_id into wrangler.toml
npx wrangler d1 create githost-app         # copy database_id into wrangler.toml
npx wrangler kv namespace create DIFF_CACHE  # copy id into wrangler.toml
#    NOTE: Cloudflare Queues require the Workers Paid plan. On the Free plan we
#    use `ctx.waitUntil()` for async work instead — no extra resources to create.
#    Backups are handled by a GitHub Actions workflow (see CI section below),
#    not by the Worker — so no R2 bucket is required either.

# 4. apply migrations (locally and to production)
npm run db:apply:local
npm run db:apply:remote

# 5. secrets (prod)
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste full PEM
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET           # 32 random bytes, base64
npx wrangler secret put TOKEN_ENCRYPTION_KEY     # 32 random bytes, base64

# 6. set non-secret vars (or edit [vars] in wrangler.toml directly)
#    UPSTREAM_OWNER, UPSTREAM_REPO

# 7. dev or deploy
cp .dev.vars.example .dev.vars                    # then edit
npm run dev                                       # Vite (5173) + wrangler dev (8787)
npm run deploy                                    # build + wrangler deploy
```

## Migration workflow

Forward-only, numbered SQL files. Never edit a migration after it's been applied to remote.

```bash
# 1. edit src/db/mirror/schema.ts (or app/schema.ts)
# 2. generate a migration from the schema diff
npm run db:generate:mirror
# 3. inspect migrations/mirror/000N_*.sql, tweak if needed
# 4. apply locally and run the app to sanity-check
npm run db:apply:mirror:local
# 5. apply to prod (after taking a Time Travel bookmark!)
npx wrangler d1 time-travel info githost-mirror   # save the bookmark
npm run db:apply:mirror:remote
```

## Backups & disaster recovery

- **Built-in:** D1 Time Travel gives you 30 days of point-in-time recovery on paid plans (7 days on free).
  ```bash
  npx wrangler d1 time-travel info     githost-app
  npx wrangler d1 time-travel restore  githost-app --timestamp 2026-05-12T22:00:00Z
  ```
- **Offsite (via CI):** a scheduled GitHub Actions workflow runs `wrangler d1 export`
  nightly and uploads SQL dumps as workflow artifacts (90-day retention, free).
  See `.github/workflows/backup.yml` (added in the CI phase).
- **Manual export:** `npm run db:export:mirror` / `npm run db:export:app` (SQL dump to `./backups/`).

## Pre-prod-migration checklist

1. `wrangler d1 time-travel info <db>` → save the bookmark.
2. `wrangler d1 export <db> --remote --output backups/<db>-pre-NNNN.sql`.
3. Apply the migration to a fresh local DB seeded from that dump.
4. Run smoke tests.
5. Apply to remote during low traffic.

## CI/CD (GitHub Actions)

Four workflows live in `.github/workflows/`:

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | every push & PR | typecheck Worker, typecheck + build SPA, `wrangler deploy --dry-run` |
| `deploy.yml` | push to `main`, manual | snapshot D1 Time Travel bookmarks → apply prod migrations → `wrangler deploy` |
| `preview.yml` | PR open / push / reopen | apply staging migrations → `wrangler versions upload --env preview` → sticky PR comment with the preview URL |
| `backup.yml` | nightly at 04:00 UTC, manual | `wrangler d1 export --remote` for both DBs → upload as 90-day workflow artifact |

### Required GitHub repo secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN   # create at https://dash.cloudflare.com/profile/api-tokens
                                     # using the "Edit Cloudflare Workers" template
gh secret set CLOUDFLARE_ACCOUNT_ID --body <your-account-id>
```

### Preview architecture

- Prod Worker: `githost` (this `wrangler.toml`)
- Preview Worker: `githost-preview` (from `[env.preview]`)
- Each gets its own D1 pair + KV namespace. Staging D1s are shared across all
  open PRs — it's test data, not "your fork's branch of prod".
- Preview Worker has **no cron triggers**; webhooks still point at prod.
- Per-PR preview URLs come from `wrangler versions upload --env preview` — each
  PR push generates a new versioned URL, posted as a sticky comment.
- Cloudflare retains the most recent versions automatically; old preview
  versions become unreachable after a few generations (no cleanup needed).

### Rollback playbook

1. Find the bookmark in the failed deploy's Actions summary
   ("Pre-migration Time Travel bookmarks").
2. `npx wrangler d1 time-travel restore githost-mirror --bookmark <id>`
   (and/or the same for `githost-app`).
3. `gh workflow run deploy.yml --ref <previous-good-sha>` to redeploy the prior
   code, OR `npx wrangler rollback` for an instant code-only rollback.

## Where to go from here

- Wire `installation` events to a small `installations` table so multi-repo works.
- Implement `syncIssue` (mirror of `syncPr`).
- Replace the stub in `src/jobs/ai-review.ts` with your LLM of choice.
- Add real session-cookie auth checks to `/api/*` (currently open).
- Add a `saved_view` UI for custom PR filters.
- Optional: stand up a small VM if you ever want real `git` operations
  (push, merge, cherry-pick) — Workers cannot run git binaries.
