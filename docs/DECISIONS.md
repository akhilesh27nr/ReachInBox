# Architecture Decision Records (ADRs) & Trade-Offs

## ADR-001: BullMQ Delayed Jobs + Transactional Outbox (Zero Cron)
- **Status**: Accepted
- **Context**: The assignment strictly forbids cron jobs (`node-cron`, `crontab`, or polling loops) for scheduling emails, while requiring zero lost jobs if Redis or the Node process crashes during campaign creation.
- **Decision**:
  1. Persist `campaigns`, `emails`, and an `outbox_jobs` (`CAMPAIGN_ENQUEUE`) record inside a single database transaction (`db.withTransaction()`).
  2. Enqueue BullMQ delayed jobs (`delay = max(0, scheduledAt - now)`) using deterministic `jobId = email.id` in chunks of `500`.
  3. Run `reconcile()` on startup and on-demand (`POST /api/reconcile`) to replay any uncommitted `outbox_jobs` and re-enqueue any `SCHEDULED` rows missing from Redis.
- **Trade-Offs**: Slightly higher write amplification on campaign creation (one `outbox_jobs` row per campaign), in exchange for guaranteed recovery from mid-enqueue crashes without polling schedulers.

---

## ADR-002: Atomic Redis Lua Script (`reserveSlot.lua`) for Multi-Worker Pacing & Hourly Quotas
- **Status**: Accepted
- **Context**: Enforcing both a minimum inter-email delay (`MIN_DELAY_BETWEEN_EMAILS_MS = 2000ms`) and an hourly per-sender ceiling (`MAX_EMAILS_PER_HOUR_PER_SENDER = 200`) across `WORKER_CONCURRENCY = 5` concurrent workers cannot be done safely with separate `GET` and `INCR` calls.
- **Decision**: Execute `reserveSlot.lua` atomically in Redis via `EVALSHA`. The script inspects `slot:{senderId}` and `rl:{senderId}:{windowIndex}`, looking ahead up to `RATE_LIMIT_LOOKAHEAD_WINDOWS` (`72` hours) relative to `baseWindow = floor(now / 3600000)`. When a sender's current hour window is full, the worker moves the job to the reserved future timestamp via `job.moveToDelayed(slotTs, token)` and throws `DelayedError`.
- **Trade-Offs**: Lookahead is bounded to 72 hours (`RATE_LIMIT_LOOKAHEAD_WINDOWS`) so a single Lua script invocation never blocks Redis for more than a few microseconds. If all 72 future windows are full, `reserveSlot.lua` returns `{-1, 0, -1}` and the worker defers the job by 1 hour.

---

## ADR-003: At-Least-Once SMTP Dispatch + Deterministic `Message-ID` Deduplication
- **Status**: Accepted
- **Context**: Standard SMTP does not support atomic two-phase commit with PostgreSQL. Claiming "strictly exactly-once SMTP delivery" would be architecturally dishonest if a worker process is killed with `SIGKILL` after receiving `250 OK` from the SMTP server but before committing `status = 'SENT'` to the database.
- **Decision**:
  1. Enforce a conditional database claim (`UPDATE emails SET status = 'PROCESSING' ... WHERE id = ? AND (status IN ('SCHEDULED','RESCHEDULED') OR (status = 'PROCESSING' AND processingStartedAt < ?))`) before opening an SMTP transaction.
  2. Set a deterministic RFC 5322 header `Message-ID: <${email.id}@scheduler.local>` on every outgoing email.
  3. Record every attempt in `send_attempts` and classify SMTP errors into `PERMANENT` (`5xx` -> immediate `FAILED`) vs `TRANSIENT` (`4xx`/network -> exponential backoff retry with a fresh rate-limit slot).
  4. On graceful shutdown (`SIGTERM`/`SIGINT`), drain in-flight jobs and release unfinished `PROCESSING` claims back to `SCHEDULED`.
- **Trade-Offs**: Eliminates duplicate sends under normal concurrency, retries, and graceful restarts, while providing downstream MTA deduplication (`Message-ID`) for the sub-millisecond hard-kill crash window.

---

## ADR-004: PostgreSQL 16 Primary Store with Observable Embedded Preview Fallback
- **Status**: Accepted
- **Context**: Production and Docker Compose deployments use PostgreSQL 16 (`pg.Pool`), whereas cloud-hosted sandbox preview containers may not have a local PostgreSQL daemon running on `localhost:5432`.
- **Decision**:
  - Default `DATABASE_URL` to `postgresql://reachinbox:reachinbox@localhost:5432/reachinbox` and implement full `pg.Pool` transactional support (`withTransaction`, `$1..$n` SQL parameter translation, and camelCase column quoting).
  - When `STRICT_INFRASTRUCTURE=true` (or `ALLOW_EMBEDDED_FALLBACK=false`), fail fast on startup if PostgreSQL or Redis is unreachable.
  - When `ALLOW_EMBEDDED_FALLBACK=true` in sandboxed preview environments, fall back to `@libsql/client` (`file:reachinbox.db`) and report the active engine transparently in `/ready` (`engine: "sqlite-fallback"`) without claiming PostgreSQL is connected.

---

## ADR-005: Elasticsearch 8.12 Primary Search with Outbox Reconciliation & Explicit Fallback
- **Status**: Accepted
- **Context**: Full-text search across recipient emails, subjects, and bodies should use Elasticsearch (`ES_EMAILS_INDEX = emails`), but transient indexing failures must not lose updates or silently pretend Elasticsearch is healthy.
- **Decision**:
  - Index every email state change into Elasticsearch using deterministic `_id = email.id`.
  - On indexing failure, persist `esSyncError` on the `emails` row and enqueue an `ELASTICSEARCH_INDEX` job in `outbox_jobs` for automatic retry by `reconcile()` and `POST /api/search/reindex`.
  - If Elasticsearch is unreachable during `GET /api/search`, execute a user-scoped SQL fallback query and return `source: "database_fallback"` and `esHealthy: false`.

---

## ADR-006: Dual-Layer Slack Rate-Limit Alert Deduplication & AES-256-GCM Token Encryption
- **Status**: Accepted
- **Context**: When a campaign of 1,000+ emails hits a sender's hourly limit, hundreds of jobs overflow within milliseconds. Only one Slack alert should fire per sender per hour window, and stored Slack tokens must be encrypted at rest.
- **Decision**:
  - Encrypt `botToken` and `webhookUrl` in `slack_integrations` using AES-256-GCM (`ENCRYPTION_KEY`).
  - Deduplicate rate-limit alerts per `(userId, senderId, windowKey)` using both Redis `SET slacknotif:{senderId}:{windowIndex} 1 NX EX 7200` and a relational unique constraint in `slack_notification_dedupe`.
