import crypto from 'crypto';
import { getDb, SenderRow, CampaignRow, EmailRow } from '../db/db.js';
import { emailQueue } from '../queues/email.queue.js';
import { config } from '../config/env.js';
import { calculateScheduleEstimate } from '../lib/time.js';
import { indexEmailInSearch } from './search.js';
import { inferLeadVariables } from '../lib/template.js';
import { isValidLeadEmail, parseLeadsCsvText, ParsedLeadRecord } from '../lib/csv.js';

export interface ScheduleCampaignInput {
  userId: string;
  name?: string;
  subject: string;
  body: string;
  rawLeads?: string[];
  rawCsv?: string;
  leadRecords?: ParsedLeadRecord[];
  startAtIso?: string;
  delayBetweenMs?: number;
  hourlyLimit?: number;
  idempotencyKey?: string;
}

export function sanitizeAndDedupeLeads(rawLeads: string[]): {
  accepted: string[];
  invalid: string[];
  duplicates: string[];
} {
  const seen = new Set<string>();
  const accepted: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];

  for (const raw of rawLeads) {
    const cleaned = (raw || '').trim().toLowerCase();
    if (!cleaned) continue;

    if (!isValidLeadEmail(cleaned)) {
      invalid.push(cleaned);
      continue;
    }

    if (seen.has(cleaned)) {
      duplicates.push(cleaned);
    } else {
      seen.add(cleaned);
      accepted.push(cleaned);
    }
  }

  return { accepted, invalid, duplicates };
}

export async function scheduleCampaign(input: ScheduleCampaignInput) {
  const db = getDb();
  const { userId, name, subject, body, idempotencyKey } = input;

  if (!userId || !userId.trim()) {
    throw new Error('Authenticated userId is required to schedule a campaign');
  }
  if (!subject || !subject.trim()) {
    throw new Error('Subject is required');
  }
  if (subject.trim().length > 500) {
    throw new Error('Subject cannot exceed 500 characters');
  }
  if (!body || !body.trim()) {
    throw new Error('Email body is required');
  }
  if (body.length > 100_000) {
    throw new Error('Email body exceeds maximum allowed size (100KB)');
  }

  const cleanIdempotencyKey = idempotencyKey ? String(idempotencyKey).trim() : undefined;

  // 1. Idempotency Key check (scoped per userId)
  if (cleanIdempotencyKey) {
    const existingCampaign = await db.execute({
      sql: 'SELECT * FROM campaigns WHERE userId = ? AND idempotencyKey = ?',
      args: [userId, cleanIdempotencyKey],
    });

    if (existingCampaign.rows.length > 0) {
      const row = existingCampaign.rows[0] as unknown as CampaignRow;
      const emailsCountRes = await db.execute({
        sql: 'SELECT COUNT(*) as count FROM emails WHERE campaignId = ?',
        args: [row.id],
      });
      return {
        idempotent: true,
        campaignId: row.id,
        total: Number(emailsCountRes.rows[0]?.count || row.totalCount),
        accepted: Number(row.validCount || row.totalCount),
        invalid: [],
        duplicates: [],
        delayBetweenMs: row.delayBetweenMs,
        hourlyLimit: row.hourlyLimit,
        firstSendAt: row.startAt,
        message: 'Campaign already scheduled with this idempotency key',
      };
    }
  }

  // 2. Parse, normalize, and dedupe leads (supporting either rawCsv or rawLeads array)
  let accepted: string[] = [];
  let invalid: string[] = [];
  let duplicates: string[] = [];
  const leadMetaMap = new Map<string, ParsedLeadRecord>();

  if (typeof input.rawCsv === 'string' && input.rawCsv.trim()) {
    const parsedCsv = parseLeadsCsvText(input.rawCsv, {
      maxLeads: config.MAX_LEADS_PER_REQUEST + 100,
    });
    accepted = parsedCsv.validEmails;
    invalid = [...parsedCsv.invalidEntries, ...parsedCsv.malformedRows];
    duplicates = parsedCsv.duplicateEmails;
    for (const rec of parsedCsv.validLeads) {
      leadMetaMap.set(rec.email, rec);
    }
  } else if (Array.isArray(input.rawLeads)) {
    const sanitized = sanitizeAndDedupeLeads(input.rawLeads);
    accepted = sanitized.accepted;
    invalid = sanitized.invalid;
    duplicates = sanitized.duplicates;
  }

  if (Array.isArray(input.leadRecords)) {
    for (const rec of input.leadRecords) {
      if (rec && rec.email) {
        leadMetaMap.set(rec.email.toLowerCase().trim(), rec);
      }
    }
  }

  if (accepted.length === 0) {
    throw new Error('No valid recipient email addresses provided');
  }

  if (accepted.length > config.MAX_LEADS_PER_REQUEST) {
    throw new Error(`Exceeded maximum limit of ${config.MAX_LEADS_PER_REQUEST} leads per schedule request`);
  }

  // 3. Validate start time and numeric bounds
  if (input.delayBetweenMs !== undefined && (isNaN(Number(input.delayBetweenMs)) || Number(input.delayBetweenMs) < 0)) {
    throw new Error('delayBetweenMs must be a non-negative number');
  }
  if (input.hourlyLimit !== undefined && (isNaN(Number(input.hourlyLimit)) || Number(input.hourlyLimit) < 1)) {
    throw new Error('hourlyLimit must be a positive integer');
  }

  const delayBetweenMs = Math.max(
    config.MIN_DELAY_BETWEEN_EMAILS_MS,
    Number(input.delayBetweenMs ?? config.MIN_DELAY_BETWEEN_EMAILS_MS)
  );
  const hourlyLimit = Math.min(
    config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    Math.max(1, Number(input.hourlyLimit || config.MAX_EMAILS_PER_HOUR_PER_SENDER))
  );

  const now = Date.now();
  let startTimeMs = now;
  if (input.startAtIso) {
    const parsedTime = new Date(input.startAtIso).getTime();
    if (isNaN(parsedTime)) {
      throw new Error('Invalid startAt ISO timestamp');
    }
    startTimeMs = Math.max(now, parsedTime);
  }

  // 4. Get active senders for round-robin assignment
  const sendersRes = await db.execute('SELECT * FROM senders WHERE isActive = 1');
  if (sendersRes.rows.length === 0) {
    throw new Error('No active senders available in the system');
  }
  const senders = sendersRes.rows as unknown as SenderRow[];

  // 5. Prepare Campaign, Email rows, and Outbox record
  const campaignId = `cmp_${crypto.randomBytes(6).toString('hex')}`;
  const outboxId = `obx_${crypto.randomBytes(8).toString('hex')}`;
  const campaignCreatedAt = new Date(now).toISOString();
  const effectiveIdempotencyKey = cleanIdempotencyKey || `auto_${campaignId}_${now}`;

  const emailRows: EmailRow[] = [];
  const bullMqJobs: { name: string; data: { emailId: string }; opts: any }[] = [];

  for (let i = 0; i < accepted.length; i++) {
    const toEmail = accepted[i];
    const emailId = crypto.randomUUID();
    const assignedSender = senders[i % senders.length];
    const nominalScheduledAt = startTimeMs + i * delayBetweenMs;
    const inferred = inferLeadVariables(toEmail);
    const csvMeta = leadMetaMap.get(toEmail);

    emailRows.push({
      id: emailId,
      campaignId,
      userId,
      senderId: assignedSender.id,
      toEmail,
      recipientName: csvMeta?.name || inferred.name || null,
      recipientCompany: csvMeta?.company || inferred.company || null,
      recipientJobTitle: csvMeta?.jobTitle || inferred.jobTitle || null,
      subject: subject.trim(),
      body,
      status: 'SCHEDULED',
      scheduledAt: nominalScheduledAt,
      originalScheduledAt: nominalScheduledAt,
      sentAt: null,
      failedAt: null,
      attempts: 0,
      rescheduleCount: 0,
      rescheduledReason: null,
      messageId: null,
      previewUrl: null,
      lastError: null,
      processingStartedAt: null,
      sequence: i,
      createdAt: now,
      updatedAt: now,
    });

    const initialDelay = Math.max(0, nominalScheduledAt - Date.now());
    bullMqJobs.push({
      name: 'send-email',
      data: { emailId },
      opts: {
        jobId: emailId,
        delay: initialDelay,
      },
    });
  }

  const totalRawInputCount = accepted.length + duplicates.length + invalid.length;

  // 6. Persist Campaign + Emails + Transactional Outbox Job atomically in a single DB transaction
  await db.withTransaction(async (tx) => {
    await tx.execute({
      sql: `INSERT INTO campaigns (
              id, userId, name, subject, body, startAt, delayBetweenMs, hourlyLimit,
              totalCount, validCount, duplicateCount, invalidCount,
              idempotencyKey, status, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      args: [
        campaignId,
        userId,
        name || subject.trim().slice(0, 80),
        subject.trim(),
        body,
        new Date(startTimeMs).toISOString(),
        delayBetweenMs,
        hourlyLimit,
        totalRawInputCount,
        accepted.length,
        duplicates.length,
        invalid.length,
        effectiveIdempotencyKey,
        campaignCreatedAt,
        campaignCreatedAt,
      ],
    });

    const BATCH_SIZE = 200;
    for (let b = 0; b < emailRows.length; b += BATCH_SIZE) {
      const batch = emailRows.slice(b, b + BATCH_SIZE);
      const placeholders = batch
        .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .join(', ');
      const values: any[] = [];
      for (const r of batch) {
        values.push(
          r.id,
          r.campaignId,
          r.userId,
          r.senderId,
          r.toEmail,
          r.recipientName,
          r.recipientCompany,
          r.recipientJobTitle,
          r.subject,
          r.body,
          r.status,
          r.scheduledAt,
          r.originalScheduledAt,
          r.sentAt,
          r.failedAt,
          r.attempts,
          r.rescheduleCount,
          r.rescheduledReason,
          r.messageId,
          r.previewUrl,
          r.lastError,
          r.processingStartedAt,
          r.sequence,
          r.createdAt,
          r.updatedAt
        );
      }

      await tx.execute({
        sql: `INSERT INTO emails (
          id, campaignId, userId, senderId, toEmail,
          recipientName, recipientCompany, recipientJobTitle,
          subject, body, status, scheduledAt, originalScheduledAt,
          sentAt, failedAt, attempts, rescheduleCount, rescheduledReason,
          messageId, previewUrl, lastError, processingStartedAt,
          sequence, createdAt, updatedAt
        ) VALUES ${placeholders}`,
        args: values,
      });
    }

    // Durable Outbox record ensures reconciliation can recover queue jobs if process crashes or Redis fails before enqueue completes
    await tx.execute({
      sql: `INSERT INTO outbox_jobs (id, entityType, entityId, payload, status, attempts, createdAt)
            VALUES (?, 'CAMPAIGN_ENQUEUE', ?, ?, 'PENDING', 0, ?)`,
      args: [
        outboxId,
        campaignId,
        JSON.stringify({ campaignId, emailCount: emailRows.length }),
        now,
      ],
    });
  });

  // 7. Enqueue delayed jobs into BullMQ in chunks and mark outbox PROCESSED
  let outboxStatus: 'PROCESSED' | 'PENDING_RECONCILE' = 'PROCESSED';
  try {
    const CHUNK_SIZE = config.ENQUEUE_CHUNK_SIZE;
    for (let c = 0; c < bullMqJobs.length; c += CHUNK_SIZE) {
      const chunk = bullMqJobs.slice(c, c + CHUNK_SIZE);
      await emailQueue.addBulk(chunk);
    }

    await db.execute({
      sql: `UPDATE outbox_jobs SET status = 'PROCESSED', attempts = attempts + 1, processedAt = ? WHERE id = ?`,
      args: [Date.now(), outboxId],
    });
  } catch (queueErr: any) {
    outboxStatus = 'PENDING_RECONCILE';
    await db.execute({
      sql: `UPDATE outbox_jobs SET status = 'PENDING', attempts = attempts + 1, lastError = ? WHERE id = ?`,
      args: [queueErr.message || 'Queue bulk enqueue failed', outboxId],
    });
    if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
      throw new Error(`Campaign persisted in DB (outbox ${outboxId}), but BullMQ enqueue failed: ${queueErr.message}`);
    }
  }

  // 8. Calculate estimate and async search index
  const estimate = calculateScheduleEstimate(
    accepted.length,
    Math.round(delayBetweenMs / 1000),
    hourlyLimit,
    senders.length
  );

  await Promise.all(
    emailRows.slice(0, 50).map((row) => indexEmailInSearch(row).catch(() => false))
  );

  return {
    idempotent: false,
    campaignId,
    outboxId,
    outboxStatus,
    total: accepted.length,
    accepted: accepted.length,
    invalid,
    duplicates,
    delayBetweenMs,
    hourlyLimit,
    firstSendAt: new Date(startTimeMs).toISOString(),
    estimatedFinishAt: new Date(startTimeMs + estimate.estimatedDurationMs).toISOString(),
    estimatedDuration: estimate.formattedDuration,
    estimatedWindows: estimate.totalWindows,
    activeSendersCount: senders.length,
  };
}

export function filterRetryableEmailIds(emails: Array<{ id: string; status: string }>): string[] {
  return emails
    .filter((e) => e && (e.status === 'FAILED' || e.status === 'CANCELLED'))
    .map((e) => e.id);
}

export function validateBatchRetryPayload(ids: unknown): { valid: boolean; error?: string; cleanIds: string[] } {
  if (!ids || !Array.isArray(ids)) {
    return { valid: false, error: 'Payload must be an array of email IDs', cleanIds: [] };
  }
  const clean = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim().length > 0)));
  if (clean.length === 0) {
    return { valid: false, error: 'No valid email IDs provided for retry', cleanIds: [] };
  }
  return { valid: true, cleanIds: clean };
}
