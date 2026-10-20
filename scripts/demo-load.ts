import assert from 'node:assert/strict';
import { initDb, getDb, getDatabaseEngine, SenderRow } from '../src/db/db.js';
import { ensureRedisReady, isRedisOnline } from '../src/lib/redis.js';
import { scheduleCampaign } from '../src/services/scheduler.js';
import { executeReserveSlot, loadReserveSlotScript } from '../src/redis-scripts/loader.js';
import { getWindowStartTime } from '../src/lib/time.js';
import { seedSendersIfEmpty, setCustomTransportFactory } from '../src/services/mailer.js';
import { emailQueue } from '../src/queues/email.queue.js';
import { processEmailJob } from '../src/workers/processor.js';
import { reconcile } from '../src/services/reconcile.js';

async function runDemoLoad() {
  const startWallMs = Date.now();
  console.log('================================================================================');
  console.log('🚀 ReachInbox Reproducible 1,200-Email Load, Rate-Limit & Recovery Verification');
  console.log('================================================================================\n');

  await initDb();
  await ensureRedisReady();
  await loadReserveSlotScript();
  await seedSendersIfEmpty();
  const db = getDb();

  const sendersRes = await db.execute(
    'SELECT * FROM senders WHERE isActive = 1 ORDER BY createdAt ASC LIMIT 3'
  );
  const senders = sendersRes.rows as unknown as SenderRow[];
  const loadUserId = senders[0]?.userId || 'usr_default';
  console.log(`[Environment]`);
  console.log(`  - Database Engine: ${getDatabaseEngine()}`);
  console.log(`  - Queue/RateLimit Mode: ${isRedisOnline() ? 'Redis + BullMQ Lua' : 'Embedded Atomic Fallback'}`);
  console.log(`  - Active Senders (${senders.length}): ${senders.map((s) => s.email).join(', ')}`);

  const totalLeads = 1200;
  const hourlyLimitPerSender = 100;
  const minDelayMs = 2000;
  const workerConcurrency = 15;

  const leads: string[] = [];
  for (let i = 1; i <= totalLeads; i++) {
    leads.push(`load.lead.${i.toString().padStart(4, '0')}@loadtest.reachinbox.ai`);
  }

  console.log(`\n[Phase 1: Atomic Rate-Limit Slot Reservation & Hourly Window Overflow]`);
  const baseTs = Date.now();
  const windowDistribution: Record<number, Record<string, number>> = {};
  const lastSlotPerSender: Record<string, number> = {};
  let totalLimitHits = 0;
  let rateLimitViolations = 0;

  for (let i = 0; i < totalLeads; i++) {
    const sender = senders[i % senders.length];
    const senderKey = `load_slot_${startWallMs}_${sender.id}`;
    const senderLabel = `${sender.displayName} (${sender.id.slice(0, 6)})`;
    const res = await executeReserveSlot(
      senderKey,
      baseTs,
      minDelayMs,
      hourlyLimitPerSender,
      72
    );

    if (res.limitHit) totalLimitHits++;

    const prevTs = lastSlotPerSender[senderKey];
    if (prevTs !== undefined && res.targetTs - prevTs < minDelayMs) {
      rateLimitViolations++;
    }
    lastSlotPerSender[senderKey] = res.targetTs;

    const w = res.windowIndex;
    if (!windowDistribution[w]) {
      windowDistribution[w] = {};
    }
    windowDistribution[w][senderLabel] = (windowDistribution[w][senderLabel] || 0) + 1;
    if (windowDistribution[w][senderLabel] > hourlyLimitPerSender) {
      rateLimitViolations++;
    }
  }

  console.log(`Window Index | Window Start Time     | Sender Breakdown                        | Total in Window`);
  console.log(`----------------------------------------------------------------------------------------------`);
  const sortedWindows = Object.keys(windowDistribution)
    .map(Number)
    .sort((a, b) => a - b);

  let verifiedAllocated = 0;
  for (const w of sortedWindows) {
    const wStartStr = new Date(getWindowStartTime(w)).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const breakdown = Object.entries(windowDistribution[w])
      .map(([sName, count]) => `${sName}: ${count}`)
      .join(', ');
    const windowSum = Object.values(windowDistribution[w]).reduce((a, b) => a + b, 0);
    verifiedAllocated += windowSum;

    console.log(
      `Window #${w.toString().padEnd(3)} | ${wStartStr.padEnd(21)} | ${breakdown.padEnd(39)} | ${windowSum} emails`
    );
  }
  console.log(`----------------------------------------------------------------------------------------------`);
  console.log(`  ✓ Allocated: ${verifiedAllocated}/${totalLeads} | Overflow shifts: ${totalLimitHits} | Rate-limit violations: ${rateLimitViolations}`);
  assert.equal(verifiedAllocated, totalLeads);
  assert.equal(rateLimitViolations, 0);

  console.log(`\n[Phase 2: Database Persistence, Queue Enqueue, Mid-Flight Restart & Controlled SMTP Worker Execution]`);
  const deliveredIds = new Set<string>();
  const recipientDeliveryCount = new Map<string, number>();
  const injectedTransientSet = new Set<string>();
  let transientErrorsInjected = 0;

  setCustomTransportFactory(() => ({
    sendMail: async (opts: any) => {
      const to = String(opts.to);
      if (
        (to.includes('0250@') || to.includes('0500@') || to.includes('0750@') || to.includes('1000@')) &&
        !injectedTransientSet.has(to)
      ) {
        injectedTransientSet.add(to);
        transientErrorsInjected++;
        const err: any = new Error('421 4.7.0 Controlled transient SMTP deferral');
        err.responseCode = 421;
        throw err;
      }
      deliveredIds.add(opts.messageId);
      recipientDeliveryCount.set(to, (recipientDeliveryCount.get(to) || 0) + 1);
      return {
        messageId: opts.messageId,
        response: '250 2.0.0 OK MockLoadTest',
      };
    },
    close: () => {},
  } as any));

  const scheduleStartMs = Date.now();
  const schedRes = await scheduleCampaign({
    userId: loadUserId,
    name: `Load Test 1,200 (${new Date().toISOString()})`,
    subject: 'Load Test Verification for {{name}}',
    body: '<p>Hello {{name}} at {{company}}, verifying 1,200 email load throughput.</p>',
    rawLeads: leads,
    startAtIso: new Date(Date.now() + 600_000).toISOString(),
    delayBetweenMs: minDelayMs,
    hourlyLimit: hourlyLimitPerSender,
  });
  const scheduleDurationMs = Date.now() - scheduleStartMs;

  const qCounts = await emailQueue.getJobCounts();
  const peakQueueDepth = qCounts.waiting + qCounts.delayed + qCounts.active;

  const persistedRes = await db.execute({
    sql: 'SELECT id FROM emails WHERE campaignId = ? ORDER BY sequence ASC',
    args: [schedRes.campaignId],
  });
  const allRows = persistedRes.rows as unknown as Array<{ id: string }>;
  assert.equal(allRows.length, totalLeads);

  const firstHalf = allRows.slice(0, 600);
  const secondHalf = allRows.slice(600);

  const processBatchConcurrently = async (batch: Array<{ id: string }>) => {
    let idx = 0;
    const workers = Array.from({ length: workerConcurrency }, async () => {
      while (idx < batch.length) {
        const item = batch[idx++];
        if (!item) break;
        let job = await emailQueue.getJob(item.id);
        if (!job) {
          job = await emailQueue.add('send-email', { emailId: item.id }, { jobId: item.id, delay: 0 });
        }
        await job.updateData({ emailId: item.id, slotAt: Date.now() });
        try {
          await processEmailJob(job);
        } catch {
          await job.updateData({ emailId: item.id, slotAt: Date.now() });
          await processEmailJob(job);
        }
      }
    });
    await Promise.all(workers);
  };

  const workerStartMs = Date.now();
  await processBatchConcurrently(firstHalf);

  // Simulate mid-flight crash/restart on 5 active claims and 8 dropped queue jobs
  for (let i = 0; i < 5; i++) {
    await db.execute({
      sql: `UPDATE emails SET status = 'PROCESSING', processingStartedAt = ? WHERE id = ?`,
      args: [Date.now() - 600_000, secondHalf[i].id],
    });
  }
  for (let i = 5; i < 13; i++) {
    const j = await emailQueue.getJob(secondHalf[i].id);
    if (j && typeof j.remove === 'function') {
      await j.remove();
    }
  }

  const reconcileReport = await reconcile();
  await processBatchConcurrently(secondHalf);
  const workerDurationMs = Date.now() - workerStartMs;
  const totalRuntimeMs = Date.now() - startWallMs;

  setCustomTransportFactory(null);

  const duplicateDeliveries = Array.from(recipientDeliveryCount.values()).filter((c) => c > 1).length;
  const finalSentRes = await db.execute({
    sql: `SELECT COUNT(*) as cnt FROM emails WHERE campaignId = ? AND status = 'SENT'`,
    args: [schedRes.campaignId],
  });
  const finalSentCount = Number(finalSentRes.rows[0]?.cnt || 0);
  const throughputPerSec = Number(((finalSentCount / Math.max(1, workerDurationMs)) * 1000).toFixed(1));

  assert.equal(finalSentCount, totalLeads);
  assert.equal(duplicateDeliveries, 0);

  // Clean up load-test rows so interactive dashboard metrics remain clean
  await db.execute({
    sql: `DELETE FROM send_attempts WHERE emailId IN (SELECT id FROM emails WHERE campaignId = ?)`,
    args: [schedRes.campaignId],
  });
  await db.execute({ sql: `DELETE FROM email_events WHERE campaignId = ?`, args: [schedRes.campaignId] });
  await db.execute({ sql: `DELETE FROM emails WHERE campaignId = ?`, args: [schedRes.campaignId] });
  await db.execute({ sql: `DELETE FROM campaigns WHERE id = ?`, args: [schedRes.campaignId] });

  const summary = {
    campaignId: schedRes.campaignId,
    totalScheduled: totalLeads,
    persistedInDb: allRows.length,
    finalSentCount,
    lostJobs: totalLeads - finalSentCount,
    duplicateDeliveries,
    rateLimitViolations,
    transientErrorsInjectedAndRecovered: transientErrorsInjected,
    crashRecoveryReclaimed: reconcileReport.reclaimed,
    crashRecoveryReenqueued: reconcileReport.reenqueued,
    peakQueueDepth,
    schedulePersistenceMs: scheduleDurationMs,
    workerExecutionMs: workerDurationMs,
    totalRuntimeMs,
    throughputEmailsPerSec: throughputPerSec,
  };

  console.log(`\n================================================================================`);
  console.log(`✅ 1,200-EMAIL LOAD & RECOVERY VERIFICATION PASSED`);
  console.log(`================================================================================`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`================================================================================\n`);

  process.exit(0);
}

runDemoLoad().catch((err) => {
  console.error('[Error running load verification]', err);
  process.exit(1);
});
