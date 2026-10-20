# ReachInbox Full-Stack Email Job Scheduler

A distributed email job scheduler and campaign outreach system built with **TypeScript, Node.js (Express), PostgreSQL 16 (with explicit LibSQL embedded fallback for container previews), BullMQ on Redis 7 (AOF persistence), Elasticsearch 8.12 (with observable relational fallback and durable outbox retry), and React 19 + Tailwind CSS**.

Designed for multi-sender cold outreach campaigns requiring **atomic multi-worker rate limiting**, **transactional outbox crash recovery**, **multi-tenant session isolation**, and **zero cron dependencies of any kind**.

---

## 1. Prerequisites

- **Node.js**: v22+ and `npm`
- **Docker & Docker Compose**: v24+ (for running PostgreSQL 16, Redis 7 AOF, and Elasticsearch 8.12 locally)
- **Optional External Credentials**:
  - Google Cloud Console OAuth 2.0 Client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
  - Slack App OAuth 2.0 Client (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`)
  - Static Ethereal SMTP credentials (`ETHEREAL_USER`, `ETHEREAL_PASS` — auto-provisioned via `nodemailer.createTestAccount()` if omitted)

---

## 2. Reproducible Setup & Startup Commands

### Option A: Full Containerized Stack via Docker Compose (Recommended for Local Evaluation)

Starts PostgreSQL 16 (`reachinbox-postgres`), Redis 7 with AOF (`reachinbox-redis`), Elasticsearch 8.12 (`reachinbox-elasticsearch`), and the API/Worker service (`reachinbox-app`) with health checks, persistent volumes, and `service_healthy` startup ordering:

```bash
# 1. Copy environment template and set strong secrets (>= 32 chars)
cp .env.example .env

# 2. Start infrastructure daemons (PostgreSQL, Redis, Elasticsearch)
docker compose up -d postgres redis elasticsearch

# 3. Verify container readiness
docker compose ps

# 4. Install dependencies and start the API + BullMQ Worker
npm install
npm run dev
```

Or run the entire stack (including the containerized `app` service) in Docker:

```bash
SESSION_SECRET="prod-session-secret-minimum-32-characters-long" \
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
BULL_BOARD_PASS="StrongAdminPass!2026" \
docker compose up -d --build
```

### Option B: Strict Fail-Fast Mode (No Embedded Fallbacks)

When `STRICT_INFRASTRUCTURE=true` and `ALLOW_EMBEDDED_FALLBACK=false`, the server requires live PostgreSQL and Redis connections and refuses to start with weak/default secrets:

```bash
STRICT_INFRASTRUCTURE=true \
ALLOW_EMBEDDED_FALLBACK=false \
SESSION_SECRET="prod-session-secret-minimum-32-characters-long" \
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
BULL_BOARD_PASS="StrongAdminPass!2026" \
npm run dev
```

---

## 3. Environment Variables Reference (`.env.example`)

All environment variables are validated at startup via Zod in `src/config/env.ts` (`parseConfig()`):

| Variable | Default (Dev) | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `PORT` | `3000` | HTTP server port (`1`–`65535`) |
| `FRONTEND_URL` | `http://localhost:3000` | Base URL for post-OAuth redirects |
| `BACKEND_URL` | `http://localhost:3000` | Base URL for OAuth callback registration |
| `SESSION_SECRET` | *(dev fallback)* | HMAC & session secret (`>= 32` chars required in strict/prod mode) |
| `ENCRYPTION_KEY` | *(dev fallback)* | 32-byte key (`>= 32` chars) for AES-256-GCM encryption of SMTP & Slack tokens |
| `STRICT_INFRASTRUCTURE` | `false` | When `true`, disables all embedded DB/queue fallbacks and enforces strict secrets |
| `ALLOW_EMBEDDED_FALLBACK` | `true` | Allows LibSQL/in-memory fallback when external daemons are absent in sandboxed previews |
| `STRICT_AUTH` | `false` | Disables unauthenticated preview session fallback when `true` |
| `DATABASE_URL` | `postgresql://reachinbox:reachinbox@localhost:5432/reachinbox` | PostgreSQL connection URL (or `file:reachinbox.db` when fallback is enabled) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL for BullMQ and `reserveSlot.lua` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | Elasticsearch node URL |
| `ES_EMAILS_INDEX` | `emails` | Elasticsearch index name for email documents |
| `QUEUE_NAME` | `email-send` | BullMQ queue name |
| `WORKER_CONCURRENCY` | `5` | Number of concurrent BullMQ jobs processed per worker (`1`–`50`) |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | `2000` | Minimum delay in milliseconds between two sends from the same sender |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | Default maximum emails per UTC hour window per sender |
| `RATE_LIMIT_LOOKAHEAD_WINDOWS` | `72` | Maximum future hourly windows scanned by `reserveSlot.lua` (`1`–`168`) |
| `EMAIL_MAX_ATTEMPTS` | `3` | Maximum automatic delivery attempts on transient SMTP errors (`1`–`10`) |
| `STALE_CLAIM_MS` | `120000` | Age (ms) after which a `PROCESSING` claim is considered orphaned and reclaimed |
| `MAX_LEADS_PER_REQUEST` | `5000` | Maximum recipients accepted in a single schedule payload (`1`–`20000`) |
| `ENQUEUE_CHUNK_SIZE` | `500` | Batch chunk size for `queue.addBulk()` |
| `ETHEREAL_HOST` / `ETHEREAL_PORT` | `smtp.ethereal.email` / `587` | Ethereal SMTP host and port |
| `ETHEREAL_USER` / `ETHEREAL_PASS` | *(empty)* | Optional static Ethereal credentials |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(empty)* | Google OAuth 2.0 Client credentials |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/auth/google/callback` | Authorized redirect URI for Google OIDC |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | *(empty)* | Slack OAuth 2.0 App credentials |
| `SLACK_REDIRECT_URI` | `http://localhost:3000/auth/slack/callback` | Authorized redirect URI for Slack OAuth |
| `SLACK_SCOPES` | `incoming-webhook,chat:write` | Requested Slack OAuth scopes |
| `BULL_BOARD_USER` / `BULL_BOARD_PASS` | `admin` / *(dev fallback)* | Basic Auth credentials for `/admin/queues` (`>= 8` chars in strict/prod mode) |

---

## 4. Database Migrations

The SQL schema is stored in `src/db/migrations/001_initial_schema.sql` and defines:
- `users` (keyed by `id` and unique `googleId`)
- `sessions` (server-side revocable sessions with `expiresAt`)
- `oauth_states` (single-use CSRF state tokens for Google and Slack OAuth)
- `senders` (SMTP sender accounts with AES-256-GCM encrypted passwords)
- `slack_integrations` (per-user encrypted Slack bot tokens and webhook URLs)
- `slack_notification_dedupe` (durable relational deduplication per `(userId, senderId, windowKey)`)
- `campaigns` (campaign metadata, `startTime`, `delaySeconds`, `hourlyLimit`)
- `emails` (scheduled/sent/failed/cancelled email records, `processingStartedAt`, `idempotencyKey`, `esIndexedAt`, `esSyncError`)
- `send_attempts` (per-attempt audit log with `outcome`, `smtpResponse`, `messageId`, `errorMessage`)
- `outbox_jobs` (transactional outbox for `CAMPAIGN_ENQUEUE` and `ELASTICSEARCH_INDEX`)
- `email_events` (audit event timeline per email)

When using Docker Compose, PostgreSQL automatically applies `001_initial_schema.sql` via `/docker-entrypoint-initdb.d/`. In addition, `initDb()` in `src/db/db.ts` executes idempotent `CREATE TABLE IF NOT EXISTS` and index creation statements on boot.

---

## 5. External Integrations Setup

### Google OAuth 2.0 / OIDC
1. Open [Google Cloud Console — Credentials](https://console.cloud.google.com/apis/credentials) and create an **OAuth 2.0 Client ID** (Web application).
2. Add Authorized Redirect URI: `http://localhost:3000/auth/google/callback`
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.env`.
4. Clicking **Sign in with Google** in the UI navigates to `/auth/google`, which persists an HMAC-signed `state` token in `oauth_states`, redirects to Google, verifies the callback `state`, exchanges the authorization code, verifies OIDC ID token claims (`iss`, `aud`, `exp`, `email_verified`), upserts the user in `users`, and sets an `HttpOnly` `reachinbox_session` cookie.
5. If credentials are not configured, `/auth/google` returns `503 OAUTH_NOT_CONFIGURED` (or redirects to `/?oauth_error=google_not_configured` when `Accept: text/html`).

### Slack OAuth 2.0 & Deduplicated Rate-Limit Alerts
1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps) and enable **Incoming Webhooks** and **OAuth & Permissions**.
2. Add Redirect URL: `http://localhost:3000/auth/slack/callback` and bot scopes `incoming-webhook,chat:write`.
3. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_REDIRECT_URI` in `.env`.
4. When a sender reaches its hourly ceiling (`limitHit == 1` in `reserveSlot.lua`), `notifyRateLimitHit()` acquires a dual deduplication lock (`SET slacknotif:{senderId}:{windowIndex} 1 NX EX 7200` in Redis + `INSERT INTO slack_notification_dedupe ... ON CONFLICT DO NOTHING` in the database) so **at most one Slack alert** is sent per sender per hour window.

### Ethereal SMTP
- Configure `ETHEREAL_USER` and `ETHEREAL_PASS` in `.env`, or leave them blank to auto-provision 3 Ethereal test accounts (`nodemailer.createTestAccount()`) on first boot.
- Passwords are encrypted at rest using AES-256-GCM (`src/utils/crypto.ts`).
- Check SMTP health via `GET /api/smtp/status` or test a sender via `POST /api/smtp/verify`.
- Every delivered email stores its Ethereal `previewUrl` (`nodemailer.getTestMessageUrl(info)`) so reviewers can inspect the actual MIME message in Ethereal's web mailbox.

### Elasticsearch 8.12 Indexing & Search
- On startup and during email lifecycle transitions (`SCHEDULED`, `PROCESSING`, `RESCHEDULED`, `SENT`, `FAILED`, `CANCELLED`), `indexEmailDocument()` indexes documents into `ES_EMAILS_INDEX` (`emails`) using deterministic `_id = email.id`.
- If Elasticsearch is unreachable during an update, the error is recorded in `emails.esSyncError` and a durable `outbox_jobs` entry (`jobType = 'ELASTICSEARCH_INDEX'`) is persisted for automatic retry during `reconcile()` or manual repair via `POST /api/search/reindex`.
- `GET /api/search` queries Elasticsearch with strict `term: { userId }` tenant filtering and returns `source: "elasticsearch"`. If Elasticsearch is offline, `/api/search` falls back to parameterized SQL search and explicitly returns `source: "database_fallback"` and `esHealthy: false`, while `GET /ready` reports `elasticsearch.healthy = false`.

---

## 6. Operational Dashboard & Health Endpoints

- **Bull Board Queue Admin UI**: `http://localhost:3000/admin/queues`
  - Displays the live Redis-backed BullMQ queue (`email-send`) with `readOnlyMode: true` and redacted job data so recipient PII is never exposed.
  - Protected by constant-time HTTP Basic Auth (`BULL_BOARD_USER` / `BULL_BOARD_PASS`) or an authenticated session cookie. Unauthenticated requests receive `401 Unauthorized`.
  - If Redis is offline, `/admin/queues` returns `503 Service Unavailable` (`QUEUE_REDIS_UNAVAILABLE`) instead of displaying a fake in-memory monitor.
- **Liveness Probe**: `GET /health` -> `200 OK` (`{ status: "ok", uptimeSeconds, timestamp }`)
- **Readiness Probe**: `GET /ready` -> `200 OK` (`status: "ready"`) or `503 Service Unavailable` (`status: "degraded"` / `"not_ready"`) with component diagnostics for `database`, `redis`, `worker`, and `elasticsearch` (zero secrets exposed).

---

## 7. API Endpoints Summary

Full request/response schemas, status codes, and curl examples are documented in [`docs/API.md`](docs/API.md):
- **Health**: `GET /health`, `GET /ready`
- **Auth**: `GET /auth/google`, `GET /auth/google/callback`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/demo-login` (dev/preview only when `STRICT_AUTH=false`)
- **Slack**: `GET /auth/slack`, `GET /auth/slack/callback`, `GET /api/slack/status`, `POST /api/slack/connect`, `POST /api/slack/test`, `POST /api/slack/disconnect`
- **Campaigns & Emails**: `POST /api/campaigns/schedule`, `GET /api/campaigns`, `GET /api/emails/scheduled`, `GET /api/emails/sent`, `GET /api/emails/:id`, `GET /api/emails/:id/attempts`, `POST /api/emails/:id/cancel`, `POST /api/emails/:id/retry`, `POST /api/emails/retry-failed`
- **Search & Reindex**: `GET /api/search`, `POST /api/search/reindex`
- **Operations & Diagnostics**: `GET /api/stats`, `GET /api/senders`, `GET /api/smtp/status`, `POST /api/smtp/verify`, `POST /api/reconcile`

All list and search endpoints return the standardized pagination contract:
```json
{
  "items": [],
  "page": 1,
  "size": 25,
  "totalItems": 120,
  "totalPages": 5,
  "hasNext": true
}
```

---

## 8. Automated Test Suite & 1,200-Email Load Test

```bash
# 1. Static TypeScript verification
npm run lint

# 2. Full automated regression suite (24 test suites across unit, integration, rate-limit, and E2E workflows)
npm test

# 3. Reproducible 1,200-email load, rate-limit, retry & mid-flight crash recovery test
npm run test:load

# 4. Production bundle compilation
npm run build
```

---

## 9. Troubleshooting

- **`/ready` returns `503 Service Unavailable`**: Inspect the JSON body (`components.database`, `components.redis`, `components.worker`, `components.elasticsearch`) to see which dependency is unreachable. Run `docker compose ps` and `docker compose logs <service>`.
- **`/admin/queues` returns `503 QUEUE_REDIS_UNAVAILABLE`**: Ensure Redis is running (`redis-cli ping` -> `PONG`) and `REDIS_URL` is reachable.
- **Documents missing from Elasticsearch search**: Check `GET /ready` (`components.elasticsearch.pendingOutboxCount`) and trigger `POST /api/search/reindex` (or click **Reindex ES** in the dashboard header).
- **Stuck `PROCESSING` emails after an abrupt `SIGKILL` crash**: Wait for automatic boot reconciliation or trigger `POST /api/reconcile` (or click **Sync Outbox** in the dashboard header) to reclaim stale claims older than `STALE_CLAIM_MS`.

---

## 10. Documentation Index

- [`docs/API.md`](docs/API.md) — Complete REST API Reference, Pagination, & Error Contracts
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System Architecture, Data Flows, & Delivery Guarantees
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — Architectural Decision Records (ADRs) & Trade-Offs
- [`docs/ASSIGNMENT_TRACEABILITY.md`](docs/ASSIGNMENT_TRACEABILITY.md) — Strict Assignment Acceptance Audit & Traceability Matrix
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) — Executed Test Evidence & Load Test Benchmarks
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — 5-Minute Live Demo Walkthrough & Final Submission Checklist
