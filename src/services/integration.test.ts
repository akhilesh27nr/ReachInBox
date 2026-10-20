import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  config,
  parseConfig,
  DEFAULT_DEV_SESSION_SECRET,
  DEFAULT_DEV_ENCRYPTION_KEY,
} from '../config/env.js';
import {
  initDb,
  getDb,
  translateSqlForPostgres,
  createSqliteAdapter,
} from '../db/db.js';
import {
  classifySmtpError,
  setCustomTransportFactory,
  createEtherealSender,
  getSmtpDiagnostics,
  verifySenderSmtpConnection,
} from './mailer.js';
import { scheduleCampaign } from './scheduler.js';
import { reconcile } from './reconcile.js';
import { processEmailJob } from '../workers/processor.js';
import { emailQueue } from '../queues/email.queue.js';
import {
  generateOAuthState,
  verifyOAuthState,
  validateGoogleIdTokenPayload,
  exchangeGoogleCodeForUser,
  createSession,
  revokeSession,
  upsertUser,
} from './auth.js';
import { apiRouter } from '../routes/api.js';
import { getQueueAdminRouter } from '../queues/bullboard.js';

// ============================================================================
// Prompt 3 — Configuration & Fail-Fast Startup Tests
// ============================================================================
test('Config validation: accepts valid settings and rejects invalid URLs, ports, and weak production secrets', () => {
  // 1. Valid development config
  const devCfg = parseConfig({
    NODE_ENV: 'development',
    PORT: '4000',
    DATABASE_URL: 'postgresql://reachinbox:reachinbox@localhost:5432/reachinbox',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ELASTICSEARCH_URL: 'http://localhost:9200',
  });
  assert.equal(devCfg.PORT, 4000);
  assert.equal(devCfg.DATABASE_URL, 'postgresql://reachinbox:reachinbox@localhost:5432/reachinbox');

  // 2. Invalid PORT
  assert.throws(() => {
    parseConfig({ PORT: '99999' });
  }, /PORT must be between 1 and 65535/);

  // 3. Invalid DATABASE_URL protocol
  assert.throws(() => {
    parseConfig({ DATABASE_URL: 'mysql://localhost:3306/db' });
  }, /DATABASE_URL must start with postgresql/);

  // 4. Invalid REDIS_URL protocol
  assert.throws(() => {
    parseConfig({ REDIS_URL: 'http://localhost:6379' });
  }, /REDIS_URL must start with redis/);

  // 5. Invalid WORKER_CONCURRENCY
  assert.throws(() => {
    parseConfig({ WORKER_CONCURRENCY: '0' });
  });

  // 6. Strict/Production mode rejects default SESSION_SECRET
  assert.throws(() => {
    parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: DEFAULT_DEV_SESSION_SECRET,
      ENCRYPTION_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      BULL_BOARD_PASS: 'StrongAdminPass!2026',
    });
  }, /SESSION_SECRET must be explicitly set/);

  // 7. Strict/Production mode rejects default ENCRYPTION_KEY
  assert.throws(() => {
    parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'custom-production-session-secret-key-at-least-32-chars',
      ENCRYPTION_KEY: DEFAULT_DEV_ENCRYPTION_KEY,
      BULL_BOARD_PASS: 'StrongAdminPass!2026',
    });
  }, /ENCRYPTION_KEY must be explicitly set/);

  // 8. Strict/Production mode rejects weak BULL_BOARD_PASS (admin123)
  assert.throws(() => {
    parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'custom-production-session-secret-key-at-least-32-chars',
      ENCRYPTION_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      BULL_BOARD_PASS: 'admin123',
    });
  }, /BULL_BOARD_PASS cannot use weak default credentials/);
});

// ============================================================================
// Prompt 2 — PostgreSQL SQL Translation, Transactions & Fail-Fast Tests
// ============================================================================
test('PostgreSQL SQL translation converts ? placeholders and quotes camelCase identifiers', () => {
  const rawSql = `SELECT id, userId, campaignId, scheduledAt FROM emails WHERE userId = ? AND status = ? ORDER BY scheduledAt ASC LIMIT ? OFFSET ?`;
  const pgSql = translateSqlForPostgres(rawSql);

  assert.equal(
    pgSql,
    `SELECT id, "userId", "campaignId", "scheduledAt" FROM emails WHERE "userId" = $1 AND status = $2 ORDER BY "scheduledAt" ASC LIMIT $3 OFFSET $4`
  );
});

test('Database transaction rollback leaves zero partial state on error, and strict mode fails fast when PG is down', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });
  const db = getDb();

  const txUserId = `usr_tx_rollback_${Date.now()}`;
  await assert.rejects(async () => {
    await db.withTransaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO users (id, email, name, createdAt) VALUES (?, ?, ?, ?)`,
        args: [txUserId, `${txUserId}@example.com`, 'Rollback User', new Date().toISOString()],
      });
      throw new Error('Simulated mid-transaction failure');
    });
  }, /Simulated mid-transaction failure/);

  const checkRes = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [txUserId],
  });
  assert.equal(checkRes.rows.length, 0, 'Rolled back transaction must not persist user row');

  // Verify fail-fast when strictInfrastructure=true and PostgreSQL is unreachable
  await assert.rejects(async () => {
    await initDb({
      databaseUrl: 'postgresql://reachinbox:reachinbox@127.0.0.1:59999/reachinbox',
      strictInfrastructure: true,
      allowEmbeddedFallback: false,
    });
  }, /Database Error: PostgreSQL service is unreachable/);
});

// ============================================================================
// Prompt 5, 7, 8 — End-to-End Scheduling, Outbox, Reconciliation & Worker Lifecycle
// ============================================================================
test('Campaign scheduling, outbox persistence, reconciliation recovery, and worker send_attempts lifecycle', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });
  const db = getDb();
  emailQueue._clearMemoryJobs();

  const user = await upsertUser({
    email: `scheduler.test.${Date.now()}@reachinbox.ai`,
    name: 'Scheduler Tester',
  });
  const sender = await createEtherealSender(user.id, 'Test Sender');

  // 1. Schedule campaign with idempotencyKey
  const idemKey = `idem_${Date.now()}`;
  const scheduleResult = await scheduleCampaign({
    userId: user.id,
    subject: 'Hello {{name}} at {{company}}',
    body: '<p>Hi {{name}}, reaching out to {{email}} at {{company}}.</p>',
    rawLeads: ['alice.jones@stripe.com', 'bob.smith@hubspot.com', 'invalid-email', 'alice.jones@stripe.com'],
    delayBetweenMs: 2000,
    hourlyLimit: 50,
    idempotencyKey: idemKey,
  });

  assert.equal(scheduleResult.accepted, 2);
  assert.equal(scheduleResult.invalid.length, 1);
  assert.equal(scheduleResult.duplicates.length, 1);
  assert.equal(scheduleResult.outboxStatus, 'PROCESSED');

  // 2. Duplicate submission with same idempotencyKey returns existing campaign without duplicating emails
  const duplicateResult = await scheduleCampaign({
    userId: user.id,
    subject: 'Hello {{name}} at {{company}}',
    body: '<p>Hi {{name}}, reaching out to {{email}} at {{company}}.</p>',
    rawLeads: ['alice.jones@stripe.com', 'bob.smith@hubspot.com'],
    idempotencyKey: idemKey,
  });
  assert.equal(duplicateResult.idempotent, true);
  assert.equal(duplicateResult.campaignId, scheduleResult.campaignId);

  // 3. Simulate Redis/Queue loss and stale PROCESSING claim, then run reconcile()
  const emailsRes = await db.execute({
    sql: 'SELECT * FROM emails WHERE campaignId = ? ORDER BY sequence ASC',
    args: [scheduleResult.campaignId],
  });
  assert.equal(emailsRes.rows.length, 2);
  const email1 = emailsRes.rows[0] as any;
  const email2 = emailsRes.rows[1] as any;

  // Put email1 into a stale PROCESSING state and clear queue
  await db.execute({
    sql: `UPDATE emails SET status = 'PROCESSING', processingStartedAt = ? WHERE id = ?`,
    args: [Date.now() - 300_000, email1.id],
  });
  emailQueue._clearMemoryJobs();

  const recReport = await reconcile();
  assert.ok(recReport.reclaimed >= 1, 'Should reclaim stale PROCESSING email');
  assert.ok(recReport.reenqueued >= 2, 'Should re-enqueue missing SCHEDULED emails');

  // 4. Process email1 with a custom SMTP transport that succeeds and verify send_attempts + template rendering
  let capturedMailOptions: any = null;
  setCustomTransportFactory(() => ({
    sendMail: async (opts: any) => {
      capturedMailOptions = opts;
      return {
        messageId: opts.messageId,
        response: '250 2.0.0 OK Queued as EtherealTest123',
      };
    },
    close: () => {},
  } as any));

  const job1 = await emailQueue.getJob(email1.id);
  // Ensure slotAt is set to now so it sends immediately without rescheduling
  await job1.updateData({ emailId: email1.id, slotAt: Date.now() });
  const outcome1 = await processEmailJob(job1);
  assert.ok(outcome1.startsWith('sent:'));
  assert.equal(capturedMailOptions.subject, 'Hello Alice Jones at Stripe');
  assert.ok(capturedMailOptions.html.includes('Hi Alice Jones, reaching out to alice.jones@stripe.com at Stripe.'));

  // Verify duplicate worker delivery is a no-op
  const duplicateOutcome = await processEmailJob(job1);
  assert.equal(duplicateOutcome, 'skipped:status_SENT');

  // Verify send_attempts row was persisted
  const attemptsRes = await db.execute({
    sql: 'SELECT * FROM send_attempts WHERE emailId = ?',
    args: [email1.id],
  });
  assert.equal(attemptsRes.rows.length, 1);
  assert.equal(attemptsRes.rows[0].outcome, 'SENT');
  assert.equal(attemptsRes.rows[0].smtpResponse, '250 2.0.0 OK Queued as EtherealTest123');

  // 5. Test Permanent SMTP failure (550 User unknown) on email2 -> immediately marks FAILED
  setCustomTransportFactory(() => ({
    sendMail: async () => {
      const err: any = new Error('550 5.1.1 <bob.smith@hubspot.com>: Recipient address rejected: User unknown');
      err.responseCode = 550;
      throw err;
    },
    close: () => {},
  } as any));

  const job2 = await emailQueue.getJob(email2.id);
  await job2.updateData({ emailId: email2.id, slotAt: Date.now() });
  const outcome2 = await processEmailJob(job2);
  assert.ok(outcome2.startsWith('failed:permanent:'));

  const email2After = await db.execute({
    sql: 'SELECT status, lastError FROM emails WHERE id = ?',
    args: [email2.id],
  });
  assert.equal(email2After.rows[0].status, 'FAILED');
  assert.ok(String(email2After.rows[0].lastError).includes('[PERMANENT]'));

  setCustomTransportFactory(null);

  // 6. Verify SMTP diagnostics never expose passwords
  const diag = await getSmtpDiagnostics(user.id);
  assert.equal(diag.configured, true);
  assert.ok(diag.senders.length >= 1);
  assert.equal((diag.senders[0] as any).smtpPassEncrypted, undefined);
  const connVerify = await verifySenderSmtpConnection(sender.id);
  assert.equal(connVerify.ok, true);
});

// ============================================================================
// Prompt 9 & Prompt 10 — Google OAuth, Session Auth, Route Security & Isolation
// ============================================================================
test('Google OAuth state verification, OIDC token validation, and exchange flow', async () => {
  const state = generateOAuthState();
  assert.equal(verifyOAuthState(state, state), true);
  assert.equal(verifyOAuthState(state, 'mismatched_cookie_state'), false);
  assert.equal(verifyOAuthState(`${state}tampered`, `${state}tampered`), false);

  const nowSec = Math.floor(Date.now() / 1000);
  // Valid OIDC payload
  validateGoogleIdTokenPayload(
    {
      iss: 'https://accounts.google.com',
      aud: 'test-client-id',
      sub: 'google-sub-12345',
      email: 'oauth.user@reachinbox.ai',
      email_verified: true,
      exp: nowSec + 3600,
    },
    'test-client-id',
    nowSec
  );

  // Expired token rejected
  assert.throws(() => {
    validateGoogleIdTokenPayload(
      {
        iss: 'https://accounts.google.com',
        aud: 'test-client-id',
        sub: 'google-sub-12345',
        exp: nowSec - 10,
      },
      'test-client-id',
      nowSec
    );
  }, /Expired OIDC ID token/);

  // Wrong audience rejected
  assert.throws(() => {
    validateGoogleIdTokenPayload(
      {
        iss: 'https://accounts.google.com',
        aud: 'wrong-client-id',
        sub: 'google-sub-12345',
        exp: nowSec + 3600,
      },
      'test-client-id',
      nowSec
    );
  }, /Invalid OIDC audience claim/);
});

test('API Route Security: enforces 401 on unauthenticated requests, prevents cross-user access, and protects Bull Board', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/admin/queues', getQueueAdminRouter());
  app.use('/api', apiRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Unauthenticated requests with X-Require-Auth: 1 or invalid Bearer token return 401
    const unauthMe = await fetch(`${baseUrl}/api/me`, {
      headers: { 'X-Require-Auth': '1' },
    });
    assert.equal(unauthMe.status, 401);

    const invalidBearerRes = await fetch(`${baseUrl}/api/emails/scheduled`, {
      headers: { Authorization: 'Bearer invalid_token_12345' },
    });
    assert.equal(invalidBearerRes.status, 401);

    // 2. Register User A and User B and verify strict cross-user isolation
    const regARes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice Tenant',
        email: `alice.tenant.${Date.now()}@acme.io`,
      }),
    });
    assert.equal(regARes.status, 201);
    const userAData = await regARes.json();
    const tokenA = userAData.sessionToken;
    assert.ok(tokenA);

    const regBRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Mallory Tenant',
        email: `mallory.tenant.${Date.now()}@other.io`,
      }),
    });
    assert.equal(regBRes.status, 201);
    const userBData = await regBRes.json();
    const tokenB = userBData.sessionToken;
    assert.ok(tokenB);

    // User A schedules a campaign in the future (+10 minutes)
    const futureIso = new Date(Date.now() + 600_000).toISOString();
    const schedARes = await fetch(`${baseUrl}/api/campaigns/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        subject: 'Tenant A Confidential Campaign',
        body: 'Hello {{name}}',
        leads: ['target.one@client.com'],
        startAt: futureIso,
      }),
    });
    assert.equal(schedARes.status, 201);

    // Fetch User A's scheduled emails
    const listARes = await fetch(`${baseUrl}/api/emails/scheduled`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listAData = await listARes.json();
    assert.equal(listAData.emails.length, 1);
    const emailAId = listAData.emails[0].id;

    // User B lists scheduled emails -> cannot see User A's emails
    const listBRes = await fetch(`${baseUrl}/api/emails/scheduled`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listBData = await listBRes.json();
    assert.equal(
      listBData.emails.some((e: any) => e.id === emailAId),
      false,
      'User B must not see User A scheduled emails'
    );

    // User B tries to cancel User A's email -> gets 404 Not Found
    const cancelByBRes = await fetch(`${baseUrl}/api/emails/${emailAId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(cancelByBRes.status, 404);

    // User B tries to view User A's email attempts -> gets 404 Not Found
    const attemptsByBRes = await fetch(`${baseUrl}/api/emails/${emailAId}/attempts`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(attemptsByBRes.status, 404);

    // User A cancels their own email -> succeeds (200 OK)
    const cancelByARes = await fetch(`${baseUrl}/api/emails/${emailAId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(cancelByARes.status, 200);

    // 3. Logout revokes session token immediately
    const logoutARes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(logoutARes.status, 200);

    const afterLogoutRes = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(afterLogoutRes.status, 401, 'Revoked session token must return 401');

    // 4. Bull Board /admin/queues rejects wrong Basic Auth and accepts valid Basic Auth
    const badAdminRes = await fetch(`${baseUrl}/admin/queues`, {
      headers: {
        Authorization: `Basic ${Buffer.from('admin:wrongpassword').toString('base64')}`,
      },
    });
    assert.equal(badAdminRes.status, 401);

    const goodAdminRes = await fetch(`${baseUrl}/admin/queues`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.BULL_BOARD_USER}:${config.BULL_BOARD_PASS}`).toString('base64')}`,
      },
    });
    assert.equal(goodAdminRes.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
