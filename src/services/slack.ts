import crypto from 'crypto';
import { Request } from 'express';
import { getDb, SlackConnectionRow } from '../db/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { redisClient } from '../lib/redis.js';
import { config } from '../config/env.js';

let slackFetchImpl: typeof fetch = fetch;
let slackRetryDelayMs = 250;

export function setSlackFetchImpl(fn: typeof fetch | null): void {
  slackFetchImpl = fn || fetch;
}

export function setSlackRetryDelayMs(ms: number): void {
  slackRetryDelayMs = Math.max(0, ms);
}

export function isSlackOAuthConfigured(): boolean {
  return Boolean(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET);
}

export function getSlackConnectionType(conn: SlackConnectionRow | null): 'OAUTH' | 'WEBHOOK' | null {
  if (!conn || conn.status !== 'CONNECTED') return null;
  if (conn.botTokenEncrypted && conn.botTokenEncrypted.length > 0) return 'OAUTH';
  if (conn.teamId && conn.teamId !== 'T_CUSTOM') return 'OAUTH';
  return 'WEBHOOK';
}

export function getSlackRedirectUri(req: Request): string {
  if (config.SLACK_REDIRECT_URI && !config.SLACK_REDIRECT_URI.includes('localhost')) {
    return config.SLACK_REDIRECT_URI;
  }
  if (config.APP_URL) {
    return `${config.APP_URL.replace(/\/$/, '')}/api/slack/callback`;
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${config.PORT}`;
  return `${proto}://${host}/api/slack/callback`;
}

export function buildSlackAuthorizationUrl(req: Request, state: string, clientIdOverride?: string): string {
  const clientId = clientIdOverride || config.SLACK_CLIENT_ID;
  if (!clientId) {
    throw new Error('Slack OAuth is not configured (missing SLACK_CLIENT_ID)');
  }
  const redirectUri = getSlackRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: config.SLACK_SCOPES || 'incoming-webhook,chat:write',
    redirect_uri: redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(
  userId: string,
  code: string,
  redirectUri: string,
  credentialsOverride?: { clientId?: string; clientSecret?: string }
): Promise<SlackConnectionRow> {
  const clientId = credentialsOverride?.clientId || config.SLACK_CLIENT_ID;
  const clientSecret = credentialsOverride?.clientSecret || config.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Slack OAuth credentials (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET) are not configured.');
  }

  const res = await slackFetchImpl('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`Slack OAuth HTTP error ${res.status}`);
  }

  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    team?: { id: string; name: string };
    incoming_webhook?: {
      channel: string;
      channel_id: string;
      url: string;
    };
  };

  if (!data.ok) {
    throw new Error(`Slack OAuth rejected: ${data.error || 'unknown_error'}`);
  }

  if (!data.access_token && !data.incoming_webhook?.url) {
    throw new Error('Slack OAuth response did not include an access token or incoming webhook URL.');
  }

  const db = getDb();
  const id = `slk_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const webhookEncrypted = data.incoming_webhook?.url ? encrypt(data.incoming_webhook.url) : '';
  const botTokenEncrypted = data.access_token ? encrypt(data.access_token) : '';
  const teamId = data.team?.id || 'T_SLACK_OAUTH';
  const teamName = data.team?.name || 'Slack Workspace';
  const channelId = data.incoming_webhook?.channel_id || 'C_ALERTS';
  const channelName = data.incoming_webhook?.channel || '#rate-limits';
  const scopes = data.scope || config.SLACK_SCOPES || 'incoming-webhook,chat:write';

  const existing = await getSlackConnection(userId);
  if (existing) {
    await db.execute({
      sql: `UPDATE slack_connections
            SET teamId = ?, teamName = ?, channelId = ?, channelName = ?,
                webhookUrlEncrypted = ?, botTokenEncrypted = ?, scopes = ?,
                status = 'CONNECTED', connectedAt = ?, disconnectedAt = NULL
            WHERE userId = ?`,
      args: [teamId, teamName, channelId, channelName, webhookEncrypted, botTokenEncrypted, scopes, now, userId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO slack_connections (
              id, userId, teamId, teamName, channelId, channelName,
              webhookUrlEncrypted, botTokenEncrypted, scopes, status, connectedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONNECTED', ?)`,
      args: [id, userId, teamId, teamName, channelId, channelName, webhookEncrypted, botTokenEncrypted, scopes, now],
    });
  }

  return (await getSlackConnection(userId))!;
}

export async function getSlackConnection(userId: string): Promise<SlackConnectionRow | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM slack_connections WHERE userId = ?',
    args: [userId],
  });
  if (res.rows.length === 0) return null;
  return res.rows[0] as unknown as SlackConnectionRow;
}

export async function saveSlackWebhook(
  userId: string,
  teamName: string,
  channelName: string,
  webhookUrl: string
): Promise<SlackConnectionRow> {
  const db = getDb();
  const encrypted = encrypt(webhookUrl);
  const now = new Date().toISOString();
  const id = `slk_${crypto.randomBytes(6).toString('hex')}`;

  const existing = await getSlackConnection(userId);
  if (existing) {
    await db.execute({
      sql: `UPDATE slack_connections 
            SET teamId = 'T_CUSTOM', teamName = ?, channelId = 'C_CUSTOM', channelName = ?,
                webhookUrlEncrypted = ?, botTokenEncrypted = '', scopes = 'incoming-webhook',
                status = 'CONNECTED', connectedAt = ?, disconnectedAt = NULL 
            WHERE userId = ?`,
      args: [teamName, channelName, encrypted, now, userId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO slack_connections (id, userId, teamId, teamName, channelId, channelName, webhookUrlEncrypted, botTokenEncrypted, scopes, status, connectedAt)
            VALUES (?, ?, 'T_CUSTOM', ?, 'C_CUSTOM', ?, ?, '', 'incoming-webhook', 'CONNECTED', ?)`,
      args: [id, userId, teamName, channelName, encrypted, now],
    });
  }

  return (await getSlackConnection(userId))!;
}

/**
 * Disconnects Slack for a user: best-effort revokes OAuth token with Slack API
 * and wipes encrypted credentials from the database.
 */
export async function disconnectSlack(userId: string): Promise<void> {
  const db = getDb();
  const existing = await getSlackConnection(userId);
  if (existing && existing.botTokenEncrypted) {
    try {
      const botToken = decrypt(existing.botTokenEncrypted);
      if (botToken) {
        await slackFetchImpl('https://slack.com/api/auth.revoke', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Bearer ${botToken}`,
          },
        }).catch(() => {});
      }
    } catch {
      // Ignore decrypt or network errors during best-effort revocation
    }
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE slack_connections
          SET status = 'DISCONNECTED',
              webhookUrlEncrypted = '',
              botTokenEncrypted = '',
              disconnectedAt = ?
          WHERE userId = ?`,
    args: [now, userId],
  });
}

async function dispatchSlackPayloadWithRetry(
  connection: SlackConnectionRow,
  payload: Record<string, any>,
  maxAttempts = 3
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  let webhookUrl = '';
  let botToken = '';
  try {
    webhookUrl = connection.webhookUrlEncrypted ? decrypt(connection.webhookUrlEncrypted) : '';
  } catch {
    webhookUrl = '';
  }
  try {
    botToken = connection.botTokenEncrypted ? decrypt(connection.botTokenEncrypted) : '';
  } catch {
    botToken = '';
  }

  if (!webhookUrl && !botToken) {
    return { ok: false, attempts: 0, error: 'Missing decrypted Slack credentials' };
  }

  let lastError = 'Unknown error';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (webhookUrl) {
        const res = await slackFetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          return { ok: true, attempts: attempt };
        }
        lastError = `Webhook HTTP ${res.status}`;
      } else if (botToken) {
        const res = await slackFetchImpl('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify({
            channel: connection.channelId || connection.channelName,
            ...payload,
          }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string };
        if (res.ok && body.ok) {
          return { ok: true, attempts: attempt };
        }
        lastError = body.error || `Slack API HTTP ${res.status}`;
      }
    } catch (err: any) {
      lastError = err.message || 'Network error';
    }

    if (attempt < maxAttempts && slackRetryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, slackRetryDelayMs * attempt));
    }
  }

  return { ok: false, attempts: maxAttempts, error: lastError };
}

export async function notifySlackHourlyLimitHit(params: {
  userId: string;
  senderEmail: string;
  senderId: string;
  windowIndex: number;
  hourlyLimit: number;
  nextWindowAt: number;
  campaignId?: string;
}): Promise<boolean> {
  const { userId, senderEmail, senderId, windowIndex, hourlyLimit, nextWindowAt, campaignId } = params;
  const db = getDb();

  // 1) Record durable rate-limit event in email_events
  await db
    .execute({
      sql: `INSERT INTO email_events (id, userId, campaignId, senderId, type, meta, createdAt)
            VALUES (?, ?, ?, ?, 'HOURLY_LIMIT_REACHED', ?, ?)`,
      args: [
        `evt_${crypto.randomBytes(6).toString('hex')}`,
        userId,
        campaignId || null,
        senderId,
        JSON.stringify({ senderEmail, windowIndex, hourlyLimit, nextWindowAt, campaignId: campaignId || null }),
        Date.now(),
      ],
    })
    .catch(() => {});

  // 2) Verify user has an active, genuinely connected Slack integration
  const connection = await getSlackConnection(userId);
  if (!connection || connection.status !== 'CONNECTED') {
    return false;
  }

  // 3) Atomic persistent DB deduplication claim in slack_alert_dedup (survives restarts and multi-worker races)
  const dedupeToken = `window:${windowIndex}`;
  const dbDedupeKey = `${userId}:${senderId}:${windowIndex}`;
  const nowMs = Date.now();

  const claimedInDb = await db.withTransaction(async (tx) => {
    const existingDedup = await tx.execute({
      sql: 'SELECT status, updatedAt FROM slack_alert_dedup WHERE dedupeKey = ?',
      args: [dbDedupeKey],
    });

    if (existingDedup.rows.length > 0) {
      const row = existingDedup.rows[0];
      if (row.status === 'SENT') {
        return false;
      }
      // If another worker is actively sending (< 30s old), do not duplicate
      if (row.status === 'SENDING' && nowMs - Number(row.updatedAt || 0) < 30_000) {
        return false;
      }
      const upd = await tx.execute({
        sql: `UPDATE slack_alert_dedup
              SET status = 'SENDING', attempts = attempts + 1, updatedAt = ?
              WHERE dedupeKey = ? AND status != 'SENT'`,
        args: [nowMs, dbDedupeKey],
      });
      return upd.rowsAffected > 0;
    }

    const ins = await tx.execute({
      sql: `INSERT INTO slack_alert_dedup (dedupeKey, userId, senderId, windowIndex, status, attempts, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, 'SENDING', 1, ?, ?)
            ON CONFLICT(dedupeKey) DO NOTHING`,
      args: [dbDedupeKey, userId, senderId, windowIndex, nowMs, nowMs],
    });
    return ins.rowsAffected > 0;
  });

  if (!claimedInDb) {
    return false;
  }

  // 4) Also acquire Redis deduplication lock per user + sender + hour window
  const dedupeKey = `slacknotif:{${userId}:${senderId}}:${windowIndex}`;
  const acquired = await redisClient.set(dedupeKey, '1', 'EX', 7200, 'NX').catch(() => 'OK');
  if (!acquired) {
    return false;
  }

  const resumesAtStr = new Date(nextWindowAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

  // Operational payload ONLY: never includes recipient emails, subject/body content, or secrets
  const payload = {
    text: `⚠️ Rate Limit Reached: Sender ${senderEmail} hit ${hourlyLimit} emails/hr in window #${windowIndex}. Overflow jobs rescheduled to ${resumesAtStr}.`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '⚠️ Sender Hourly Rate Limit Reached',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender Account:*\n\`${senderEmail}\`` },
          { type: 'mrkdwn', text: `*Hourly Quota:*\n${hourlyLimit} emails / hr` },
          { type: 'mrkdwn', text: `*Hour Window:*\nWindow #${windowIndex}` },
          { type: 'mrkdwn', text: `*Resumes At:*\n${resumesAtStr}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '✅ *Zero-Drop Policy:* Remaining queued emails have been automatically moved to the next permitted hour window in BullMQ.',
          },
        ],
      },
    ],
  };

  const result = await dispatchSlackPayloadWithRetry(connection, payload, 3);
  const nowIso = new Date().toISOString();

  await db
    .execute({
      sql: `UPDATE slack_connections SET lastNotifiedAt = ?, lastNotificationOutcome = ? WHERE userId = ?`,
      args: [nowIso, result.ok ? 'DELIVERED' : `FAILED: ${result.error}`, userId],
    })
    .catch(() => {});

  if (!result.ok) {
    // Mark failed in slack_alert_dedup and release Redis deduplication key so future retry or reconnected Slack can still alert
    await db
      .execute({
        sql: `UPDATE slack_alert_dedup SET status = 'FAILED', lastError = ?, updatedAt = ? WHERE dedupeKey = ?`,
        args: [result.error || 'Slack delivery failed', Date.now(), dbDedupeKey],
      })
      .catch(() => {});
    await redisClient.del(dedupeKey).catch(() => {});
    await db
      .execute({
        sql: `INSERT INTO email_events (id, userId, senderId, type, meta, createdAt)
              VALUES (?, ?, ?, 'SLACK_ALERT_FAILED', ?, ?)`,
        args: [
          `evt_${crypto.randomBytes(6).toString('hex')}`,
          userId,
          senderId,
          JSON.stringify({ error: result.error, attempts: result.attempts, windowIndex, dedupeToken }),
          Date.now(),
        ],
      })
      .catch(() => {});
    return false;
  }

  // Mark permanently SENT in slack_alert_dedup and record SLACK_ALERT_SENT event for auditability
  await db
    .execute({
      sql: `UPDATE slack_alert_dedup SET status = 'SENT', lastError = NULL, updatedAt = ? WHERE dedupeKey = ?`,
      args: [Date.now(), dbDedupeKey],
    })
    .catch(() => {});

  await db
    .execute({
      sql: `INSERT INTO email_events (id, userId, senderId, type, meta, createdAt)
            VALUES (?, ?, ?, 'SLACK_ALERT_SENT', ?, ?)`,
      args: [
        `evt_${crypto.randomBytes(6).toString('hex')}`,
        userId,
        senderId,
        JSON.stringify({
          dedupeToken,
          windowIndex,
          hourlyLimit,
          nextWindowAt,
          attempts: result.attempts,
          channelName: connection.channelName,
        }),
        Date.now(),
      ],
    })
    .catch(() => {});

  return true;
}

export async function sendSlackTestAlert(userId: string): Promise<{ ok: boolean; error?: string }> {
  const connection = await getSlackConnection(userId);
  if (!connection || connection.status !== 'CONNECTED') {
    return { ok: false, error: 'Slack workspace is not connected' };
  }

  const payload = {
    text: '🔔 ReachInbox Pulse: Rate-limit alert integration verified!',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*✅ ReachInbox Pulse Slack Integration Verified*\nConnected channel \`${connection.channelName}\` in *${connection.teamName}* will receive real-time alerts whenever a sender reaches its hourly rate limit.`,
        },
      },
    ],
  };

  const result = await dispatchSlackPayloadWithRetry(connection, payload, 2);
  const db = getDb();
  await db
    .execute({
      sql: `UPDATE slack_connections SET lastNotifiedAt = ?, lastNotificationOutcome = ? WHERE userId = ?`,
      args: [new Date().toISOString(), result.ok ? 'DELIVERED' : `FAILED: ${result.error}`, userId],
    })
    .catch(() => {});

  return result;
}
