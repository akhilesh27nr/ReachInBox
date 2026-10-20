# ReachInbox API Reference

Base URL: `http://localhost:3000/api`

All protected routes require an active session cookie (`reachinbox_session`) or `Authorization: Bearer <sessionToken>`. Unauthenticated requests return `401 Unauthorized` with the standardized error response schema.

---

## Standardized API Contracts

### Paginated Response Envelope (`PaginatedResponse<T>`)
All list and search endpoints (`/api/emails/scheduled`, `/api/emails/sent`, `/api/emails/search`, `/api/events`, `/api/slack/notifications`) return:
```json
{
  "items": [],
  "data": [],
  "page": 1,
  "size": 20,
  "pageSize": 20,
  "totalItems": 142,
  "total": 142,
  "totalPages": 8,
  "hasNext": true
}
```
- `page`: 1-indexed integer (`>= 1`). Invalid values return `400 Bad Request` (`INVALID_PAGINATION`).
- `size` (or `pageSize`): Integer in `1..100`. Requests exceeding `100` return `400 Bad Request` (`INVALID_PAGINATION`).
- `sortBy`: Validated sort column (`scheduledAt`, `sentAt`, `createdAt`, `toEmail`, `subject`, `status`). Invalid keys return `400 Bad Request` (`INVALID_SORT_KEY`).
- `sortOrder`: `asc` or `desc`. Invalid directions return `400 Bad Request` (`INVALID_SORT_ORDER`).

### Standardized Error Envelope (`ApiErrorResponse`)
All 4xx/5xx responses return a safe JSON envelope without stack traces or secrets:
```json
{
  "code": "INVALID_PAGINATION",
  "error": "size must be an integer between 1 and 100.",
  "details": {
    "size": "500"
  },
  "timestamp": "2026-10-20T13:55:00.000Z"
}
```

---

## 1. Authentication & Google OAuth 2.0 / OIDC

### Start Google OAuth 2.0 Login
`GET /auth/google` (or `GET /api/auth/google`)
- Generates an HMAC-SHA256 signed `state` token persisted in `oauth_states` for single-use replay protection, sets `reachinbox_oauth_state` (`HttpOnly` cookie), and redirects (`302`) to Google OAuth 2.0.
- Returns `503 Service Unavailable` (`OAUTH_NOT_CONFIGURED`) if `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are not configured.

### Google OAuth Callback
`GET /auth/google/callback` (or `GET /api/auth/google/callback`)
- Validates and atomically consumes the `state` token (`400` on mismatch or replay), exchanges `code`, verifies OIDC ID token claims (`iss`, `aud`, `exp`, `email_verified`), upserts user in PostgreSQL by `googleId`, creates a persistent session in `sessions`, sets `reachinbox_session`, and redirects to `/`.

### Current Authenticated User
`GET /api/me`
- Returns the authenticated user profile, active session metadata, and real Slack integration status (`connected: boolean`, `teamName`, `channelName`). Never returns hardcoded demo profiles when unauthenticated (`401 UNAUTHENTICATED`).

### Logout & Revoke Session
`POST /api/auth/logout`
- Deletes the active session from `sessions`, sets `reachinbox_signed_out=1`, and clears session cookies.

---

## 2. Slack OAuth 2.0 & Operational Alerts

### Start Slack OAuth Flow
`GET /auth/slack` or `GET /api/slack/oauth/start`
- Requires authentication. Generates an HMAC-signed `state` bound to `userId` (`purpose = 'slack_oauth'`), persists it in `oauth_states`, sets `reachinbox_slack_oauth_state` (`HttpOnly` cookie), and redirects (`302`) to `https://slack.com/oauth/v2/authorize` requesting `chat:write` and `incoming-webhook`.

### Slack OAuth Callback
`GET /auth/slack/callback` or `GET /api/slack/oauth/callback`
- Verifies and consumes single-use `state` token (`400` on replay or mismatch), exchanges `code` via Slack `oauth.v2.access`, encrypts `botToken` and `webhookUrl` using AES-256-GCM (`src/lib/crypto.ts`), and persists to `slack_integrations` keyed by `userId`.

### Slack Connection Status & Channel Configuration
- `GET /api/slack/status` — Returns real connection state (`connected`, `teamId`, `teamName`, `channelId`, `channelName`, `alertsEnabled`, `notificationStats`) with all tokens redacted.
- `PATCH /api/slack/config` — Updates `channelId`, `channelName`, or `alertsEnabled` for the authenticated user's Slack integration.
- `POST /api/slack/test` — Sends a real test alert to Slack only when genuinely connected (`400 SLACK_NOT_CONNECTED` if disconnected; `502 SLACK_DELIVERY_FAILED` if Slack rejects delivery).
- `POST /api/slack/disconnect` — Deletes the user's `slack_integrations` record.
- `GET /api/slack/notifications?page=1&size=20` — Paginated audit log of `slack_notifications` (`dedupeKey`, `eventType`, `status`, `attemptCount`, `lastError`, `deliveredAt`).

### How to Verify Slack Alerts in a Real Slack Test Workspace
1. Configure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_REDIRECT_URI=http://localhost:3000/auth/slack/callback` in `.env`.
2. Sign in to ReachInbox, click the Slack badge in the header, and click **Connect Slack OAuth** to authorize your test workspace.
3. Click **Send Test Alert** in the Slack modal and confirm the message appears in your selected Slack channel and in `GET /api/slack/notifications` with `status: "SENT"`.
4. Schedule a campaign that exceeds a sender's `hourlyLimit` and confirm a single deduplicated `HOURLY_LIMIT_THROTTLE` alert is posted per `(userId, senderId, windowIndex)`.

---

## 3. Compose, RFC-4180 CSV Validation & Campaign Scheduling

### Validate & Parse CSV Recipients
`POST /api/campaigns/parse-csv`
- Parses CSV content (`csvContent` up to 5 MB) in full compliance with RFC 4180:
  - Strips UTF-8 BOM (`\uFEFF`)
  - Detects email column headers (`email`, `e-mail`, `recipient`, `to`, `lead`, `contact`)
  - Handles quoted fields containing commas and embedded newlines (`""` escaped quotes)
  - Reports `accepted` (valid unique emails), `duplicates`, `invalidEmails` (with row numbers), `malformedRows` (unclosed quotes), and `emptyRowsSkipped`.

### Schedule Campaign (Transactional Outbox + BullMQ)
`POST /api/campaigns/schedule`
- Validates `subject`, `body`, `leads` (`1..10,000`), `startAt` (ISO-8601), `delayBetweenMs` (`0..3,600,000`), and `hourlyLimit` (`1..10,000`).
- Supports `Idempotency-Key` header or `idempotencyKey` body field (`200 OK` on replay without duplicate records).
- Atomically writes `campaigns`, `emails`, and `outbox_jobs` (`CAMPAIGN_ENQUEUE` + `SEARCH_INDEX`) inside a database transaction, then enqueues delayed BullMQ jobs using atomic Lua rate-limit slot reservation (`reserveSlot.lua`).

---

## 4. Emails, Elasticsearch Search, Attempts, Cancel & Retry (Strictly User-Scoped)

- `GET /api/emails/scheduled?page=1&size=20&sortBy=scheduledAt&sortOrder=asc&q=` — Paginated `SCHEDULED` and `PROCESSING` emails owned by `req.user.id`.
- `GET /api/emails/sent?page=1&size=20&status=SENT&sortBy=sentAt&sortOrder=desc&q=` — Paginated `SENT`, `FAILED`, and `CANCELLED` emails owned by `req.user.id`.
- `GET /api/emails/search?q=stripe&status=SENT&senderId=...&campaignId=...&page=1&size=20` — Validated user-scoped search via Elasticsearch (`reachinbox_emails` index) with observable relational fallback (`engine: "elasticsearch" | "database-fallback"`, `degraded: boolean`, `outboxStats`).
- `POST /api/search/reindex` — Reconciles pending `SEARCH_INDEX` outbox jobs and backfills all user emails into Elasticsearch.
- `GET /api/emails/:id` — Returns full email details and campaign settings (`404` if not owned by user; `400` if invalid ID).
- `GET /api/emails/:id/attempts` — Returns the email metadata and `send_attempts` delivery history (`404` if not owned by user).
- `POST /api/emails/:id/cancel` — Atomically transitions a `SCHEDULED` email to `CANCELLED` (`409` if already `PROCESSING`/`SENT`, `404` if not owned by user) and removes the BullMQ job.
- `POST /api/emails/:id/retry` — Resets a `FAILED` or `CANCELLED` email owned by the user to `SCHEDULED` and re-enqueues it in BullMQ.
- `POST /api/emails/batch-retry` — Batch re-enqueues up to 500 `emailIds` owned by the user.

---

## 5. Operational Dashboard, Liveness & Readiness Probes

- `GET /healthz` and `GET /api/health` — Liveness probe returning `200 OK`, uptime, database engine, queue mode, and worker liveness without credentials.
- `GET /readyz` and `GET /api/ready` — Readiness probe checking PostgreSQL, Redis/BullMQ, worker status, and Elasticsearch (`?strict=true` or `STRICT_INFRASTRUCTURE=true` returns `503 Service Unavailable` when any required dependency is down or degraded).
- `GET /admin/queues` — Bull Board UI inspecting the live BullMQ `email-delivery-queue`. Protected by HTTP Basic Auth (`BULL_BOARD_USER` / `BULL_BOARD_PASS`, timing-safe comparison) or an authenticated admin session (`401` if unauthenticated, `403` if non-admin role). Job payloads redact `body` and sensitive tokens.
