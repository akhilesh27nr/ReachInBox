import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDb, getDatabaseEngine, EmailRow, SenderRow, CampaignRow, UserRow } from '../db/db.js';
import { scheduleCampaign, validateBatchRetryPayload } from '../services/scheduler.js';
import {
  searchEmails,
  checkElasticsearchHealth,
  indexEmailInSearch,
  getSearchDiagnostics,
  reindexUserEmails,
  reconcileSearchIndex,
  SearchSortField,
} from '../services/search.js';
import { emailQueue } from '../queues/email.queue.js';
import { isRedisOnline, redisClient } from '../lib/redis.js';
import {
  getHourWindowIndex,
  getWindowStartTime,
  getNextWindowStartTime,
  ONE_HOUR_MS,
  diagnoseWorkerMetrics,
} from '../lib/time.js';
import { build24hDeliveryBuckets } from '../lib/sparkline.js';
import { parseLeadsCsvText } from '../lib/csv.js';
import { config } from '../config/env.js';
import { reconcile } from '../services/reconcile.js';
import {
  createEtherealSender,
  getSmtpDiagnostics,
  verifySenderSmtpConnection,
} from '../services/mailer.js';
import { getWorkerStatus } from '../workers/email.worker.js';
import { buildPaginatedResponse, SlackStatusResponse } from '../types/api.js';
import {
  getAuthenticatedUserFromRequest,
  isGoogleOAuthConfigured,
  buildGoogleAuthorizationUrl,
  checkGoogleOAuthUrlPreflight,
  exchangeGoogleCodeForUser,
  getGoogleRedirectUri,
  upsertUser,
  createSession,
  revokeSession,
  extractRawSessionToken,
  setSessionCookies,
  clearSessionCookies,
  generateOAuthState,
  setOAuthStateCookie,
  clearOAuthStateCookie,
  getOAuthStateCookie,
  consumeOAuthState,
} from '../services/auth.js';
import {
  isSlackOAuthConfigured,
  getSlackConnectionType,
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  getSlackRedirectUri,
  getSlackConnection,
  saveSlackWebhook,
  disconnectSlack,
  sendSlackTestAlert,
  notifySlackHourlyLimitHit,
} from '../services/slack.js';

export const apiRouter = Router();

/**
 * Standardized API error response helper (Prompt 18)
 * Never exposes stack traces or sensitive secrets.
 */
function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

const VALID_EMAIL_STATUSES = ['ALL', 'SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'] as const;
const VALID_SORT_FIELDS: SearchSortField[] = ['scheduledAt', 'sentAt', 'createdAt', 'toEmail', 'status'];
const VALID_SORT_ORDERS = ['asc', 'desc'] as const;
const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function parsePaginationQuery(req: Request, defaultSize = 10): {
  valid: boolean;
  page: number;
  size: number;
  error?: string;
} {
  const rawPage = req.query.page;
  const rawSize = req.query.size ?? req.query.pageSize ?? req.query.limit;

  let page = 1;
  let size = defaultSize;

  if (rawPage !== undefined) {
    const parsedPage = Number(rawPage);
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 100000) {
      return {
        valid: false,
        page: 1,
        size: defaultSize,
        error: 'Query parameter "page" must be a positive integer >= 1',
      };
    }
    page = parsedPage;
  }

  if (rawSize !== undefined) {
    const parsedSize = Number(rawSize);
    if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > 100) {
      return {
        valid: false,
        page: 1,
        size: defaultSize,
        error: 'Query parameter "size" (or "limit") must be an integer between 1 and 100',
      };
    }
    size = parsedSize;
  }

  return { valid: true, page, size };
}

function buildSlackStatusPayload(conn: Awaited<ReturnType<typeof getSlackConnection>>): SlackStatusResponse {
  const isConnected = Boolean(conn && conn.status === 'CONNECTED');
  return {
    connected: isConnected,
    connectionType: getSlackConnectionType(conn),
    oauthConfigured: isSlackOAuthConfigured(),
    teamId: isConnected && conn ? conn.teamId : '',
    teamName: isConnected && conn ? conn.teamName : '',
    channelId: isConnected && conn ? conn.channelId : '',
    channelName: isConnected && conn ? conn.channelName : '',
    status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
    lastNotifiedAt: conn?.lastNotifiedAt || null,
    lastNotificationOutcome: conn?.lastNotificationOutcome || null,
  };
}

// ============================================================================
// Authentication Middleware (Prompt 10 & Prompt 15)
// ============================================================================

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Authentication required. Please sign in with Google OAuth or your workspace credentials.'
      );
    }
    (req as Request & { user: UserRow }).user = user;
    return next();
  } catch (err: any) {
    return sendError(res, 500, 'AUTH_ERROR', err.message || 'Authentication check failed');
  }
}

function getReqUser(req: Request): UserRow {
  return (req as Request & { user: UserRow }).user;
}

// ============================================================================
// 0. Liveness & Readiness Probes (Prompt 14)
// ============================================================================

export function handleLiveness(_req: Request, res: Response) {
  res.json({
    status: 'alive',
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

export async function handleReadiness(req: Request, res: Response) {
  try {
    const strictParam =
      req.query.strict === 'true'
        ? true
        : req.query.strict === 'false'
          ? false
          : config.STRICT_INFRASTRUCTURE;

    let dbHealthy = false;
    let dbLatencyMs = 0;
    let dbMessage = 'OK';
    const dbEngine = getDatabaseEngine();
    const dbStart = Date.now();
    try {
      const db = getDb();
      await db.execute('SELECT 1 as ok');
      dbHealthy = true;
      dbLatencyMs = Date.now() - dbStart;
    } catch (err: any) {
      dbHealthy = false;
      dbMessage = err.message || 'Database query failed';
    }

    const redisOnline = isRedisOnline();
    const workerStatus = getWorkerStatus();
    const esHealthy = await checkElasticsearchHealth();
    const searchDiag = await getSearchDiagnostics();

    let smtpDiag = { configured: false, activeSendersCount: 0, host: config.ETHEREAL_HOST, port: config.ETHEREAL_PORT };
    try {
      if (dbHealthy) {
        smtpDiag = await getSmtpDiagnostics();
      }
    } catch {}

    let queueCounts = { waiting: 0, delayed: 0, active: 0, failed: 0, completed: 0 };
    try {
      queueCounts = await emailQueue.getJobCounts();
    } catch {}

    const dbReady = strictParam ? dbHealthy && dbEngine === 'postgresql' : dbHealthy;
    const redisReady = strictParam ? redisOnline : true;
    const workerReady = strictParam
      ? workerStatus.running && workerStatus.mode === 'bullmq-redis'
      : workerStatus.running;

    const isReady = dbReady && redisReady && workerReady;
    const isFullyHealthy =
      dbHealthy && dbEngine === 'postgresql' && redisOnline && workerStatus.running && esHealthy;

    const overallStatus: 'ready' | 'degraded' | 'unhealthy' = !isReady
      ? 'unhealthy'
      : isFullyHealthy
        ? 'ready'
        : 'degraded';

    const statusCode = isReady ? 200 : 503;

    return res.status(statusCode).json({
      status: overallStatus,
      ready: isReady,
      strictMode: strictParam,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      services: {
        database: {
          healthy: dbReady,
          mode: dbEngine,
          latencyMs: dbLatencyMs,
          message: dbReady
            ? `Connected (${dbEngine})`
            : strictParam && dbEngine !== 'postgresql'
              ? 'PostgreSQL required in strict mode'
              : dbMessage,
        },
        redis: {
          healthy: redisOnline,
          ready: redisReady,
          mode: redisOnline ? 'redis-bullmq' : 'embedded-fallback',
          queueCounts,
        },
        worker: {
          healthy: workerStatus.running,
          ready: workerReady,
          mode: workerStatus.mode,
          concurrency: workerStatus.concurrency,
        },
        elasticsearch: {
          healthy: esHealthy,
          mode: searchDiag.searchMode,
          indexName: searchDiag.indexName,
          pendingOutboxCount: searchDiag.pendingOutboxCount,
          indexingErrorCount: searchDiag.indexingErrorCount,
          lastError: searchDiag.lastIndexError,
        },
        smtp: {
          healthy: smtpDiag.configured,
          mode: smtpDiag.activeSendersCount > 0 ? 'ethereal-nodemailer' : 'unseeded',
          activeSendersCount: smtpDiag.activeSendersCount,
          host: smtpDiag.host,
          port: smtpDiag.port,
        },
      },
    });
  } catch (err: any) {
    return sendError(res, 503, 'READINESS_FAILED', err.message || 'Service not ready');
  }
}

apiRouter.get('/health/live', handleLiveness);
apiRouter.get('/health/ready', handleReadiness);
apiRouter.get('/ready', handleReadiness);
apiRouter.get('/health', handleReadiness);

// ============================================================================
// 1. Google OAuth & Workspace Session Authentication (Prompts 9, 10, 15)
// ============================================================================

export async function handleGoogleOAuthStart(req: Request, res: Response) {
  if (!isGoogleOAuthConfigured()) {
    return sendError(
      res,
      400,
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'Google OAuth is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.'
    );
  }
  const state = generateOAuthState();
  if (req.query.popup !== '1') {
    setOAuthStateCookie(res, req, state);
  }
  const authUrl = buildGoogleAuthorizationUrl(req, state);
  if (req.query.format === 'json') {
    const preflight = await checkGoogleOAuthUrlPreflight(authUrl);
    return res.json({
      url: authUrl,
      state,
      redirectUri: getGoogleRedirectUri(req),
      preflightOk: preflight.ok,
      preflightError: preflight.errorCode || null,
      preflightMessage: preflight.errorMessage || null,
    });
  }
  // Never redirect an iframe directly to accounts.google.com (X-Frame-Options: DENY causes 403 in iframe)
  if (req.headers['sec-fetch-dest'] === 'iframe') {
    return res.redirect('/?google_chooser=1');
  }
  return res.redirect(authUrl);
}

export async function handleGoogleOAuthCallback(req: Request, res: Response) {
  const wantsJson =
    req.query.format === 'json' ||
    (Boolean(req.headers.accept?.includes('application/json')) &&
      !req.headers.accept?.includes('text/html'));

  try {
    const providerError = req.query.error as string | undefined;
    if (providerError) {
      clearOAuthStateCookie(res, req);
      if (wantsJson) {
        return sendError(res, 400, 'GOOGLE_OAUTH_DENIED', `Google OAuth denied: ${providerError}`);
      }
      if (req.headers.accept?.includes('text/html') || req.query.popup === '1') {
        return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Google OAuth Error</title></head><body style="background:#0b0e17;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><script>
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', provider: 'google', error: ${JSON.stringify(providerError)} }, '*');
            setTimeout(function() { window.close(); }, 100);
          } else {
            window.location.replace('/?oauth_error=' + encodeURIComponent(${JSON.stringify(providerError)}));
          }
        </script><p>Google OAuth cancelled. Closing window...</p></body></html>`);
      }
      return res.redirect(`/?oauth_error=${encodeURIComponent(providerError)}`);
    }

    const code = req.query.code as string | undefined;
    const stateParam = req.query.state as string | undefined;
    const rawCookieState = getOAuthStateCookie(req);
    const cookieState = rawCookieState && rawCookieState === stateParam ? rawCookieState : undefined;

    if (!code) {
      clearOAuthStateCookie(res, req);
      return sendError(res, 400, 'MISSING_OAUTH_CODE', 'Missing authorization code from Google OAuth callback');
    }

    const stateCheck = consumeOAuthState(stateParam, cookieState);
    clearOAuthStateCookie(res, req);

    if (!stateCheck.valid) {
      return sendError(
        res,
        403,
        stateCheck.code || 'INVALID_OAUTH_STATE',
        stateCheck.message || 'Invalid or replayed OAuth state token'
      );
    }

    const redirectUri = getGoogleRedirectUri(req);
    const user = await exchangeGoogleCodeForUser(code, redirectUri);
    const sessionToken = await createSession(user.id, req);
    setSessionCookies(res, req, sessionToken);

    const roleLabel = user.googleId ? 'Google OAuth Verified' : 'Workspace Admin';
    const userPayload = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      googleId: user.googleId || null,
      timezone: user.timezone || 'UTC',
      role: roleLabel,
    };

    if (wantsJson) {
      return res.json({ authenticated: true, sessionToken, user: userPayload });
    }

    if (req.headers.accept?.includes('text/html') || req.query.popup === '1') {
      const safePayload = JSON.stringify({
        type: 'OAUTH_AUTH_SUCCESS',
        provider: 'google',
        sessionToken,
        user: userPayload,
      });
      return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Google OAuth Complete</title></head><body style="background:#0b0e17;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><script>
        (function() {
          var payload = ${safePayload};
          try {
            if (payload.sessionToken) {
              localStorage.setItem('reachinbox_session_token', payload.sessionToken);
            }
            if (payload.user) {
              localStorage.setItem('reachinbox_user', JSON.stringify(payload.user));
            }
          } catch (e) {}
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, '*');
            setTimeout(function() { window.close(); }, 150);
          } else {
            window.location.replace('/?oauth=success&sessionToken=' + encodeURIComponent(payload.sessionToken || ''));
          }
        })();
      </script><p>Authentication successful! Synchronizing workspace session...</p></body></html>`);
    }

    return res.redirect(`/?oauth=success&sessionToken=${encodeURIComponent(sessionToken)}`);
  } catch (err: any) {
    clearOAuthStateCookie(res, req);
    if (wantsJson) {
      return sendError(res, 502, 'GOOGLE_OAUTH_EXCHANGE_FAILED', err.message || 'Google OAuth token exchange failed');
    }
    return res.redirect(`/?oauth_error=${encodeURIComponent(err.message || 'oauth_exchange_failed')}`);
  }
}

apiRouter.get('/auth/google/status', (req: Request, res: Response) => {
  res.json({
    configured: isGoogleOAuthConfigured(),
    redirectUri: getGoogleRedirectUri(req),
  });
});

apiRouter.post('/auth/google/authenticate', async (req: Request, res: Response) => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!rawEmail || !rawEmail.includes('@')) {
      return sendError(res, 400, 'INVALID_EMAIL', 'A valid Google email address is required');
    }
    const name =
      typeof req.body?.name === 'string' && req.body.name.trim()
        ? req.body.name.trim()
        : rawEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    const avatarUrl =
      typeof req.body?.avatarUrl === 'string' && req.body.avatarUrl.trim()
        ? req.body.avatarUrl.trim()
        : `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=4f46e5`;
    const googleId = `google_oauth_${crypto.createHash('sha256').update(rawEmail).digest('hex').slice(0, 24)}`;

    const user = await upsertUser({
      googleId,
      email: rawEmail,
      name,
      avatarUrl,
    });

    const sessionToken = await createSession(user.id, req);
    setSessionCookies(res, req, sessionToken);

    return res.json({
      authenticated: true,
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl || avatarUrl,
        googleId: user.googleId || googleId,
        timezone: user.timezone || 'UTC',
        role: 'Google OAuth Verified',
      },
    });
  } catch (err: any) {
    return sendError(res, 500, 'GOOGLE_AUTH_FAILED', err.message || 'Failed to authenticate Google account');
  }
});

apiRouter.get(['/auth/google', '/auth/google/'], handleGoogleOAuthStart);
apiRouter.get(['/auth/google/start', '/auth/google/start/'], handleGoogleOAuthStart);
apiRouter.get(['/auth/google/callback', '/auth/google/callback/'], handleGoogleOAuthCallback);

apiRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const user = getReqUser(req);
  const slackConn = await getSlackConnection(user.id);
  const slackStatus = buildSlackStatusPayload(slackConn);
  const hasExplicitSession = Boolean(extractRawSessionToken(req));
  const roleLabel = user.googleId ? 'Google OAuth Verified' : 'Workspace Admin';

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    googleId: user.googleId || null,
    timezone: user.timezone || 'UTC',
    role: roleLabel,
    authenticated: true,
    hasExplicitSession,
    googleOAuthConfigured: isGoogleOAuthConfigured(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      googleId: user.googleId || null,
      timezone: user.timezone || 'UTC',
      role: roleLabel,
    },
    integrations: {
      slack: slackStatus,
    },
  });
});

apiRouter.get('/auth/me', requireAuth, async (req: Request, res: Response) => {
  const user = getReqUser(req);
  const slackConn = await getSlackConnection(user.id);
  const slackStatus = buildSlackStatusPayload(slackConn);
  const hasExplicitSession = Boolean(extractRawSessionToken(req));
  const roleLabel = user.googleId ? 'Google OAuth Verified' : 'Workspace Admin';

  res.json({
    authenticated: true,
    hasExplicitSession,
    googleOAuthConfigured: isGoogleOAuthConfigured(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      googleId: user.googleId || null,
      timezone: user.timezone || 'UTC',
      role: roleLabel,
    },
    integrations: {
      slack: slackStatus,
    },
  });
});

async function handleWorkspaceLogin(req: Request, res: Response) {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!rawEmail || !rawEmail.includes('@')) {
      return sendError(res, 400, 'INVALID_EMAIL', 'A valid email address is required to sign in');
    }

    const name =
      typeof req.body?.name === 'string' && req.body.name.trim()
        ? req.body.name.trim()
        : rawEmail.split('@')[0];
    const avatarUrl =
      typeof req.body?.avatarUrl === 'string' && req.body.avatarUrl.trim()
        ? req.body.avatarUrl.trim()
        : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80';
    const role = typeof req.body?.role === 'string' && req.body.role.trim() ? req.body.role.trim() : 'Workspace Admin';

    const user = await upsertUser({
      email: rawEmail,
      name,
      avatarUrl,
    });

    const sessionToken = await createSession(user.id, req);
    setSessionCookies(res, req, sessionToken);

    return res.json({
      authenticated: true,
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl || avatarUrl,
        role,
      },
    });
  } catch (err: any) {
    return sendError(res, 500, 'LOGIN_FAILED', err.message || 'Failed to sign in');
  }
}

apiRouter.post('/auth/login', handleWorkspaceLogin);
apiRouter.post('/auth/dev-login', handleWorkspaceLogin);

apiRouter.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const role = typeof req.body?.role === 'string' && req.body.role.trim() ? req.body.role.trim() : 'Workspace Admin';
    const provisionSender = Boolean(req.body?.provisionSender);

    if (!rawEmail || !rawEmail.includes('@')) {
      return sendError(res, 400, 'INVALID_EMAIL', 'A valid work email address is required');
    }
    if (!rawName) {
      return sendError(res, 400, 'INVALID_NAME', 'Full name is required');
    }

    const avatarUrl =
      typeof req.body?.avatarUrl === 'string' && req.body.avatarUrl.trim()
        ? req.body.avatarUrl.trim()
        : 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80';

    const user = await upsertUser({
      email: rawEmail,
      name: rawName,
      avatarUrl,
    });

    if (provisionSender) {
      try {
        await createEtherealSender(user.id, `${rawName} Dedicated Sender`);
      } catch {}
    }

    const sessionToken = await createSession(user.id, req);
    setSessionCookies(res, req, sessionToken);

    return res.status(201).json({
      authenticated: true,
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl || avatarUrl,
        role,
      },
    });
  } catch (err: any) {
    return sendError(res, 500, 'REGISTER_FAILED', err.message || 'Failed to register user account');
  }
});

apiRouter.post('/auth/logout', async (req: Request, res: Response) => {
  try {
    const rawToken = extractRawSessionToken(req);
    await revokeSession(rawToken);
    clearSessionCookies(res, req);
    return res.json({ ok: true, success: true, authenticated: false });
  } catch (err: any) {
    return sendError(res, 500, 'LOGOUT_FAILED', err.message || 'Logout failed');
  }
});

// ============================================================================
// 2. Slack OAuth, Webhook & Rate-Limit Alert Integration (Prompts 11 & 12)
// ============================================================================

export function handleSlackOAuthStart(req: Request, res: Response) {
  if (!isSlackOAuthConfigured()) {
    return sendError(
      res,
      400,
      'SLACK_OAUTH_NOT_CONFIGURED',
      'Slack OAuth is not configured on this server. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in .env.'
    );
  }
  const state = generateOAuthState();
  setOAuthStateCookie(res, req, state);
  const url = buildSlackAuthorizationUrl(req, state);
  if (req.query.format === 'json') {
    return res.json({ url, state });
  }
  return res.redirect(url);
}

export async function handleSlackOAuthCallback(req: Request, res: Response) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required to connect Slack');
    }

    const providerError = req.query.error as string | undefined;
    if (providerError) {
      clearOAuthStateCookie(res, req);
      if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
        return sendError(res, 400, 'SLACK_OAUTH_DENIED', `Slack OAuth denied by user or provider: ${providerError}`);
      }
      return res.redirect(`/?slack_error=${encodeURIComponent(providerError)}`);
    }

    const code = req.query.code as string | undefined;
    const stateParam = req.query.state as string | undefined;
    const cookieState = getOAuthStateCookie(req);

    if (!code) {
      clearOAuthStateCookie(res, req);
      return sendError(res, 400, 'SLACK_MISSING_CODE', 'Missing authorization code from Slack callback');
    }

    const stateCheck = consumeOAuthState(stateParam, cookieState);
    clearOAuthStateCookie(res, req);

    if (!stateCheck.valid) {
      if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
        return sendError(
          res,
          403,
          stateCheck.code || 'INVALID_OAUTH_STATE',
          stateCheck.message || 'Invalid or replayed Slack OAuth state parameter'
        );
      }
      return res.redirect(`/?slack_error=${encodeURIComponent(stateCheck.code || 'invalid_state')}`);
    }

    const redirectUri = getSlackRedirectUri(req);
    const conn = await exchangeSlackCode(user.id, code, redirectUri);
    const status = buildSlackStatusPayload(conn);

    if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, success: true, status });
    }
    return res.redirect('/?slack_connected=1');
  } catch (err: any) {
    clearOAuthStateCookie(res, req);
    if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
      return sendError(res, 502, 'SLACK_EXCHANGE_FAILED', err.message || 'Failed to exchange Slack OAuth code');
    }
    return res.redirect(`/?slack_error=${encodeURIComponent(err.message || 'exchange_failed')}`);
  }
}

apiRouter.get('/slack/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const conn = await getSlackConnection(user.id);
    return res.json(buildSlackStatusPayload(conn));
  } catch (err: any) {
    return sendError(res, 500, 'SLACK_STATUS_FAILED', err.message);
  }
});

apiRouter.get('/integrations/slack/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const conn = await getSlackConnection(user.id);
    return res.json(buildSlackStatusPayload(conn));
  } catch (err: any) {
    return sendError(res, 500, 'SLACK_STATUS_FAILED', err.message);
  }
});

apiRouter.get('/slack/oauth/start', requireAuth, handleSlackOAuthStart);
apiRouter.get('/integrations/slack/oauth/start', requireAuth, handleSlackOAuthStart);
apiRouter.get('/slack/callback', requireAuth, handleSlackOAuthCallback);
apiRouter.get('/integrations/slack/oauth/callback', requireAuth, handleSlackOAuthCallback);

async function handleConfigureSlackWebhook(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    const webhookUrl = typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
    const teamName =
      typeof req.body?.teamName === 'string' && req.body.teamName.trim()
        ? req.body.teamName.trim()
        : 'Slack Workspace (Webhook)';
    const channelName =
      typeof req.body?.channelName === 'string' && req.body.channelName.trim()
        ? req.body.channelName.trim()
        : '#rate-limits';

    if (
      !webhookUrl ||
      (!webhookUrl.startsWith('https://hooks.slack.com/') &&
        !webhookUrl.startsWith('https://hooks.slack-gov.com/'))
    ) {
      return sendError(
        res,
        400,
        'INVALID_WEBHOOK_URL',
        'Webhook URL must start with https://hooks.slack.com/'
      );
    }

    const conn = await saveSlackWebhook(user.id, teamName, channelName, webhookUrl);
    return res.json({
      ok: true,
      success: true,
      status: buildSlackStatusPayload(conn),
    });
  } catch (err: any) {
    return sendError(res, 500, 'SLACK_WEBHOOK_SAVE_FAILED', err.message);
  }
}

apiRouter.post('/slack/configure-webhook', requireAuth, handleConfigureSlackWebhook);
apiRouter.post('/integrations/slack/connect-webhook', requireAuth, handleConfigureSlackWebhook);

async function handleDisconnectSlack(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    await disconnectSlack(user.id);
    const conn = await getSlackConnection(user.id);
    return res.json({
      ok: true,
      success: true,
      status: buildSlackStatusPayload(conn),
    });
  } catch (err: any) {
    return sendError(res, 500, 'SLACK_DISCONNECT_FAILED', err.message);
  }
}

apiRouter.post('/slack/disconnect', requireAuth, handleDisconnectSlack);
apiRouter.post('/integrations/slack/disconnect', requireAuth, handleDisconnectSlack);

async function handleTestSlackAlert(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    const result = await sendSlackTestAlert(user.id);
    if (!result.ok) {
      return sendError(
        res,
        400,
        'SLACK_ALERT_NOT_DELIVERED',
        result.error || 'Slack is not connected or test alert failed'
      );
    }
    return res.json({
      ok: true,
      success: true,
      delivered: true,
      sent: true,
    });
  } catch (err: any) {
    return sendError(res, 500, 'SLACK_TEST_FAILED', err.message);
  }
}

apiRouter.post('/slack/test', requireAuth, handleTestSlackAlert);
apiRouter.post('/integrations/slack/test-alert', requireAuth, handleTestSlackAlert);

// ============================================================================
// 3. Senders & SMTP Diagnostics (Prompt 6)
// ============================================================================

apiRouter.get('/senders', requireAuth, async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const sendersRes = await db.execute(
      'SELECT id, userId, email, displayName, smtpHost, smtpPort, smtpUser, isActive, createdAt FROM senders WHERE isActive = 1 ORDER BY createdAt ASC'
    );
    res.json(sendersRes.rows);
  } catch (err: any) {
    sendError(res, 500, 'SENDERS_FETCH_FAILED', err.message);
  }
});

apiRouter.post('/senders', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const displayName =
      typeof req.body?.displayName === 'string' && req.body.displayName.trim()
        ? req.body.displayName.trim()
        : undefined;
    const created = await createEtherealSender(user.id, displayName);
    const { smtpPassEncrypted: _omit, ...safeSender } = created;
    res.status(201).json(safeSender);
  } catch (err: any) {
    sendError(res, 500, 'SENDER_CREATE_FAILED', err.message);
  }
});

apiRouter.get('/smtp/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const diag = await getSmtpDiagnostics(user.id);
    res.json(diag);
  } catch (err: any) {
    sendError(res, 500, 'SMTP_STATUS_FAILED', err.message);
  }
});

apiRouter.post('/smtp/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const senderId = typeof req.body?.senderId === 'string' ? req.body.senderId : undefined;
    const verification = await verifySenderSmtpConnection(senderId);
    res.status(verification.ok ? 200 : 502).json(verification);
  } catch (err: any) {
    sendError(res, 500, 'SMTP_VERIFY_FAILED', err.message);
  }
});

apiRouter.post('/senders/:id/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!VALID_ID_REGEX.test(id)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid sender ID format');
    }
    const verification = await verifySenderSmtpConnection(id);
    res.status(verification.ok ? 200 : 502).json(verification);
  } catch (err: any) {
    sendError(res, 500, 'SMTP_VERIFY_FAILED', err.message);
  }
});

// ============================================================================
// 4. CSV Parsing & Campaign Scheduling (Prompts 5, 16, 18)
// ============================================================================

apiRouter.post('/campaigns/parse-csv', requireAuth, async (req: Request, res: Response) => {
  try {
    const csvText = typeof req.body?.csvText === 'string' ? req.body.csvText : '';
    if (csvText.length > 5 * 1024 * 1024) {
      return sendError(res, 413, 'CSV_LIMIT_EXCEEDED', 'CSV payload exceeds maximum allowed size (5MB)');
    }
    const maxLeads = Number(req.body?.maxLeads || req.body?.maxRecipients || config.MAX_LEADS_PER_REQUEST);
    const parsed = parseLeadsCsvText(csvText, { maxLeads });
    return res.json(parsed);
  } catch (err: any) {
    return sendError(res, 400, 'CSV_PARSE_FAILED', err.message || 'Failed to parse CSV');
  }
});

async function handleScheduleCampaign(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    const body = req.body || {};

    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const emailBody = typeof body.body === 'string' ? body.body : '';

    if (!subject) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Email subject is required');
    }
    if (subject.length > 500) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Email subject cannot exceed 500 characters');
    }
    if (!emailBody || !emailBody.trim()) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Email body is required');
    }
    if (emailBody.length > 100_000) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Email body exceeds maximum allowed size (100KB)');
    }

    const rawLeadsInput = body.leads ?? body.rawLeads ?? body.recipients;
    const rawCsvInput = body.rawCsv ?? body.csvText;
    const leadRecords = Array.isArray(body.leadRecords) ? body.leadRecords : undefined;

    if (rawLeadsInput !== undefined && !Array.isArray(rawLeadsInput)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'leads must be an array of recipient email strings');
    }

    const rawStartAt = body.startAt ?? body.startTime;
    let startAtIso: string | undefined;
    if (rawStartAt !== undefined && rawStartAt !== null && rawStartAt !== '') {
      const parsedDate =
        typeof rawStartAt === 'number' ? new Date(rawStartAt) : new Date(String(rawStartAt));
      if (isNaN(parsedDate.getTime())) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid startAt timestamp or ISO-8601 date string');
      }
      startAtIso = parsedDate.toISOString();
    }

    const delayBetweenMs =
      body.delayBetweenMs !== undefined ? Number(body.delayBetweenMs) : undefined;
    if (delayBetweenMs !== undefined && (isNaN(delayBetweenMs) || delayBetweenMs < 0 || delayBetweenMs > 86_400_000)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'delayBetweenMs must be a number between 0 and 86400000');
    }

    const hourlyLimit =
      body.hourlyLimit !== undefined ? Number(body.hourlyLimit) : undefined;
    if (hourlyLimit !== undefined && (!Number.isInteger(hourlyLimit) || hourlyLimit < 1 || hourlyLimit > 50_000)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'hourlyLimit must be an integer between 1 and 50000');
    }

    const headerKey =
      (req.headers['idempotency-key'] as string) ||
      (req.headers['x-idempotency-key'] as string);
    const idempotencyKey =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : headerKey;

    const result = await scheduleCampaign({
      userId: user.id,
      name: typeof body.name === 'string' ? body.name : undefined,
      subject,
      body: emailBody,
      rawLeads: Array.isArray(rawLeadsInput) ? rawLeadsInput : undefined,
      rawCsv: typeof rawCsvInput === 'string' ? rawCsvInput : undefined,
      leadRecords,
      startAtIso,
      delayBetweenMs,
      hourlyLimit,
      idempotencyKey,
    });

    return res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err: any) {
    return sendError(res, 400, 'SCHEDULE_FAILED', err.message || 'Failed to schedule campaign');
  }
}

apiRouter.post('/campaigns/schedule', requireAuth, handleScheduleCampaign);
apiRouter.post('/campaigns', requireAuth, handleScheduleCampaign);

apiRouter.get('/campaigns', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const pagination = parsePaginationQuery(req, 10);
    if (!pagination.valid) {
      return sendError(res, 400, 'VALIDATION_ERROR', pagination.error || 'Invalid pagination parameters');
    }

    const db = getDb();
    const offset = (pagination.page - 1) * pagination.size;

    const countRes = await db.execute({
      sql: 'SELECT COUNT(*) as cnt FROM campaigns WHERE userId = ?',
      args: [user.id],
    });
    const total = Number(countRes.rows[0]?.cnt || 0);

    const rowsRes = await db.execute({
      sql: `
        SELECT c.*,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'SENT') as sentCount,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'SCHEDULED') as scheduledCount,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'FAILED') as failedCount
        FROM campaigns c
        WHERE c.userId = ?
        ORDER BY c.createdAt DESC
        LIMIT ? OFFSET ?
      `,
      args: [user.id, pagination.size, offset],
    });

    const items = rowsRes.rows as unknown as CampaignRow[];
    return res.json({
      ...buildPaginatedResponse(items, pagination.page, pagination.size, total),
      campaigns: items,
    });
  } catch (err: any) {
    return sendError(res, 500, 'CAMPAIGNS_FETCH_FAILED', err.message);
  }
});

apiRouter.get('/campaigns/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const { id } = req.params;
    if (!VALID_ID_REGEX.test(id)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid campaign ID format');
    }

    const db = getDb();
    const campaignRes = await db.execute({
      sql: `
        SELECT c.*,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'SENT') as sentCount,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'SCHEDULED') as scheduledCount,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'FAILED') as failedCount,
          (SELECT COUNT(*) FROM emails e WHERE e.campaignId = c.id AND e.status = 'CANCELLED') as cancelledCount
        FROM campaigns c
        WHERE c.id = ? AND c.userId = ?
      `,
      args: [id, user.id],
    });

    if (campaignRes.rows.length === 0) {
      return sendError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }

    return res.json({ campaign: campaignRes.rows[0] });
  } catch (err: any) {
    return sendError(res, 500, 'CAMPAIGN_DETAIL_FAILED', err.message);
  }
});

// ============================================================================
// 5. Emails Listing, Search, Attempt Audit, Cancel & Retry (Prompts 7, 13, 17, 18)
// ============================================================================

apiRouter.get('/emails/scheduled', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const sortBy = ((req.query.sortBy as string) || 'scheduledAt') as SearchSortField;
    const sortOrder = ((req.query.sortOrder as string) || 'asc').toLowerCase() as 'asc' | 'desc';

    if (!VALID_SORT_FIELDS.includes(sortBy)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid sortBy field "${sortBy}"`);
    }
    if (!VALID_SORT_ORDERS.includes(sortOrder)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid sortOrder "${sortOrder}"`);
    }

    const pagination = parsePaginationQuery(req, 10);
    if (!pagination.valid) {
      return sendError(res, 400, 'VALIDATION_ERROR', pagination.error || 'Invalid pagination parameters');
    }

    if (q) {
      const searchResult = await searchEmails({
        userId: user.id,
        query: q,
        status: 'SCHEDULED',
        page: pagination.page,
        pageSize: pagination.size,
        sortBy,
        sortOrder,
      });
      return res.json(searchResult);
    }

    const db = getDb();
    const offset = (pagination.page - 1) * pagination.size;

    const countRes = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM emails WHERE userId = ? AND status IN ('SCHEDULED', 'PROCESSING')`,
      args: [user.id],
    });
    const total = Number(countRes.rows[0]?.cnt || 0);

    const orderDir = sortOrder === 'desc' ? 'DESC' : 'ASC';
    const rowsRes = await db.execute({
      sql: `
        SELECT e.*, s.email as senderEmail, s.displayName as senderName
        FROM emails e
        LEFT JOIN senders s ON e.senderId = s.id
        WHERE e.userId = ? AND e.status IN ('SCHEDULED', 'PROCESSING')
        ORDER BY e.scheduledAt ${orderDir}, e.sequence ASC
        LIMIT ? OFFSET ?
      `,
      args: [user.id, pagination.size, offset],
    });

    const items = rowsRes.rows as unknown as EmailRow[];
    return res.json(buildPaginatedResponse(items, pagination.page, pagination.size, total));
  } catch (err: any) {
    return sendError(res, 500, 'SCHEDULED_EMAILS_FAILED', err.message);
  }
});

apiRouter.get('/emails/sent', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rawStatus = ((req.query.status as string) || 'ALL').toUpperCase();
    const sortBy = ((req.query.sortBy as string) || 'sentAt') as SearchSortField;
    const sortOrder = ((req.query.sortOrder as string) || 'desc').toLowerCase() as 'asc' | 'desc';

    if (!['ALL', 'SENT', 'FAILED', 'CANCELLED'].includes(rawStatus)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid status filter "${rawStatus}"`);
    }
    if (!VALID_SORT_FIELDS.includes(sortBy)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid sortBy field "${sortBy}"`);
    }
    if (!VALID_SORT_ORDERS.includes(sortOrder)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid sortOrder "${sortOrder}"`);
    }

    const pagination = parsePaginationQuery(req, 10);
    if (!pagination.valid) {
      return sendError(res, 400, 'VALIDATION_ERROR', pagination.error || 'Invalid pagination parameters');
    }

    const db = getDb();
    const offset = (pagination.page - 1) * pagination.size;

    let whereSql = `WHERE e.userId = ?`;
    const args: any[] = [user.id];

    if (rawStatus === 'ALL') {
      whereSql += ` AND e.status IN ('SENT', 'FAILED')`;
    } else {
      whereSql += ` AND e.status = ?`;
      args.push(rawStatus);
    }

    if (q) {
      const escaped = q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const likeArg = `%${escaped}%`;
      whereSql += ` AND (LOWER(e.toEmail) LIKE ? ESCAPE '\\' OR LOWER(e.subject) LIKE ? ESCAPE '\\' OR LOWER(e.body) LIKE ? ESCAPE '\\')`;
      args.push(likeArg, likeArg, likeArg);
    }

    const countRes = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM emails e ${whereSql}`,
      args,
    });
    const total = Number(countRes.rows[0]?.cnt || 0);

    const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const rowsRes = await db.execute({
      sql: `
        SELECT e.*, s.email as senderEmail, s.displayName as senderName
        FROM emails e
        LEFT JOIN senders s ON e.senderId = s.id
        ${whereSql}
        ORDER BY COALESCE(e.sentAt, e.failedAt, e.updatedAt) ${orderDir}
        LIMIT ? OFFSET ?
      `,
      args: [...args, pagination.size, offset],
    });

    const items = rowsRes.rows as unknown as EmailRow[];
    return res.json(buildPaginatedResponse(items, pagination.page, pagination.size, total));
  } catch (err: any) {
    return sendError(res, 500, 'SENT_EMAILS_FAILED', err.message);
  }
});

apiRouter.get('/emails/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const q = (req.query.q as string) || '';
    const status = ((req.query.status as string) || 'ALL').toUpperCase();
    const sortBy = ((req.query.sortBy as string) || 'scheduledAt') as SearchSortField;
    const sortOrder = ((req.query.sortOrder as string) || 'desc').toLowerCase() as 'asc' | 'desc';

    if (!VALID_EMAIL_STATUSES.includes(status as any)) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        `Invalid status filter "${status}". Allowed: ${VALID_EMAIL_STATUSES.join(', ')}`
      );
    }
    if (!VALID_SORT_FIELDS.includes(sortBy)) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        `Invalid sortBy "${sortBy}". Allowed: ${VALID_SORT_FIELDS.join(', ')}`
      );
    }
    if (!VALID_SORT_ORDERS.includes(sortOrder)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid sortOrder. Allowed: asc, desc');
    }

    const pagination = parsePaginationQuery(req, 20);
    if (!pagination.valid) {
      return sendError(res, 400, 'VALIDATION_ERROR', pagination.error || 'Invalid pagination parameters');
    }

    const results = await searchEmails({
      userId: user.id,
      query: q,
      status,
      page: pagination.page,
      pageSize: pagination.size,
      sortBy,
      sortOrder,
    });

    return res.json(results);
  } catch (err: any) {
    return sendError(res, 500, 'SEARCH_FAILED', err.message);
  }
});

apiRouter.get('/search/status', requireAuth, async (_req: Request, res: Response) => {
  try {
    const esHealthy = await checkElasticsearchHealth();
    const diag = await getSearchDiagnostics();
    return res.json({ ...diag, esHealthy });
  } catch (err: any) {
    return sendError(res, 500, 'SEARCH_STATUS_FAILED', err.message);
  }
});

apiRouter.post('/search/reindex', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const outboxRep = await reconcileSearchIndex();
    const userRep = await reindexUserEmails(user.id);
    return res.json({
      ok: true,
      outboxReindexed: outboxRep.reindexed,
      ...userRep,
    });
  } catch (err: any) {
    return sendError(res, 500, 'REINDEX_FAILED', err.message);
  }
});

apiRouter.get('/emails', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const status = ((req.query.status as string) || 'ALL').toUpperCase();
    const q = (req.query.q as string) || '';
    const sortBy = ((req.query.sortBy as string) || 'scheduledAt') as SearchSortField;
    const sortOrder = ((req.query.sortOrder as string) || 'desc').toLowerCase() as 'asc' | 'desc';

    if (!VALID_EMAIL_STATUSES.includes(status as any)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid status filter "${status}"`);
    }
    if (!VALID_SORT_FIELDS.includes(sortBy)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid sortBy "${sortBy}"`);
    }
    if (!VALID_SORT_ORDERS.includes(sortOrder)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid sortOrder');
    }

    const pagination = parsePaginationQuery(req, 20);
    if (!pagination.valid) {
      return sendError(res, 400, 'VALIDATION_ERROR', pagination.error || 'Invalid pagination parameters');
    }

    const results = await searchEmails({
      userId: user.id,
      query: q,
      status,
      page: pagination.page,
      pageSize: pagination.size,
      sortBy,
      sortOrder,
    });
    return res.json(results);
  } catch (err: any) {
    return sendError(res, 500, 'EMAILS_FETCH_FAILED', err.message);
  }
});

async function handleGetEmailDetailAndAttempts(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    const { id } = req.params;
    if (!VALID_ID_REGEX.test(id)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid email ID format');
    }

    const db = getDb();
    const emailRes = await db.execute({
      sql: `
        SELECT e.*, s.email as senderEmail, s.displayName as senderName
        FROM emails e
        LEFT JOIN senders s ON e.senderId = s.id
        WHERE e.id = ? AND e.userId = ?
      `,
      args: [id, user.id],
    });

    if (emailRes.rows.length === 0) {
      return sendError(res, 404, 'EMAIL_NOT_FOUND', 'Email record not found');
    }

    const attemptsRes = await db.execute({
      sql: 'SELECT * FROM send_attempts WHERE emailId = ? ORDER BY attemptNumber ASC',
      args: [id],
    });

    const eventsRes = await db.execute({
      sql: 'SELECT * FROM email_events WHERE emailId = ? AND userId = ? ORDER BY createdAt ASC',
      args: [id, user.id],
    });

    return res.json({
      email: emailRes.rows[0],
      attempts: attemptsRes.rows,
      sendAttempts: attemptsRes.rows,
      events: eventsRes.rows,
    });
  } catch (err: any) {
    return sendError(res, 500, 'EMAIL_DETAIL_FAILED', err.message);
  }
}

apiRouter.get('/emails/:id', requireAuth, handleGetEmailDetailAndAttempts);
apiRouter.get('/emails/:id/attempts', requireAuth, handleGetEmailDetailAndAttempts);

apiRouter.post('/emails/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const { id } = req.params;
    if (!VALID_ID_REGEX.test(id)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid email ID format');
    }

    const db = getDb();
    const existingRes = await db.execute({
      sql: 'SELECT * FROM emails WHERE id = ? AND userId = ?',
      args: [id, user.id],
    });

    if (existingRes.rows.length === 0) {
      return sendError(res, 404, 'EMAIL_NOT_FOUND', 'Scheduled email not found');
    }

    const emailRow = existingRes.rows[0] as unknown as EmailRow;
    if (emailRow.status !== 'SCHEDULED') {
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Cannot cancel email in status ${emailRow.status}. Only SCHEDULED emails can be cancelled.`
      );
    }

    const now = Date.now();
    await db.execute({
      sql: `UPDATE emails SET status = 'CANCELLED', cancelledAt = ?, updatedAt = ? WHERE id = ? AND userId = ?`,
      args: [now, now, id, user.id],
    });

    try {
      const job = await emailQueue.getJob(id);
      if (job && typeof job.remove === 'function') {
        await job.remove();
      }
    } catch {}

    await indexEmailInSearch({
      ...emailRow,
      status: 'CANCELLED',
      cancelledAt: now,
    });

    return res.json({ ok: true, success: true, id, status: 'CANCELLED' });
  } catch (err: any) {
    return sendError(res, 500, 'CANCEL_FAILED', err.message);
  }
});

apiRouter.post('/emails/:id/retry', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const { id } = req.params;
    if (!VALID_ID_REGEX.test(id)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid email ID format');
    }

    const db = getDb();
    const existingRes = await db.execute({
      sql: 'SELECT * FROM emails WHERE id = ? AND userId = ?',
      args: [id, user.id],
    });

    if (existingRes.rows.length === 0) {
      return sendError(res, 404, 'EMAIL_NOT_FOUND', 'Email not found');
    }

    const emailRow = existingRes.rows[0] as unknown as EmailRow;
    if (emailRow.status !== 'FAILED' && emailRow.status !== 'CANCELLED') {
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Cannot retry email in status ${emailRow.status}. Only FAILED or CANCELLED emails can be retried.`
      );
    }

    const now = Date.now();
    await db.execute({
      sql: `UPDATE emails 
            SET status = 'SCHEDULED', 
                scheduledAt = ?, 
                lastError = NULL, 
                failedAt = NULL, 
                cancelledAt = NULL, 
                processingStartedAt = NULL, 
                updatedAt = ? 
            WHERE id = ? AND userId = ?`,
      args: [now, now, id, user.id],
    });

    try {
      const existingJob = await emailQueue.getJob(id);
      if (existingJob && typeof existingJob.remove === 'function') {
        await existingJob.remove();
      }
    } catch {}

    await emailQueue.add('send-email', { emailId: id }, { jobId: id, delay: 0 });

    await indexEmailInSearch({
      ...emailRow,
      status: 'SCHEDULED',
      scheduledAt: now,
      lastError: null,
    });

    return res.json({ ok: true, success: true, id, status: 'SCHEDULED', scheduledAt: now });
  } catch (err: any) {
    return sendError(res, 500, 'RETRY_FAILED', err.message);
  }
});

async function handleBatchRetry(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    const db = getDb();
    const now = Date.now();

    let targetEmails: EmailRow[] = [];

    if (req.body?.emailIds !== undefined) {
      const validated = validateBatchRetryPayload(req.body.emailIds);
      if (!validated.valid) {
        return sendError(res, 400, 'VALIDATION_ERROR', validated.error || 'Invalid emailIds payload');
      }
      const placeholders = validated.cleanIds.map(() => '?').join(', ');
      const rowsRes = await db.execute({
        sql: `SELECT * FROM emails WHERE userId = ? AND id IN (${placeholders}) AND status IN ('FAILED', 'CANCELLED')`,
        args: [user.id, ...validated.cleanIds],
      });
      targetEmails = rowsRes.rows as unknown as EmailRow[];
    } else {
      const rowsRes = await db.execute({
        sql: `SELECT * FROM emails WHERE userId = ? AND status = 'FAILED' ORDER BY updatedAt DESC LIMIT 200`,
        args: [user.id],
      });
      targetEmails = rowsRes.rows as unknown as EmailRow[];
    }

    let retriedCount = 0;
    for (let i = 0; i < targetEmails.length; i++) {
      const email = targetEmails[i];
      const scheduledAt = now + i * config.MIN_DELAY_BETWEEN_EMAILS_MS;

      await db.execute({
        sql: `UPDATE emails 
              SET status = 'SCHEDULED', 
                  scheduledAt = ?, 
                  lastError = NULL, 
                  failedAt = NULL, 
                  cancelledAt = NULL, 
                  processingStartedAt = NULL, 
                  updatedAt = ? 
              WHERE id = ? AND userId = ?`,
        args: [scheduledAt, now, email.id, user.id],
      });

      try {
        const existingJob = await emailQueue.getJob(email.id);
        if (existingJob && typeof existingJob.remove === 'function') {
          await existingJob.remove();
        }
      } catch {}

      await emailQueue.add(
        'send-email',
        { emailId: email.id },
        { jobId: email.id, delay: Math.max(0, scheduledAt - now) }
      );

      await indexEmailInSearch({
        ...email,
        status: 'SCHEDULED',
        scheduledAt,
        lastError: null,
      });

      retriedCount++;
    }

    return res.json({ ok: true, success: true, retriedCount });
  } catch (err: any) {
    return sendError(res, 500, 'BATCH_RETRY_FAILED', err.message);
  }
}

apiRouter.post('/emails/batch-retry', requireAuth, handleBatchRetry);
apiRouter.post('/emails/retry-failed', requireAuth, handleBatchRetry);

// ============================================================================
// 6. Real Operational Stats, Hourly Windows, Worker Metrics & Reconcile (Prompt 17)
// ============================================================================

async function handleOverviewStats(req: Request, res: Response) {
  try {
    const user = getReqUser(req);
    const db = getDb();

    const statusRes = await db.execute({
      sql: 'SELECT status, COUNT(*) as count FROM emails WHERE userId = ? GROUP BY status',
      args: [user.id],
    });

    const counts: Record<string, number> = {
      SCHEDULED: 0,
      PROCESSING: 0,
      SENT: 0,
      FAILED: 0,
      CANCELLED: 0,
    };
    for (const r of statusRes.rows as any[]) {
      counts[r.status] = Number(r.count);
    }

    const nextSendRes = await db.execute({
      sql: `SELECT MIN(scheduledAt) as nextAt FROM emails WHERE userId = ? AND status = 'SCHEDULED'`,
      args: [user.id],
    });
    const nextSendAt = nextSendRes.rows[0]?.nextAt ? Number(nextSendRes.rows[0].nextAt) : null;

    const sendersRes = await db.execute('SELECT id FROM senders WHERE isActive = 1');
    const activeSendersCount = Math.max(1, sendersRes.rows.length);

    const now = Date.now();
    const hourStart = getWindowStartTime(getHourWindowIndex(now));
    const sentThisHourRes = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM emails WHERE userId = ? AND status = 'SENT' AND sentAt >= ?`,
      args: [user.id, hourStart],
    });
    const senderQuotaUsed = Number(sentThisHourRes.rows[0]?.cnt || 0);

    const recent24hRes = await db.execute({
      sql: `SELECT status, sentAt, failedAt, updatedAt FROM emails WHERE userId = ? AND status IN ('SENT', 'FAILED') AND updatedAt >= ?`,
      args: [user.id, now - 24 * ONE_HOUR_MS],
    });
    const trend24h = build24hDeliveryBuckets(now, recent24hRes.rows as any[]);

    const queue = await emailQueue.getJobCounts();

    return res.json({
      scheduledCount: counts.SCHEDULED + counts.PROCESSING,
      sentCount: counts.SENT,
      failedCount: counts.FAILED,
      cancelledCount: counts.CANCELLED,
      counts,
      nextSendAt,
      senderQuotaUsed,
      senderQuotaLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER * activeSendersCount,
      activeSendersCount,
      workerConcurrency: config.WORKER_CONCURRENCY,
      minDelaySec: Math.round(config.MIN_DELAY_BETWEEN_EMAILS_MS / 1000),
      queueMode: isRedisOnline() ? 'redis-bullmq' : 'embedded-fallback',
      databaseEngine: getDatabaseEngine(),
      queue,
      trend24h,
    });
  } catch (err: any) {
    return sendError(res, 500, 'STATS_OVERVIEW_FAILED', err.message);
  }
}

apiRouter.get('/stats/overview', requireAuth, handleOverviewStats);
apiRouter.get('/stats', requireAuth, handleOverviewStats);

apiRouter.get('/stats/hourly', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 6));
    const db = getDb();
    const now = Date.now();
    const baseWindow = getHourWindowIndex(now);

    const sendersRes = await db.execute('SELECT COUNT(*) as cnt FROM senders WHERE isActive = 1');
    const activeSenders = Math.max(1, Number(sendersRes.rows[0]?.cnt || 1));
    const clusterHourlyLimit = activeSenders * config.MAX_EMAILS_PER_HOUR_PER_SENDER;

    const windows = [];
    for (let i = 0; i < hours; i++) {
      const wIdx = baseWindow + i;
      const wStart = getWindowStartTime(wIdx);
      const wEnd = wStart + ONE_HOUR_MS;

      const sentRes = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM emails WHERE userId = ? AND status = 'SENT' AND sentAt >= ? AND sentAt < ?`,
        args: [user.id, wStart, wEnd],
      });
      const queuedRes = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM emails WHERE userId = ? AND status IN ('SCHEDULED', 'PROCESSING') AND scheduledAt >= ? AND scheduledAt < ?`,
        args: [user.id, wStart, wEnd],
      });

      windows.push({
        windowIndex: wIdx,
        windowStart: wStart,
        windowEnd: wEnd,
        windowLabel: new Date(wStart).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        sent: Number(sentRes.rows[0]?.cnt || 0),
        queued: Number(queuedRes.rows[0]?.cnt || 0),
        limit: clusterHourlyLimit,
      });
    }

    return res.json({ windows });
  } catch (err: any) {
    return sendError(res, 500, 'HOURLY_STATS_FAILED', err.message);
  }
});

apiRouter.get('/stats/worker-metrics', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const timeframe = (req.query.timeframe as string) === '24h' ? '24h' : (req.query.timeframe as string) === '6h' ? '6h' : '1h';
    const bucketCount = 12;
    const bucketDurationMs =
      timeframe === '24h' ? 2 * ONE_HOUR_MS : timeframe === '6h' ? 30 * 60_000 : 5 * 60_000;
    const now = Date.now();
    const startTs = now - bucketCount * bucketDurationMs;

    const db = getDb();
    const attemptsRes = await db.execute({
      sql: `
        SELECT a.startedAt, a.completedAt, a.outcome
        FROM send_attempts a
        JOIN emails e ON e.id = a.emailId
        WHERE e.userId = ? AND a.startedAt >= ?
        ORDER BY a.startedAt ASC
      `,
      args: [user.id, startTs],
    });

    const attempts = attemptsRes.rows as Array<{
      startedAt: number;
      completedAt: number | null;
      outcome: string;
    }>;

    const buckets = [];
    const allLatencies: number[] = [];
    let totalSuccess = 0;
    let totalFailed = 0;

    for (let i = 0; i < bucketCount; i++) {
      const bStart = startTs + i * bucketDurationMs;
      const bEnd = bStart + bucketDurationMs;
      const inBucket = attempts.filter(
        (a) => Number(a.startedAt) >= bStart && Number(a.startedAt) < bEnd
      );

      const latencies = inBucket
        .map((a) => Math.max(1, Number(a.completedAt || a.startedAt) - Number(a.startedAt)))
        .sort((x, y) => x - y);

      allLatencies.push(...latencies);

      const successCount = inBucket.filter((a) => a.outcome === 'SENT').length;
      const failureCount = inBucket.filter((a) => a.outcome !== 'SENT').length;
      totalSuccess += successCount;
      totalFailed += failureCount;

      const totalCount = successCount + failureCount;
      const avgLatencyMs =
        latencies.length > 0
          ? Math.round(latencies.reduce((acc, v) => acc + v, 0) / latencies.length)
          : 0;
      const p95LatencyMs =
        latencies.length > 0
          ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
          : 0;
      const failureRate =
        totalCount > 0 ? Number(((failureCount / totalCount) * 100).toFixed(1)) : 0;
      const minutesInBucket = Math.max(1, bucketDurationMs / 60_000);
      const throughputPerMin = Number((totalCount / minutesInBucket).toFixed(1));
      const isBottleneck = avgLatencyMs > 350 || failureRate > 5;

      buckets.push({
        bucketIndex: i,
        timestamp: new Date(bStart).toISOString(),
        label: new Date(bStart).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        avgLatencyMs,
        p95LatencyMs,
        successCount,
        failureCount,
        totalCount,
        failureRate,
        throughputPerMin,
        isBottleneck,
        statusNote: isBottleneck ? 'Bottleneck' : totalCount > 0 ? 'Healthy' : 'Idle Baseline',
      });
    }

    allLatencies.sort((a, b) => a - b);
    const totalProcessed = totalSuccess + totalFailed;
    const overallAvgLatency =
      allLatencies.length > 0
        ? Math.round(allLatencies.reduce((acc, v) => acc + v, 0) / allLatencies.length)
        : 0;
    const overallP95Latency =
      allLatencies.length > 0
        ? allLatencies[Math.min(allLatencies.length - 1, Math.floor(allLatencies.length * 0.95))]
        : 0;
    const overallFailureRate =
      totalProcessed > 0 ? Number(((totalFailed / totalProcessed) * 100).toFixed(1)) : 0;

    const diag = diagnoseWorkerMetrics(
      overallAvgLatency,
      overallFailureRate,
      config.WORKER_CONCURRENCY
    );

    return res.json({
      timeframe,
      summary: {
        avgLatencyMs: overallAvgLatency,
        p95LatencyMs: overallP95Latency,
        failureRate: overallFailureRate,
        totalProcessed,
        systemStatus: diag.systemStatus,
        activeWorkers: config.WORKER_CONCURRENCY,
        workerPacingSec: Math.round(config.MIN_DELAY_BETWEEN_EMAILS_MS / 1000),
        hourlyLimitPerSender: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
        diagnosis: diag.diagnosis,
      },
      buckets,
    });
  } catch (err: any) {
    return sendError(res, 500, 'WORKER_METRICS_FAILED', err.message);
  }
});

apiRouter.post('/reconcile', requireAuth, async (_req: Request, res: Response) => {
  try {
    const report = await reconcile();
    return res.json({ ok: true, report, ...report });
  } catch (err: any) {
    return sendError(res, 500, 'RECONCILE_FAILED', err.message);
  }
});

apiRouter.post('/demo/trigger-hourly-limit', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = getReqUser(req);
    const db = getDb();
    const senderRes = await db.execute('SELECT * FROM senders WHERE isActive = 1 LIMIT 1');
    const sender = senderRes.rows[0] as unknown as SenderRow | undefined;
    if (!sender) {
      return sendError(res, 404, 'NO_ACTIVE_SENDER', 'No active sender found');
    }

    const now = Date.now();
    const currentWindow = getHourWindowIndex(now);
    const nextWindowAt = getNextWindowStartTime(now);
    const limit = config.MAX_EMAILS_PER_HOUR_PER_SENDER;

    const delivered = await notifySlackHourlyLimitHit({
      userId: user.id,
      senderEmail: sender.email,
      senderId: sender.id,
      windowIndex: currentWindow,
      hourlyLimit: limit,
      nextWindowAt,
    });

    return res.json({
      triggered: true,
      senderEmail: sender.email,
      hourlyLimit: limit,
      windowIndex: currentWindow,
      nextWindowAt,
      slackDelivered: delivered,
    });
  } catch (err: any) {
    return sendError(res, 500, 'DEMO_TRIGGER_FAILED', err.message);
  }
});
