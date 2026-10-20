import express from 'express';
import crypto from 'crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getBullQueue, emailQueue } from './email.queue.js';
import { isRedisOnline } from '../lib/redis.js';
import { config } from '../config/env.js';
import { extractRawSessionToken, getAuthenticatedUserFromRequest } from '../services/auth.js';

let bullBoardInitialized = false;
export const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

export function verifyBasicAuthHeader(authHeader?: string): boolean {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return false;
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);

    const userMatch =
      user.length === config.BULL_BOARD_USER.length &&
      crypto.timingSafeEqual(Buffer.from(user), Buffer.from(config.BULL_BOARD_USER));
    const passMatch =
      pass.length === config.BULL_BOARD_PASS.length &&
      crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(config.BULL_BOARD_PASS));

    return userMatch && passMatch;
  } catch {
    return false;
  }
}

export function getQueueAdminRouter(): express.Router {
  const router = express.Router();

  router.use(async (req, res, next) => {
    // Enforce authentication on Bull Board Admin UI (Prompt 10 & Prompt 14):
    // Requires either valid HTTP Basic Auth (BULL_BOARD_USER / BULL_BOARD_PASS) OR an active authenticated session token.
    const hasBasicAuth = verifyBasicAuthHeader(req.headers.authorization);
    let hasValidSession = false;

    if (!hasBasicAuth) {
      const rawToken = extractRawSessionToken(req);
      if (rawToken) {
        const user = await getAuthenticatedUserFromRequest(req);
        hasValidSession = Boolean(user);
      }
    }

    if (!hasBasicAuth && !hasValidSession) {
      res.setHeader('WWW-Authenticate', 'Basic realm="ReachInbox Queue Monitor"');
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Valid admin credentials or authenticated session required to access Queue Monitor.',
        },
      });
    }

    const strictRequested = config.STRICT_INFRASTRUCTURE || req.query.strict === '1';

    if (isRedisOnline()) {
      const q = getBullQueue();
      if (q && !bullBoardInitialized) {
        try {
          createBullBoard({
            queues: [new BullMQAdapter(q)],
            serverAdapter,
          });
          bullBoardInitialized = true;
        } catch {}
      }

      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        const counts = await emailQueue.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
        return res.json({
          healthy: true,
          redisConnected: true,
          mode: 'redis-bullmq',
          queueName: config.QUEUE_NAME,
          counts,
        });
      }

      if (bullBoardInitialized) {
        return serverAdapter.getRouter()(req, res, next);
      }
    }

    // When Redis is offline, never pretend BullMQ is operating normally (Prompt 14)
    if (strictRequested || !config.ALLOW_EMBEDDED_FALLBACK) {
      return res.status(503).json({
        healthy: false,
        redisConnected: false,
        mode: 'unavailable',
        error: {
          code: 'BULLMQ_REDIS_UNAVAILABLE',
          message: 'Redis backing BullMQ is unreachable. Bull Board cannot inspect live Redis queues.',
        },
      });
    }

    const counts = await emailQueue.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(200).json({
        healthy: false,
        redisConnected: false,
        mode: 'embedded-fallback',
        warning: 'Redis daemon is offline; displaying embedded fallback queue counts (not live Redis BullMQ).',
        counts,
      });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ReachInbox Queue Monitor (Degraded Fallback)</title>
  <style>
    body { background: #0c0f17; color: #f8fafc; font-family: system-ui, sans-serif; padding: 32px; margin: 0; }
    .card { max-width: 720px; margin: 0 auto; background: #121624; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    .warn { background: #451a03; border: 1px solid #d97706; color: #fcd34d; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin: 0 0 20px; }
    .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
    .stat { background: #0d101b; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; text-align: center; }
    .val { font-size: 24px; font-weight: 700; color: #818cf8; }
    .lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ReachInbox Queue Monitor</h1>
    <div class="warn">⚠️ Degraded Mode: Redis daemon is unreachable (${config.REDIS_URL}). Showing embedded fallback queue counts. Start Redis for live BullMQ persistence.</div>
    <div class="grid">
      <div class="stat"><div class="val">${counts.waiting}</div><div class="lbl">Waiting</div></div>
      <div class="stat"><div class="val">${counts.active}</div><div class="lbl">Active</div></div>
      <div class="stat"><div class="val">${counts.delayed}</div><div class="lbl">Delayed</div></div>
      <div class="stat"><div class="val">${counts.completed}</div><div class="lbl">Completed</div></div>
      <div class="stat"><div class="val">${counts.failed}</div><div class="lbl">Failed</div></div>
    </div>
  </div>
</body>
</html>`);
  });

  return router;
}
