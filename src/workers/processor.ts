import crypto from 'crypto';
import { DelayedError, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { getDb, EmailRow, SenderRow } from '../db/db.js';
import { executeReserveSlot } from '../redis-scripts/loader.js';
import { getTransporterForSender, classifySmtpError } from '../services/mailer.js';
import { notifySlackHourlyLimitHit } from '../services/slack.js';
import { config } from '../config/env.js';
import { EmailJobData } from '../queues/email.queue.js';
import { getNextWindowStartTime } from '../lib/time.js';
import { indexEmailInSearch } from '../services/search.js';
import { renderEmailTemplate } from '../lib/template.js';

const TOLERANCE_MS = 150; // Slots within 150ms of now are executed immediately

export async function processEmailJob(
  job: Job<EmailJobData, any, string>,
  token?: string
): Promise<string> {
  const emailId = job.data.emailId;
  const db = getDb();

  // 1. Fetch Email row
  const emailResult = await db.execute({
    sql: 'SELECT * FROM emails WHERE id = ?',
    args: [emailId],
  });

  if (emailResult.rows.length === 0) {
    return 'skipped:email_not_found';
  }

  const email = emailResult.rows[0] as unknown as EmailRow;

  // Idempotency: If already SENT, FAILED, or CANCELLED, do nothing
  if (email.status === 'SENT' || email.status === 'FAILED' || email.status === 'CANCELLED') {
    return `skipped:status_${email.status}`;
  }

  // Fetch campaign to get effective delay & hourly limit bounds
  const campaignRes = await db.execute({
    sql: 'SELECT delayBetweenMs, hourlyLimit FROM campaigns WHERE id = ?',
    args: [email.campaignId],
  });

  const campaign = campaignRes.rows[0] as { delayBetweenMs?: number; hourlyLimit?: number } | undefined;
  const minDelayMs = Math.max(
    config.MIN_DELAY_BETWEEN_EMAILS_MS,
    Number(campaign?.delayBetweenMs ?? config.MIN_DELAY_BETWEEN_EMAILS_MS)
  );
  const hourlyLimit = Math.min(
    config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    Number(campaign?.hourlyLimit || config.MAX_EMAILS_PER_HOUR_PER_SENDER)
  );

  // Fetch sender
  const senderResult = await db.execute({
    sql: 'SELECT * FROM senders WHERE id = ? AND isActive = 1',
    args: [email.senderId],
  });

  let sender = senderResult.rows[0] as unknown as SenderRow | undefined;
  if (!sender) {
    const anySender = await db.execute('SELECT * FROM senders WHERE isActive = 1 LIMIT 1');
    if (anySender.rows.length === 0) {
      throw new Error('No active senders configured to process email');
    }
    sender = anySender.rows[0] as unknown as SenderRow;
    await db.execute({
      sql: 'UPDATE emails SET senderId = ? WHERE id = ?',
      args: [sender.id, email.id],
    });
  }

  const now = Date.now();

  // 2. Atomic Rate-Limit Slot Reservation
  // Skip reservation if job already holds a designated slot that is due right now
  const slotAt = job.data.slotAt;
  if (!slotAt || slotAt > now + TOLERANCE_MS) {
    if (!job.data.slotAt) {
      const reservation = await executeReserveSlot(
        sender.id,
        now,
        minDelayMs,
        hourlyLimit,
        config.RATE_LIMIT_LOOKAHEAD_WINDOWS
      );

      if (reservation.targetTs === -1) {
        const fallbackSlot = now + 3_600_000;
        await job.updateData({ ...job.data, slotAt: fallbackSlot });
        if (token) {
          await job.moveToDelayed(fallbackSlot, token);
          throw new DelayedError();
        }
        return 'delayed:exceeded_lookahead';
      }

      if (reservation.limitHit) {
        const nextWindowAt = getNextWindowStartTime(now);
        notifySlackHourlyLimitHit({
          userId: email.userId,
          senderEmail: sender.email,
          senderId: sender.id,
          windowIndex: reservation.windowIndex,
          hourlyLimit,
          nextWindowAt,
          campaignId: email.campaignId,
        }).catch((err) => console.error('[Worker] Slack notify error:', err.message));
      }

      if (reservation.targetTs - now > TOLERANCE_MS) {
        const reason = reservation.limitHit ? 'HOURLY_LIMIT' : 'MIN_DELAY';
        await db.execute({
          sql: `UPDATE emails 
                SET scheduledAt = ?, 
                    rescheduleCount = rescheduleCount + 1, 
                    rescheduledReason = ?, 
                    updatedAt = ? 
                WHERE id = ? AND status = 'SCHEDULED'`,
          args: [reservation.targetTs, reason, Date.now(), email.id],
        });

        await indexEmailInSearch({
          ...email,
          scheduledAt: reservation.targetTs,
          status: 'SCHEDULED',
        });

        await db.execute({
          sql: `INSERT INTO email_events (id, userId, campaignId, emailId, senderId, type, meta, createdAt)
                VALUES (?, ?, ?, ?, ?, 'RESCHEDULED', ?, ?)`,
          args: [
            `evt_${crypto.randomBytes(6).toString('hex')}`,
            email.userId,
            email.campaignId,
            email.id,
            sender.id,
            JSON.stringify({ targetTs: reservation.targetTs, reason, limitHit: reservation.limitHit }),
            Date.now(),
          ],
        });

        await job.updateData({ ...job.data, slotAt: reservation.targetTs });

        if (token) {
          await job.moveToDelayed(reservation.targetTs, token);
          throw new DelayedError();
        }
        return 'delayed:slot_reserved';
      }
    }
  }

  // 3. Atomic Claim Guard (prevents concurrent workers from processing the same record)
  const staleThreshold = now - config.STALE_CLAIM_MS;
  const claimResult = await db.execute({
    sql: `UPDATE emails 
          SET status = 'PROCESSING', 
              processingStartedAt = ?, 
              lastAttemptAt = ?,
              attempts = attempts + 1, 
              updatedAt = ? 
          WHERE id = ? 
            AND (status = 'SCHEDULED' OR (status = 'PROCESSING' AND processingStartedAt < ?))`,
    args: [now, now, now, email.id, staleThreshold],
  });

  if (claimResult.rowsAffected === 0) {
    return 'already_claimed_or_processed';
  }

  // Fetch updated attempt count and verify not cancelled in a race
  const claimedRowRes = await db.execute({
    sql: 'SELECT attempts, status, recipientName, recipientCompany, recipientJobTitle FROM emails WHERE id = ?',
    args: [email.id],
  });
  const claimedRow = claimedRowRes.rows[0] as any;
  if (!claimedRow || claimedRow.status === 'CANCELLED') {
    return 'skipped:status_CANCELLED';
  }

  const attemptNumber = Number(claimedRow.attempts || (email.attempts || 0) + 1);
  const attemptId = `att_${crypto.randomBytes(6).toString('hex')}`;

  await db.execute({
    sql: `INSERT INTO email_events (id, userId, campaignId, emailId, senderId, type, meta, createdAt)
          VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?)`,
    args: [
      `evt_${crypto.randomBytes(6).toString('hex')}`,
      email.userId,
      email.campaignId,
      email.id,
      sender.id,
      JSON.stringify({ workerPid: process.pid, attemptNumber, timestamp: now }),
      now,
    ],
  });

  // 4. Send via Ethereal SMTP with deterministic Message-ID and dynamic variable interpolation
  const deterministicMessageId = `<${email.id}@scheduler.local>`;
  const leadVars = {
    email: email.toEmail,
    name: claimedRow.recipientName || email.recipientName || undefined,
    company: claimedRow.recipientCompany || email.recipientCompany || undefined,
    jobTitle: claimedRow.recipientJobTitle || email.recipientJobTitle || undefined,
  };
  const renderedSubject = renderEmailTemplate(email.subject, leadVars);
  const renderedBody = renderEmailTemplate(email.body, leadVars);

  try {
    const transporter = await getTransporterForSender(sender);
    const info = await transporter.sendMail({
      from: `"${sender.displayName}" <${sender.email}>`,
      to: email.toEmail,
      subject: renderedSubject,
      text: renderedBody.replace(/<[^>]*>?/gm, ''),
      html: renderedBody,
      messageId: deterministicMessageId,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info) || null;
    const sentNow = Date.now();
    const resolvedMessageId = info.messageId || deterministicMessageId;
    const smtpResponse = typeof info.response === 'string' ? info.response : '250 OK';

    // Record successful send_attempt row
    await db.execute({
      sql: `INSERT INTO send_attempts (
              id, emailId, campaignId, senderId, attemptNumber,
              startedAt, completedAt, outcome, smtpResponse, messageId, errorMessage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, NULL)`,
      args: [
        attemptId,
        email.id,
        email.campaignId,
        sender.id,
        attemptNumber,
        now,
        sentNow,
        smtpResponse,
        resolvedMessageId,
      ],
    });

    await db.execute({
      sql: `UPDATE emails 
            SET status = 'SENT', 
                sentAt = ?, 
                messageId = ?, 
                previewUrl = ?, 
                lastError = NULL,
                processingStartedAt = NULL,
                updatedAt = ? 
            WHERE id = ?`,
      args: [sentNow, resolvedMessageId, previewUrl as string | null, sentNow, email.id],
    });

    await db.execute({
      sql: `INSERT INTO email_events (id, userId, campaignId, emailId, senderId, type, meta, createdAt)
            VALUES (?, ?, ?, ?, ?, 'SENT', ?, ?)`,
      args: [
        `evt_${crypto.randomBytes(6).toString('hex')}`,
        email.userId,
        email.campaignId,
        email.id,
        sender.id,
        JSON.stringify({ previewUrl, messageId: resolvedMessageId, smtpResponse, attemptNumber }),
        sentNow,
      ],
    });

    await indexEmailInSearch({
      ...email,
      status: 'SENT',
      sentAt: sentNow,
      previewUrl,
    });

    console.log(`[Worker] Sent email ${email.id} to ${email.toEmail} | Ethereal preview: ${previewUrl}`);
    return `sent:${previewUrl || 'ok'}`;
  } catch (err: any) {
    console.error(`[Worker] Failed sending email ${email.id}:`, err.message);
    const failedNow = Date.now();
    const classification = classifySmtpError(err);
    const maxAttempts = Number(job.opts?.attempts || config.EMAIL_MAX_ATTEMPTS);
    const isTerminal = classification.category === 'PERMANENT' || attemptNumber >= maxAttempts;

    // Persist failed send_attempt row
    await db.execute({
      sql: `INSERT INTO send_attempts (
              id, emailId, campaignId, senderId, attemptNumber,
              startedAt, completedAt, outcome, smtpResponse, messageId, errorMessage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?, ?, ?)`,
      args: [
        attemptId,
        email.id,
        email.campaignId,
        sender.id,
        attemptNumber,
        now,
        failedNow,
        classification.code,
        deterministicMessageId,
        err.message || 'SMTP send error',
      ],
    });

    await db.execute({
      sql: `INSERT INTO email_events (id, userId, campaignId, emailId, senderId, type, meta, createdAt)
            VALUES (?, ?, ?, ?, ?, 'SEND_FAILED', ?, ?)`,
      args: [
        `evt_${crypto.randomBytes(6).toString('hex')}`,
        email.userId,
        email.campaignId,
        email.id,
        sender.id,
        JSON.stringify({
          error: err.message,
          category: classification.category,
          code: classification.code,
          attemptNumber,
          isTerminal,
        }),
        failedNow,
      ],
    });

    if (isTerminal) {
      await db.execute({
        sql: `UPDATE emails 
              SET status = 'FAILED', 
                  failedAt = ?, 
                  lastError = ?, 
                  processingStartedAt = NULL,
                  updatedAt = ? 
              WHERE id = ?`,
        args: [failedNow, `[${classification.category}] ${err.message}`, failedNow, email.id],
      });

      await indexEmailInSearch({
        ...email,
        status: 'FAILED',
        failedAt: failedNow,
        lastError: `[${classification.category}] ${err.message}`,
      });

      // If permanent failure, do not rethrow if we want BullMQ to stop retrying immediately,
      // or mark job as terminal. Throwing on last attempt marks BullMQ job failed.
      if (classification.category === 'PERMANENT') {
        return `failed:permanent:${classification.code}`;
      }
    } else {
      // Transient failure with remaining attempts: return to SCHEDULED so retry can re-claim and reserve fresh slot
      await db.execute({
        sql: `UPDATE emails 
              SET status = 'SCHEDULED', 
                  lastError = ?, 
                  processingStartedAt = NULL,
                  updatedAt = ? 
              WHERE id = ? AND status = 'PROCESSING'`,
        args: [`[TRANSIENT] ${err.message}`, failedNow, email.id],
      });

      // Clear slotAt so it gets a fresh rate-limit reservation on next retry attempt
      await job.updateData({ emailId: email.id });
    }

    throw err;
  }
}
