import { getDb, EmailRow } from '../db/db.js';
import { emailQueue } from '../queues/email.queue.js';
import { config } from '../config/env.js';
import { reconcileSearchIndex } from './search.js';

export interface ReconcileReport {
  reenqueued: number;
  reclaimed: number;
  outboxProcessed: number;
  searchReindexed: number;
  totalScheduled: number;
}

export async function reconcile(): Promise<ReconcileReport> {
  const db = getDb();
  const now = Date.now();
  let reenqueued = 0;
  let reclaimed = 0;
  let outboxProcessed = 0;

  // 1. Stale PROCESSING reclamation (crash recovery)
  const staleThreshold = now - config.STALE_CLAIM_MS;
  const staleRes = await db.execute({
    sql: `UPDATE emails 
          SET status = 'SCHEDULED', 
              processingStartedAt = NULL, 
              updatedAt = ? 
          WHERE status = 'PROCESSING' AND processingStartedAt < ?`,
    args: [now, staleThreshold],
  });
  reclaimed = staleRes.rowsAffected;

  // 2. Sweep any PENDING campaign outbox_jobs
  const pendingOutbox = await db
    .execute({
      sql: `SELECT id, entityId FROM outbox_jobs WHERE entityType = 'CAMPAIGN_ENQUEUE' AND status = 'PENDING' ORDER BY createdAt ASC LIMIT 100`,
      args: [],
    })
    .catch(() => ({ rows: [] as Record<string, any>[], rowsAffected: 0 }));

  // 3. Reconcile all SCHEDULED emails with BullMQ jobs
  const scheduledEmails = await db.execute(`
    SELECT id, scheduledAt, campaignId, senderId, userId 
    FROM emails 
    WHERE status = 'SCHEDULED'
  `);

  const rows = scheduledEmails.rows as unknown as Pick<EmailRow, 'id' | 'scheduledAt' | 'campaignId'>[];

  for (const row of rows) {
    try {
      const existingJob = await emailQueue.getJob(row.id);
      if (!existingJob) {
        const delay = Math.max(0, Number(row.scheduledAt) - now);
        await emailQueue.add(
          'send-email',
          { emailId: row.id },
          {
            jobId: row.id,
            delay,
          }
        );
        reenqueued++;
      }
    } catch (err: any) {
      console.warn(`[Reconcile] Could not inspect/enqueue job ${row.id}:`, err.message);
    }
  }

  // Mark pending campaign outbox jobs as PROCESSED once scheduled emails are verified in queue
  for (const obx of pendingOutbox.rows as any[]) {
    try {
      await db.execute({
        sql: `UPDATE outbox_jobs SET status = 'PROCESSED', attempts = attempts + 1, processedAt = ? WHERE id = ?`,
        args: [Date.now(), obx.id],
      });
      outboxProcessed++;
    } catch {}
  }

  // 4. Reconcile any PENDING SEARCH_INDEX outbox events into Elasticsearch if ES is online
  let searchReindexed = 0;
  try {
    const searchRep = await reconcileSearchIndex();
    searchReindexed = searchRep.reindexed;
  } catch {}

  const report: ReconcileReport = {
    reenqueued,
    reclaimed,
    outboxProcessed,
    searchReindexed,
    totalScheduled: rows.length,
  };

  console.log(`[Reconcile] Completed reconciliation:`, report);
  return report;
}
