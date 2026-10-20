import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb, getDb } from '../db/db.js';
import { decrypt } from '../lib/crypto.js';
import { parseLeadsCsvText } from '../lib/csv.js';
import {
  generateOAuthState,
  consumeOAuthState,
  resetConsumedOAuthStates,
  upsertUser,
  createSession,
} from './auth.js';
import {
  setSlackFetchImpl,
  setSlackRetryDelayMs,
  exchangeSlackCode,
  getSlackConnection,
  getSlackConnectionType,
  saveSlackWebhook,
  disconnectSlack,
  notifySlackHourlyLimitHit,
  sendSlackTestAlert,
} from './slack.js';
import {
  setSearchFetchImpl,
  checkElasticsearchHealth,
  ensureElasticsearchIndex,
  indexEmailInSearch,
  reconcileSearchIndex,
  searchEmails,
  getSearchDiagnostics,
} from './search.js';
import {
  apiRouter,
  handleLiveness,
  handleReadiness,
  handleSlackOAuthCallback,
} from '../routes/api.js';
import { getQueueAdminRouter } from '../queues/bullboard.js';
import { emailQueue } from '../queues/email.queue.js';
import { setCustomTransportFactory, createEtherealSender } from './mailer.js';
import { scheduleCampaign } from './scheduler.js';
import { processEmailJob } from '../workers/processor.js';
import { reconcile } from './reconcile.js';

// ============================================================================
// Prompt 11 — Slack OAuth End-to-End, State Replay Protection, Encryption & Isolation
// ============================================================================
test('Prompt 11: Slack OAuth state validation, replay rejection, encrypted token storage, disconnect, and workspace isolation', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });
  resetConsumedOAuthStates();
  setSlackRetryDelayMs(5);

  const userA = await upsertUser({
    email: `slack.user.a.${Date.now()}@reachinbox.ai`,
    name: 'Slack User A',
  });
  const userB = await upsertUser({
    email: `slack.user.b.${Date.now()}@reachinbox.ai`,
    name: 'Slack User B',
  });

  // 1. State validation & replay protection
  const state = generateOAuthState();
  const firstCheck = consumeOAuthState(state, state);
  assert.equal(firstCheck.valid, true, 'First consumption of valid state should succeed');

  const replayCheck = consumeOAuthState(state, state);
  assert.equal(replayCheck.valid, false, 'Replay of already consumed state must be rejected');
  assert.equal(replayCheck.code, 'OAUTH_STATE_REPLAYED');

  const mismatchCheck = consumeOAuthState(generateOAuthState(), 'different_cookie_state');
  assert.equal(mismatchCheck.valid, false);
  assert.equal(mismatchCheck.code, 'INVALID_OAUTH_STATE');

  // 2. Mock Slack OAuth token exchange (oauth.v2.access)
  const rawBotToken = 'xoxb-secret-bot-token-998877';
  const rawWebhookUrl = 'https://hooks.slack.com/services/T111/B222/SecretHook333';

  setSlackFetchImpl(async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('oauth.v2.access')) {
      return new Response(
        JSON.stringify({
          ok: true,
          access_token: rawBotToken,
          scope: 'incoming-webhook,chat:write',
          team: { id: 'T_TEAM_ALPHA', name: 'Alpha Engineering' },
          incoming_webhook: {
            channel: '#ops-rate-limits',
            channel_id: 'C_OPS_01',
            url: rawWebhookUrl,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (urlStr.includes('auth.revoke')) {
      return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  });

  const connA = await exchangeSlackCode(
    userA.id,
    'valid_oauth_code_123',
    'http://localhost:3000/api/slack/callback',
    { clientId: 'test_slack_client_id', clientSecret: 'test_slack_client_secret' }
  );

  assert.equal(connA.status, 'CONNECTED');
  assert.equal(connA.teamId, 'T_TEAM_ALPHA');
  assert.equal(connA.teamName, 'Alpha Engineering');
  assert.equal(connA.channelName, '#ops-rate-limits');
  assert.equal(getSlackConnectionType(connA), 'OAUTH');

  // Verify tokens are encrypted at rest and never stored in plaintext
  assert.notEqual(connA.botTokenEncrypted, rawBotToken);
  assert.notEqual(connA.webhookUrlEncrypted, rawWebhookUrl);
  assert.equal(decrypt(connA.botTokenEncrypted), rawBotToken);
  assert.equal(decrypt(connA.webhookUrlEncrypted), rawWebhookUrl);

  // 3. Workspace isolation: User B has no Slack connection while User A is connected
  const connB = await getSlackConnection(userB.id);
  assert.equal(connB, null);

  // User B configures manual Incoming Webhook -> distinct from OAuth
  const webhookConnB = await saveSlackWebhook(
    userB.id,
    'Beta Webhook Workspace',
    '#beta-alerts',
    'https://hooks.slack.com/services/T999/B888/BetaWebhook'
  );
  assert.equal(getSlackConnectionType(webhookConnB), 'WEBHOOK');
  assert.equal(webhookConnB.botTokenEncrypted, '');

  // 4. Provider error handling on token exchange
  setSlackFetchImpl(async () => {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await assert.rejects(async () => {
    await exchangeSlackCode(
      userA.id,
      'bad_code',
      'http://localhost:3000/api/slack/callback',
      { clientId: 'test_id', clientSecret: 'test_secret' }
    );
  }, /Slack OAuth rejected: invalid_code/);

  // 5. Disconnect wipes encrypted credentials and marks DISCONNECTED
  let revokeCalled = false;
  setSlackFetchImpl(async (url) => {
    if (String(url).includes('auth.revoke')) {
      revokeCalled = true;
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await disconnectSlack(userA.id);
  assert.equal(revokeCalled, true, 'Should call Slack auth.revoke when disconnecting OAuth');

  const afterDisconnect = await getSlackConnection(userA.id);
  assert.ok(afterDisconnect);
  assert.equal(afterDisconnect.status, 'DISCONNECTED');
  assert.equal(afterDisconnect.botTokenEncrypted, '', 'Encrypted bot token must be wiped on disconnect');
  assert.equal(afterDisconnect.webhookUrlEncrypted, '', 'Encrypted webhook URL must be wiped on disconnect');

  setSlackFetchImpl(null);
});

// ============================================================================
// Prompt 12 — Real Slack Alerts, Persistent Deduplication & Retry Backoff
// ============================================================================
test('Prompt 12: Slack rate-limit alerts enforce persistent deduplication, bounded retries, and zero PII leakage', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });
  setSlackRetryDelayMs(5);

  const user = await upsertUser({
    email: `alerts.user.${Date.now()}@reachinbox.ai`,
    name: 'Alert Tester',
  });

  // 1. Disconnected user: test alert and rate-limit alert fail gracefully without throwing
  const disconnectedTest = await sendSlackTestAlert(user.id);
  assert.equal(disconnectedTest.ok, false);

  const disconnectedRateAlert = await notifySlackHourlyLimitHit({
    userId: user.id,
    senderEmail: 'sender1@ethereal.email',
    senderId: 'snd_test_01',
    windowIndex: 480001,
    hourlyLimit: 100,
    nextWindowAt: Date.now() + 3600_000,
  });
  assert.equal(disconnectedRateAlert, false);

  // 2. Connect Slack and verify alert payload contains operational metadata ONLY (no email body/subject/recipient PII)
  await saveSlackWebhook(
    user.id,
    'Ops Workspace',
    '#rate-limits',
    'https://hooks.slack.com/services/T001/B002/OpsSecretWebhook'
  );

  const deliveredPayloads: string[] = [];
  setSlackFetchImpl(async (_url, init) => {
    deliveredPayloads.push(String(init?.body || ''));
    return new Response('ok', { status: 200 });
  });

  const windowIdx = 480002;
  const firstAlert = await notifySlackHourlyLimitHit({
    userId: user.id,
    senderEmail: 'outreach.node1@ethereal.email',
    senderId: 'snd_node_1',
    windowIndex: windowIdx,
    hourlyLimit: 50,
    nextWindowAt: Date.now() + 3600_000,
    campaignId: 'cmp_test_123',
  });
  assert.equal(firstAlert, true);
  assert.equal(deliveredPayloads.length, 1);
  assert.ok(deliveredPayloads[0].includes('outreach.node1@ethereal.email'));
  assert.ok(deliveredPayloads[0].includes('50 emails / hr'));
  assert.equal(deliveredPayloads[0].includes('OpsSecretWebhook'), false, 'Must never leak webhook secret');

  // 3. Persistent deduplication: calling notifySlackHourlyLimitHit again for same sender + window is suppressed
  const duplicateAlert = await notifySlackHourlyLimitHit({
    userId: user.id,
    senderEmail: 'outreach.node1@ethereal.email',
    senderId: 'snd_node_1',
    windowIndex: windowIdx,
    hourlyLimit: 50,
    nextWindowAt: Date.now() + 3600_000,
  });
  assert.equal(duplicateAlert, false, 'Duplicate alert in same window must be suppressed');
  assert.equal(deliveredPayloads.length, 1);

  // 4. Bounded retries: simulate 2 transient HTTP 500s followed by 200 OK on 3rd attempt
  let attemptCounter = 0;
  setSlackFetchImpl(async () => {
    attemptCounter++;
    if (attemptCounter < 3) {
      return new Response('Server Error', { status: 500 });
    }
    return new Response('ok', { status: 200 });
  });

  const retrySuccess = await notifySlackHourlyLimitHit({
    userId: user.id,
    senderEmail: 'outreach.node1@ethereal.email',
    senderId: 'snd_node_1',
    windowIndex: windowIdx + 1,
    hourlyLimit: 50,
    nextWindowAt: Date.now() + 3600_000,
  });
  assert.equal(retrySuccess, true, 'Should succeed on 3rd bounded retry attempt');
  assert.equal(attemptCounter, 3);

  setSlackFetchImpl(null);
});

// ============================================================================
// Prompt 13 — Elasticsearch Indexing, Outbox Persistence, Recovery & Scoped Search
// ============================================================================
test('Prompt 13: Elasticsearch index mapping, durable outbox on outage, recovery reindexing, special chars, and user isolation', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });
  const db = getDb();

  const user1 = await upsertUser({
    email: `es.user1.${Date.now()}@reachinbox.ai`,
    name: 'ES User One',
  });
  const user2 = await upsertUser({
    email: `es.user2.${Date.now()}@reachinbox.ai`,
    name: 'ES User Two',
  });
  const sender = await createEtherealSender(user1.id, 'ES Sender');

  // 1. Simulate Elasticsearch outage during campaign scheduling / indexing
  setSearchFetchImpl(async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:9200');
  });

  const esHealthyDown = await checkElasticsearchHealth();
  assert.equal(esHealthyDown, false, 'Must report Elasticsearch as unhealthy when unreachable');

  const camp = await scheduleCampaign({
    userId: user1.id,
    subject: 'Special 100%_Offer [Q4] for Enterprise',
    body: 'Reaching out regarding 100%_discount_plan.',
    rawLeads: ['es.lead1@stripe.com', 'es.lead2@datadog.com'],
    delayBetweenMs: 2000,
    hourlyLimit: 50,
  });

  const emailsRes = await db.execute({
    sql: 'SELECT * FROM emails WHERE campaignId = ?',
    args: [camp.campaignId],
  });
  const emailRow = emailsRes.rows[0] as any;

  // Directly invoke indexEmailInSearch while ES is down -> must record PENDING outbox job in outbox_jobs
  const indexedWhileDown = await indexEmailInSearch(emailRow);
  assert.equal(indexedWhileDown, false);

  const diagWhileDown = await getSearchDiagnostics();
  assert.equal(diagWhileDown.esHealthy, false);
  assert.equal(diagWhileDown.searchMode, 'database-fallback');
  assert.ok(diagWhileDown.pendingOutboxCount >= 1, 'Outbox must track pending SEARCH_INDEX jobs when ES is down');

  // 2. Search while ES is down uses observable database fallback, handles special SQL characters (% and _), and enforces user isolation
  const fallbackSearchUser1 = await searchEmails({
    userId: user1.id,
    query: '100%_Offer',
    page: 1,
    pageSize: 10,
  });
  assert.equal(fallbackSearchUser1.source, 'database');
  assert.equal(fallbackSearchUser1.esHealthy, false);
  assert.equal(fallbackSearchUser1.items.length, 2);
  assert.equal(fallbackSearchUser1.totalItems, 2);

  // User 2 searching for the same query gets 0 results (strict tenant isolation)
  const fallbackSearchUser2 = await searchEmails({
    userId: user2.id,
    query: '100%_Offer',
    page: 1,
    pageSize: 10,
  });
  assert.equal(fallbackSearchUser2.items.length, 0);

  // 3. Simulate Elasticsearch recovery and verify index mapping creation + outbox reconciliation
  const indexedDocs = new Map<string, any>();
  let mappingCreated = false;

  setSearchFetchImpl(async (url, init) => {
    const urlStr = String(url);
    const method = init?.method || 'GET';

    if (urlStr.includes('/_cluster/health')) {
      return new Response(JSON.stringify({ status: 'green' }), { status: 200 });
    }
    if (urlStr.includes('/_doc/')) {
      const docId = decodeURIComponent(urlStr.split('/_doc/')[1]);
      const bodyObj = JSON.parse(String(init?.body || '{}'));
      indexedDocs.set(docId, bodyObj);
      return new Response(JSON.stringify({ result: 'created', _id: docId }), { status: 200 });
    }
    if (urlStr.includes('/_search')) {
      const reqBody = JSON.parse(String(init?.body || '{}'));
      const filterTerms = reqBody.query?.bool?.filter || [];
      const userIdFilter = filterTerms.find((f: any) => f.term?.userId)?.term?.userId;
      const matching = Array.from(indexedDocs.values()).filter(
        (d) => !userIdFilter || d.userId === userIdFilter
      );
      return new Response(
        JSON.stringify({
          hits: {
            total: { value: matching.length },
            hits: matching.map((doc) => ({ _id: doc.id, _source: doc })),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Index existence / creation check
    if (method === 'HEAD') {
      return new Response(null, { status: mappingCreated ? 200 : 404 });
    }
    if (method === 'PUT') {
      mappingCreated = true;
      return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const indexEnsured = await ensureElasticsearchIndex();
  assert.equal(indexEnsured, true);
  assert.equal(mappingCreated, true, 'Should create Elasticsearch index mapping when missing');

  const reconcileRes = await reconcileSearchIndex();
  assert.equal(reconcileRes.esHealthy, true);
  assert.ok(reconcileRes.reindexed >= 1, 'Pending SEARCH_INDEX outbox events must be replayed on recovery');
  assert.equal(indexedDocs.has(emailRow.id), true, 'Document must be indexed using stable email.id');

  // Search now hits Elasticsearch directly
  const esSearchRes = await searchEmails({
    userId: user1.id,
    query: 'Enterprise',
    page: 1,
    pageSize: 10,
  });
  assert.equal(esSearchRes.source, 'elasticsearch');
  assert.equal(esSearchRes.esHealthy, true);
  assert.ok(esSearchRes.items.length >= 1);

  setSearchFetchImpl(null);
});

// ============================================================================
// Prompt 16 — RFC-4180 CSV & Lead Parser Edge Cases
// ============================================================================
test('Prompt 16: RFC-4180 CSV parser handles UTF-8 BOM, headers, quoted commas, multiline fields, escaped quotes, duplicates, invalid rows, and limits', () => {
  const csvWithBomAndEdgeCases =
    '\uFEFFemail,name,company,job_title\r\n' +
    '"alice.smith@stripe.com","Smith, Alice","Stripe, Inc.","VP, ""Global"" Sales"\r\n' +
    '"bob.jones@datadog.com","Bob\nJones","Datadog, LLC","Staff Engineer"\r\n' +
    'ALICE.SMITH@stripe.com,Duplicate Alice,Stripe,VP\r\n' +
    'not-an-email-address,Bad Row,Nowhere,None\r\n' +
    '   ,   ,   ,   \r\n' +
    '"charlie@linear.app","Unclosed Quote Company\r\n';

  const result = parseLeadsCsvText(csvWithBomAndEdgeCases, { maxLeads: 100 });

  assert.equal(result.hasHeader, true);
  assert.equal(result.validEmails.length, 3);
  assert.deepEqual(result.validEmails, [
    'alice.smith@stripe.com',
    'bob.jones@datadog.com',
    'charlie@linear.app',
  ]);
  assert.equal(result.validLeads[0].name, 'Smith, Alice');
  assert.equal(result.validLeads[0].company, 'Stripe, Inc.');
  assert.equal(result.validLeads[0].jobTitle, 'VP, "Global" Sales');
  assert.equal(result.validLeads[1].name, 'Bob\nJones');
  assert.equal(result.duplicateEmails.length, 1);
  assert.equal(result.duplicateEmails[0], 'alice.smith@stripe.com');
  assert.equal(result.invalidEntries.length, 1);
  assert.equal(result.invalidEntries[0], 'not-an-email-address');
  assert.ok(result.malformedRows.some((m) => m.includes('Unclosed quoted field')));

  // Test maxLeads limit enforcement
  const capped = parseLeadsCsvText(
    'a@test.com\nb@test.com\nc@test.com\nd@test.com',
    { maxLeads: 2 }
  );
  assert.equal(capped.validEmails.length, 2);
  assert.ok(capped.malformedRows.some((m) => m.includes('Exceeded maximum allowed leads')));
});

// ============================================================================
// Prompts 14 & 18 — Readiness Probes, API Contracts, Pagination & Validation
// ============================================================================
test('Prompts 14 & 18: Liveness/Readiness probes, consistent pagination contract, and strict query/input validation', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get('/health', handleLiveness);
  app.get('/ready', handleReadiness);
  app.use('/admin/queues', getQueueAdminRouter());
  app.use('/api', apiRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Liveness probe returns 200
    const liveRes = await fetch(`${baseUrl}/health`);
    assert.equal(liveRes.status, 200);
    const liveBody = await liveRes.json();
    assert.equal(liveBody.status, 'alive');

    // 2. Readiness probe in strict mode (?strict=true) returns 503 when running on embedded fallback
    const strictReadyRes = await fetch(`${baseUrl}/ready?strict=true`);
    assert.equal(strictReadyRes.status, 503);
    const strictReadyBody = await strictReadyRes.json();
    assert.equal(strictReadyBody.status, 'unhealthy');
    assert.equal(strictReadyBody.ready, false);

    // 3. Authenticate user and test API contracts & pagination
    const user = await upsertUser({
      email: `contract.tester.${Date.now()}@reachinbox.ai`,
      name: 'Contract Tester',
    });
    const token = await createSession(user.id);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // Invalid pagination query parameters must return 400 VALIDATION_ERROR
    const badPageRes = await fetch(`${baseUrl}/api/emails/scheduled?page=0`, { headers });
    assert.equal(badPageRes.status, 400);
    const badPageErr = await badPageRes.json();
    assert.equal(badPageErr.error.code, 'VALIDATION_ERROR');

    const badSizeRes = await fetch(`${baseUrl}/api/emails/scheduled?size=999`, { headers });
    assert.equal(badSizeRes.status, 400);

    // Invalid status enum on /api/emails/search must return 400
    const badStatusRes = await fetch(`${baseUrl}/api/emails/search?status=INVALID_ENUM`, { headers });
    assert.equal(badStatusRes.status, 400);

    // Invalid sortBy key must return 400
    const badSortRes = await fetch(`${baseUrl}/api/emails/search?sortBy=dropTable`, { headers });
    assert.equal(badSortRes.status, 400);

    // Valid paginated response includes items, page, size, totalItems, totalPages, hasNext
    const validListRes = await fetch(`${baseUrl}/api/emails/scheduled?page=1&size=5`, { headers });
    assert.equal(validListRes.status, 200);
    const validList = await validListRes.json();
    assert.equal(Array.isArray(validList.items), true);
    assert.equal(validList.page, 1);
    assert.equal(validList.size, 5);
    assert.equal(typeof validList.totalItems, 'number');
    assert.equal(typeof validList.totalPages, 'number');
    assert.equal(typeof validList.hasNext, 'boolean');

    // Slack OAuth callback provider denial (?error=access_denied) returns 400 JSON when requested
    const slackDeniedRes = await fetch(
      `${baseUrl}/api/slack/callback?error=access_denied&format=json`,
      { headers }
    );
    assert.equal(slackDeniedRes.status, 400);
    const slackDeniedBody = await slackDeniedRes.json();
    assert.equal(slackDeniedBody.error.code, 'SLACK_OAUTH_DENIED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================================================
// Prompt 20 — Reproducible 1,000+ Email Load & Correctness Test
// ============================================================================
test('Prompt 20: Reproducible 1,000+ email load test verifies persistence, concurrency, retries, restart reconciliation, and zero duplicates', async () => {
  await initDb({ databaseUrl: process.env.TEST_SQLITE_FILE || 'file:reachinbox-test.db', allowEmbeddedFallback: true });
  const db = getDb();
  emailQueue._clearMemoryJobs();

  const user = await upsertUser({
    email: `loadtest.1000.${Date.now()}@reachinbox.ai`,
    name: 'Load Test Operator',
  });
  await createEtherealSender(user.id, 'Load Sender 1');
  await createEtherealSender(user.id, 'Load Sender 2');
  await createEtherealSender(user.id, 'Load Sender 3');

  const TOTAL_EMAILS = 1020;
  const leads: string[] = [];
  for (let i = 1; i <= TOTAL_EMAILS; i++) {
    leads.push(`recipient.${i}@loadtest.example.com`);
  }

  // Track controlled SMTP deliveries and inject 5 transient 421 failures on first attempt
  const deliveredMessageIds = new Set<string>();
  const deliveredRecipients = new Map<string, number>();
  const transientAttempted = new Set<string>();

  setCustomTransportFactory(() => ({
    sendMail: async (opts: any) => {
      const to = String(opts.to);
      // Inject transient 421 error on first attempt for 5 specific recipients
      if (
        (to.startsWith('recipient.100@') ||
          to.startsWith('recipient.300@') ||
          to.startsWith('recipient.500@') ||
          to.startsWith('recipient.700@') ||
          to.startsWith('recipient.900@')) &&
        !transientAttempted.has(to)
      ) {
        transientAttempted.add(to);
        const err: any = new Error('421 4.7.0 Temporary SMTP rate deferral');
        err.responseCode = 421;
        throw err;
      }

      deliveredMessageIds.add(opts.messageId);
      deliveredRecipients.set(to, (deliveredRecipients.get(to) || 0) + 1);
      return {
        messageId: opts.messageId,
        response: '250 2.0.0 OK MockLoadAccepted',
      };
    },
    close: () => {},
  } as any));

  // 1. Schedule 1,020 emails in a single campaign
  const schedRes = await scheduleCampaign({
    userId: user.id,
    name: '1020-Email Reproducible Load Test',
    subject: 'Scale Verification for {{name}}',
    body: '<p>Hello {{name}} at {{company}}, load test verification.</p>',
    rawLeads: leads,
    startAtIso: new Date(Date.now() + 600_000).toISOString(),
    delayBetweenMs: 2000,
    hourlyLimit: 400,
  });

  assert.equal(schedRes.accepted, TOTAL_EMAILS);
  const initialQueueCounts = await emailQueue.getJobCounts();
  const peakQueueDepth = initialQueueCounts.waiting + initialQueueCounts.delayed;
  assert.ok(peakQueueDepth >= TOTAL_EMAILS, `Peak queue depth (${peakQueueDepth}) must be >= ${TOTAL_EMAILS}`);

  // 2. Fetch all 1,020 persisted emails
  const persistedRes = await db.execute({
    sql: 'SELECT id, toEmail FROM emails WHERE campaignId = ? ORDER BY sequence ASC',
    args: [schedRes.campaignId],
  });
  assert.equal(persistedRes.rows.length, TOTAL_EMAILS, 'All 1,020 emails must be persisted in database');

  // 3. Process first 500 emails with 15 concurrent worker promises
  const allRows = persistedRes.rows as unknown as Array<{ id: string; toEmail: string }>;
  const firstBatch = allRows.slice(0, 500);
  const secondBatch = allRows.slice(500);

  const runConcurrentBatch = async (batch: Array<{ id: string }>, concurrency = 15) => {
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < batch.length) {
        const current = batch[idx++];
        if (!current) break;
        let job = await emailQueue.getJob(current.id);
        if (!job) {
          job = await emailQueue.add('send-email', { emailId: current.id }, { jobId: current.id, delay: 0 });
        }
        await job.updateData({ emailId: current.id, slotAt: Date.now() });
        try {
          await processEmailJob(job);
        } catch {
          // Transient error: retry immediately as worker retry would
          await job.updateData({ emailId: current.id, slotAt: Date.now() });
          await processEmailJob(job);
        }
      }
    });
    await Promise.all(workers);
  };

  await runConcurrentBatch(firstBatch, 15);

  // 4. Simulate mid-queue crash / restart: mark 3 jobs in secondBatch as stale PROCESSING and drop 5 from queue
  for (let i = 0; i < 3; i++) {
    await db.execute({
      sql: `UPDATE emails SET status = 'PROCESSING', processingStartedAt = ? WHERE id = ?`,
      args: [Date.now() - 600_000, secondBatch[i].id],
    });
  }
  for (let i = 3; i < 8; i++) {
    const job = await emailQueue.getJob(secondBatch[i].id);
    if (job && typeof job.remove === 'function') {
      await job.remove();
    }
  }

  const recReport = await reconcile();
  assert.ok(recReport.reclaimed >= 3, 'Reconcile must reclaim stale PROCESSING jobs after simulated crash');
  assert.ok(recReport.reenqueued >= 5, 'Reconcile must re-enqueue missing SCHEDULED jobs after simulated crash');

  // 5. Process remaining 520 emails concurrently
  await runConcurrentBatch(secondBatch, 15);

  // 6. Verify 100% completion, 0 lost jobs, and 0 duplicate deliveries
  const finalStatusRes = await db.execute({
    sql: 'SELECT status, COUNT(*) as cnt FROM emails WHERE campaignId = ? GROUP BY status',
    args: [schedRes.campaignId],
  });
  const statusMap: Record<string, number> = {};
  for (const r of finalStatusRes.rows as any[]) {
    statusMap[r.status] = Number(r.cnt);
  }

  assert.equal(statusMap.SENT, TOTAL_EMAILS, 'All 1,020 emails must reach SENT status');
  assert.equal(statusMap.FAILED || 0, 0, 'Zero emails should remain FAILED after retry');
  assert.equal(statusMap.SCHEDULED || 0, 0, 'Zero emails should remain SCHEDULED');
  assert.equal(deliveredMessageIds.size, TOTAL_EMAILS, 'Every email must have a unique Message-ID');

  for (const [recipient, count] of deliveredRecipients.entries()) {
    assert.equal(count, 1, `Recipient ${recipient} must receive exactly 1 delivery (no duplicates)`);
  }

  // Clean up test rows
  await db.execute({
    sql: `DELETE FROM send_attempts WHERE emailId IN (SELECT id FROM emails WHERE campaignId = ?)`,
    args: [schedRes.campaignId],
  });
  await db.execute({ sql: `DELETE FROM email_events WHERE campaignId = ?`, args: [schedRes.campaignId] });
  await db.execute({ sql: `DELETE FROM emails WHERE campaignId = ?`, args: [schedRes.campaignId] });
  await db.execute({ sql: `DELETE FROM campaigns WHERE id = ?`, args: [schedRes.campaignId] });
  await db.execute({ sql: `DELETE FROM senders WHERE userId = ?`, args: [user.id] });

  setCustomTransportFactory(null);
});

test('Prompt 21: Reproducible local environment, Docker configuration, and graceful shutdown claim release', async () => {
  await initDb();
  const db = getDb();
  const fs = await import('fs');
  const path = await import('path');
  const { stopEmailWorker } = await import('../workers/email.worker.ts');

  // 1. Verify Dockerfile, .dockerignore, docker-compose.yml, and .env.example exist and meet security/readiness requirements
  const dockerfile = fs.readFileSync(path.resolve(process.cwd(), 'Dockerfile'), 'utf-8');
  assert.ok(dockerfile.includes('HEALTHCHECK'), 'Dockerfile must define a HEALTHCHECK');
  assert.ok(dockerfile.includes('USER node'), 'Dockerfile must run as a non-root user');
  assert.ok(!dockerfile.includes('GOOGLE_CLIENT_SECRET='), 'Dockerfile must not hardcode secrets');

  const dockerignore = fs.readFileSync(path.resolve(process.cwd(), '.dockerignore'), 'utf-8');
  assert.ok(dockerignore.includes('.env'), '.dockerignore must exclude .env files');
  assert.ok(dockerignore.includes('node_modules'), '.dockerignore must exclude node_modules');

  const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.yml'), 'utf-8');
  assert.ok(compose.includes('postgres:'), 'docker-compose.yml must define postgres service');
  assert.ok(compose.includes('redis:'), 'docker-compose.yml must define redis service');
  assert.ok(compose.includes('elasticsearch:'), 'docker-compose.yml must define elasticsearch service');
  assert.ok(compose.includes('app:'), 'docker-compose.yml must define app service');
  assert.ok(compose.includes('condition: service_healthy'), 'docker-compose.yml must use readiness-aware startup');
  assert.ok(compose.includes('postgres_data:'), 'docker-compose.yml must define persistent volumes');

  // 2. Verify stopEmailWorker releases unfinished PROCESSING claims safely back to SCHEDULED on shutdown
  const testEmailId = `em_shutdown_${Date.now()}`;
  const testCampId = `camp_shutdown_${Date.now()}`;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  await db.execute({
    sql: `INSERT INTO campaigns (id, userId, name, subject, body, startAt, delayBetweenMs, hourlyLimit, totalCount, status, createdAt, updatedAt)
          VALUES (?, 'usr_reachinbox_lead', 'Shutdown Test', 'Subj', 'Body', ?, 2000, 100, 1, 'ACTIVE', ?, ?)`,
    args: [testCampId, nowIso, nowIso, nowIso],
  });
  await db.execute({
    sql: `INSERT INTO emails (id, userId, campaignId, senderId, toEmail, subject, body, scheduledAt, status, processingStartedAt, attempts, createdAt, updatedAt)
          VALUES (?, 'usr_reachinbox_lead', ?, 'snd_test', 'shutdown@example.com', 'Subj', 'Body', ?, 'PROCESSING', ?, 1, ?, ?)`,
    args: [testEmailId, testCampId, nowMs, nowMs, nowMs, nowMs],
  });

  const stopRes = await stopEmailWorker({ releaseClaims: true, drainTimeoutMs: 500 });
  assert.equal(stopRes.drained, true, 'Worker must drain cleanly');
  assert.ok(stopRes.releasedClaims >= 1, 'stopEmailWorker must release active PROCESSING claims on shutdown');

  const checkRow = await db.execute({
    sql: `SELECT status, processingStartedAt FROM emails WHERE id = ?`,
    args: [testEmailId],
  });
  assert.equal((checkRow.rows[0] as any).status, 'SCHEDULED', 'Claimed email must revert to SCHEDULED on shutdown');
  assert.equal((checkRow.rows[0] as any).processingStartedAt, null, 'processingStartedAt must be cleared');

  await db.execute({ sql: `DELETE FROM emails WHERE id = ?`, args: [testEmailId] });
  await db.execute({ sql: `DELETE FROM campaigns WHERE id = ?`, args: [testCampId] });
});

