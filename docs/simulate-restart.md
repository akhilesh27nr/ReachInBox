# Restart & Persistence Simulation Guide

This document describes how the ReachInbox Email Scheduler achieves **crash resilience, restart-safety, and exactly-once execution** without any cron or recurring polling loops.

## Architectural Principles

1. **Redis AOF Persistence**: Redis runs with `--appendonly yes --appendfsync everysec` and `--maxmemory-policy noeviction`. Delayed jobs and scheduled timer slots are preserved on disk.
2. **Relational Database as Source of Truth**: Email jobs only store the `emailId` UUID in Redis. All campaign state, recipient emails, subjects, bodies, and statuses live in the persistent relational database.
3. **Boot-Time Reconciliation (`reconcile()`)**:
   - On boot, the server queries for any `SCHEDULED` emails whose corresponding BullMQ delayed job is missing from Redis (e.g. after Redis container flush or crash before enqueue). It automatically re-enqueues them with `opts.jobId = email.id` and nominal delay `max(0, scheduledAt - now)`.
   - Any stale `PROCESSING` jobs whose worker abruptly crashed (`processingStartedAt < now - 120s`) are automatically restored to `SCHEDULED` and safely reclaimed.
4. **Atomic Claim Guard**:
   ```sql
   UPDATE emails
   SET status = 'PROCESSING', processingStartedAt = ?, attempts = attempts + 1
   WHERE id = ? AND (status = 'SCHEDULED' OR (status = 'PROCESSING' AND processingStartedAt < ?))
   ```
   If two workers attempt to send the same email concurrently, only one row is affected. The second worker immediately receives `rowsAffected === 0` and exits with zero-send idempotency.

---

## Step-by-Step Restart Verification

### Scenario A: Schedule and Kill (`kill -9`)

1. **Schedule 10 emails** to start 2 minutes into the future:
   ```bash
   curl -X POST http://localhost:3000/api/campaigns/schedule \
     -H "Content-Type: application/json" \
     -d '{
       "subject": "Persistence Verification",
       "body": "Checking crash safety and restart recovery.",
       "leads": ["lead1@test.com", "lead2@test.com", "lead3@test.com"],
       "startAt": "'$(date -u -d "+2 minutes" +"%Y-%m-%dT%H:%M:%SZ")'",
       "delayBetweenMs": 2000,
       "hourlyLimit": 50
     }'
   ```

2. **Simulate an abrupt worker/server crash**:
   ```bash
   pkill -9 -f "tsx server.ts"
   ```

3. **Verify Redis & DB state while server is down**:
   ```bash
   redis-cli zrange "bull:email-send:delayed" 0 -1 WITHSCORES
   ```
   Notice that the jobs and target execution timestamps are preserved intact in Redis.

4. **Restart the server**:
   ```bash
   npm run dev
   ```
   Watch the boot logs:
   ```
   [Bootstrap] Relational database initialized.
   [Bootstrap] Redis Lua script loaded.
   [Worker] BullMQ Worker started with concurrency=5
   [Reconcile] Completed boot reconciliation: { reenqueued: 0, reclaimed: 0, totalScheduled: 3 }
   ```

5. **Observe execution**:
   When the scheduled timestamp arrives, the BullMQ worker fires, atomic claims are made, and emails are sent via Ethereal SMTP with zero duplicates.
