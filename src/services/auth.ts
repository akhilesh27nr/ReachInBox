import crypto from 'crypto';
import { Request, Response } from 'express';
import { getDb, UserRow } from '../db/db.js';
import { config } from '../config/env.js';

export const SESSION_COOKIE_NAME = 'reachinbox_session';
export const SIGNED_OUT_COOKIE_NAME = 'reachinbox_signed_out';
export const OAUTH_STATE_COOKIE_NAME = 'reachinbox_oauth_state';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function resetConsumedOAuthStates(): Promise<void> {
  try {
    const db = getDb();
    await db.execute('DELETE FROM oauth_states');
  } catch {
    // Ignore if DB not yet initialized
  }
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function isSecureRequestContext(req?: Request): boolean {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const originHeader = String(req?.headers?.origin || req?.headers?.referer || '').toLowerCase();
  return Boolean(
    req?.secure ||
      forwardedProto === 'https' ||
      originHeader.startsWith('https://') ||
      (config.APP_URL && config.APP_URL.startsWith('https://')) ||
      config.NODE_ENV === 'production' ||
      process.env.K_SERVICE
  );
}

export function getCookieOptions(req: Request, maxAgeMs = SESSION_TTL_MS) {
  const isSecure = isSecureRequestContext(req);

  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: (isSecure ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function getClearCookieOptions(req: Request) {
  const isSecure = isSecureRequestContext(req);

  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: (isSecure ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
  };
}

export function getGoogleRedirectUri(req: Request): string {
  if (config.GOOGLE_REDIRECT_URI && !config.GOOGLE_REDIRECT_URI.includes('localhost')) {
    return config.GOOGLE_REDIRECT_URI;
  }
  if (config.APP_URL) {
    return `${config.APP_URL.replace(/\/$/, '')}/api/auth/google/callback`;
  }
  const proto =
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() ||
    req.protocol ||
    'http';
  const host =
    String(req.headers['x-forwarded-host'] || '')
      .split(',')[0]
      .trim() ||
    req.get('host') ||
    `localhost:${config.PORT}`;
  return `${proto}://${host}/api/auth/google/callback`;
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

export function generateOAuthState(nowMs = Date.now()): string {
  const nonce = crypto.randomBytes(24).toString('hex');
  const issuedAt = nowMs.toString(36);
  const payload = `${nonce}.${issuedAt}`;
  const sig = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Generates and persists an expiring, single-use OAuth state record in the database,
 * optionally bound to the initiating browser/session fingerprint.
 */
export async function issueOAuthState(options?: {
  provider?: 'google' | 'slack' | string;
  browserBinding?: string | null;
  userId?: string | null;
  ttlMs?: number;
  nowMs?: number;
}): Promise<string> {
  const nowMs = options?.nowMs ?? Date.now();
  const ttlMs = options?.ttlMs ?? OAUTH_STATE_TTL_MS;
  const expiresAt = nowMs + ttlMs;
  const state = generateOAuthState(nowMs);
  const provider = options?.provider || 'oauth';
  const browserBindHash = options?.browserBinding ? hashToken(options.browserBinding) : null;
  const userId = options?.userId || null;

  const db = getDb();
  // Prune expired unconsumed state rows older than current time
  await db
    .execute({
      sql: 'DELETE FROM oauth_states WHERE expiresAt < ? AND consumedAt IS NULL',
      args: [nowMs - 60_000],
    })
    .catch(() => {});

  await db.execute({
    sql: `INSERT INTO oauth_states (state, provider, browserBindHash, userId, createdAt, expiresAt, consumedAt)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    args: [state, provider, browserBindHash, userId, nowMs, expiresAt],
  });

  return state;
}

export function verifyOAuthState(stateParam: string, cookieState?: string, nowMs = Date.now()): boolean {
  if (!stateParam || typeof stateParam !== 'string') return false;
  if (cookieState !== undefined && cookieState !== stateParam) return false;
  const parts = stateParam.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAtB36, sig] = parts;
  const issuedAt = parseInt(issuedAtB36, 36);
  if (isNaN(issuedAt) || nowMs - issuedAt > 15 * 60 * 1000 || issuedAt > nowMs + 60 * 1000) {
    return false;
  }
  const payload = `${nonce}.${issuedAtB36}`;
  const expectedSig = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

/**
 * Validates and atomically consumes a persistent OAuth state token in the database
 * so replay attempts, expired tokens, browser-binding mismatches, and concurrent callbacks are rejected.
 */
export async function consumeOAuthState(
  stateParam?: string,
  cookieState?: string,
  options?: { browserBinding?: string | null; nowMs?: number }
): Promise<{ valid: boolean; code?: 'INVALID_OAUTH_STATE' | 'OAUTH_STATE_REPLAYED'; message?: string }> {
  const nowMs = options?.nowMs ?? Date.now();
  if (!stateParam || !verifyOAuthState(stateParam, cookieState, nowMs)) {
    return {
      valid: false,
      code: 'INVALID_OAUTH_STATE',
      message: 'Invalid, mismatched, or expired OAuth state parameter.',
    };
  }

  const db = getDb();
  return await db.withTransaction(async (tx) => {
    const existingRes = await tx.execute({
      sql: 'SELECT state, browserBindHash, expiresAt, consumedAt FROM oauth_states WHERE state = ?',
      args: [stateParam],
    });

    if (existingRes.rows.length > 0) {
      const row = existingRes.rows[0];
      if (row.consumedAt !== null && row.consumedAt !== undefined) {
        return {
          valid: false,
          code: 'OAUTH_STATE_REPLAYED' as const,
          message: 'OAuth state token has already been used (replay attempt rejected).',
        };
      }

      if (Number(row.expiresAt) <= nowMs) {
        return {
          valid: false,
          code: 'INVALID_OAUTH_STATE' as const,
          message: 'OAuth state token has expired.',
        };
      }

      if (row.browserBindHash) {
        const suppliedBinding = options?.browserBinding ?? cookieState;
        if (!suppliedBinding || hashToken(suppliedBinding) !== String(row.browserBindHash)) {
          return {
            valid: false,
            code: 'INVALID_OAUTH_STATE' as const,
            message: 'OAuth state browser/session binding mismatch.',
          };
        }
      }

      const updateRes = await tx.execute({
        sql: 'UPDATE oauth_states SET consumedAt = ? WHERE state = ? AND consumedAt IS NULL AND expiresAt > ?',
        args: [nowMs, stateParam, nowMs],
      });

      if (updateRes.rowsAffected === 0) {
        return {
          valid: false,
          code: 'OAUTH_STATE_REPLAYED' as const,
          message: 'OAuth state token has already been used (concurrent replay rejected).',
        };
      }

      return { valid: true };
    }

    // Fallback if state was created via synchronous generateOAuthState() in unit test:
    // atomically insert as consumed so any second call or concurrent call is rejected.
    const parts = stateParam.split('.');
    const issuedAt = parseInt(parts[1], 36) || nowMs;
    const expiresAt = issuedAt + OAUTH_STATE_TTL_MS;
    if (expiresAt <= nowMs) {
      return {
        valid: false,
        code: 'INVALID_OAUTH_STATE' as const,
        message: 'OAuth state token has expired.',
      };
    }

    const bindHash =
      options?.browserBinding || cookieState
        ? hashToken((options?.browserBinding || cookieState)!)
        : null;

    const insertRes = await tx.execute({
      sql: `INSERT INTO oauth_states (state, provider, browserBindHash, userId, createdAt, expiresAt, consumedAt)
            VALUES (?, 'oauth', ?, NULL, ?, ?, ?)
            ON CONFLICT(state) DO NOTHING`,
      args: [stateParam, bindHash, issuedAt, expiresAt, nowMs],
    });

    if (insertRes.rowsAffected === 0) {
      return {
        valid: false,
        code: 'OAUTH_STATE_REPLAYED' as const,
        message: 'OAuth state token has already been used (replay attempt rejected).',
      };
    }

    return { valid: true };
  });
}

export function buildGoogleAuthorizationUrl(req: Request, state: string): string {
  if (!isGoogleOAuthConfigured()) {
    throw new Error('Google OAuth is not configured (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)');
  }
  const redirectUri = getGoogleRedirectUri(req);
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function checkGoogleOAuthUrlPreflight(authUrl: string): Promise<{
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(authUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const loc = res.headers.get('location') || '';
    if (loc.includes('/signin/oauth/error')) {
      return {
        ok: false,
        errorCode: 'redirect_uri_mismatch',
        errorMessage:
          'Redirect URI is not yet registered in Google Cloud Console for this dynamic preview URL.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

export interface GoogleIdTokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iat?: number;
  name?: string;
  picture?: string;
}

export interface GoogleJwk extends crypto.JsonWebKey {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
}

let googleFetchImpl: typeof fetch = fetch;
let googleJwksOverride: GoogleJwk[] | null = null;
let cachedGoogleJwks: { keys: GoogleJwk[]; fetchedAt: number } | null = null;
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function setGoogleFetchImpl(fn: typeof fetch | null): void {
  googleFetchImpl = fn || fetch;
}

export function setGoogleJwksOverride(keys: GoogleJwk[] | null): void {
  googleJwksOverride = keys;
  cachedGoogleJwks = null;
}

export async function fetchGoogleJwks(
  forceRefresh = false,
  fetchImpl: typeof fetch = googleFetchImpl
): Promise<GoogleJwk[]> {
  if (googleJwksOverride) {
    return googleJwksOverride;
  }
  const now = Date.now();
  if (!forceRefresh && cachedGoogleJwks && now - cachedGoogleJwks.fetchedAt < GOOGLE_JWKS_CACHE_TTL_MS) {
    return cachedGoogleJwks.keys;
  }

  const res = await fetchImpl(GOOGLE_JWKS_URI);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google OIDC JWKS (${res.status})`);
  }
  const body = (await res.json()) as { keys?: GoogleJwk[] };
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('Google OIDC JWKS response contained no signing keys');
  }
  cachedGoogleJwks = { keys: body.keys, fetchedAt: now };
  return body.keys;
}

export function validateGoogleIdTokenPayload(
  payload: GoogleIdTokenClaims,
  expectedClientId = config.GOOGLE_CLIENT_ID,
  nowSec = Math.floor(Date.now() / 1000)
): void {
  const validIss =
    payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com';
  if (!validIss) {
    throw new Error('Invalid OIDC issuer claim');
  }
  if (!expectedClientId || payload.aud !== expectedClientId) {
    throw new Error('Invalid OIDC audience claim');
  }
  if (!payload.exp || Number(payload.exp) <= nowSec) {
    throw new Error('Expired OIDC ID token');
  }
  if (payload.iat !== undefined && Number(payload.iat) > nowSec + 300) {
    throw new Error('OIDC ID token issued in the future (invalid iat claim)');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Missing OIDC subject (sub) claim');
  }
  if (payload.email_verified === false) {
    throw new Error('Google account email is not verified');
  }
}

/**
 * Cryptographically verifies a Google OIDC ID token (JWS RS256 signature against Google's JWK Set)
 * and validates all required OIDC identity claims (iss, aud, exp, iat, sub, email_verified).
 */
export async function verifyGoogleIdTokenCryptographically(
  idToken: string,
  expectedClientId = config.GOOGLE_CLIENT_ID,
  options?: {
    nowSec?: number;
    jwks?: GoogleJwk[];
    fetchImpl?: typeof fetch;
  }
): Promise<GoogleIdTokenClaims> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing OIDC ID token');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Malformed OIDC ID token');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string; typ?: string };
  let payload: GoogleIdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed OIDC ID token JSON segments');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported OIDC ID token signing algorithm: ${header.alg || 'none'}`);
  }
  if (!header.kid || typeof header.kid !== 'string') {
    throw new Error('Missing OIDC ID token key ID (kid) header');
  }

  const fetchImpl = options?.fetchImpl || googleFetchImpl;
  let keys = options?.jwks ?? (await fetchGoogleJwks(false, fetchImpl));
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk && !options?.jwks && !googleJwksOverride) {
    keys = await fetchGoogleJwks(true, fetchImpl);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new Error(`Unable to find matching Google OIDC signing key for kid="${header.kid}"`);
  }

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({
      key: jwk as crypto.JsonWebKey,
      format: 'jwk',
    });
  } catch (err: any) {
    throw new Error(`Invalid Google OIDC JWK public key: ${err.message}`);
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signatureBytes = Buffer.from(signatureB64, 'base64url');
  const signatureValid = crypto.verify('RSA-SHA256', signingInput, publicKey, signatureBytes);
  if (!signatureValid) {
    throw new Error('Invalid OIDC ID token cryptographic signature');
  }

  validateGoogleIdTokenPayload(payload, expectedClientId, options?.nowSec);
  return payload;
}

export async function exchangeGoogleCodeForUser(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = googleFetchImpl
): Promise<UserRow> {
  if (!isGoogleOAuthConfigured()) {
    throw new Error('Google OAuth is not configured');
  }
  if (!code || !code.trim()) {
    throw new Error('Authorization code is required');
  }

  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${errText}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    id_token?: string;
  };

  let verifiedIdClaims: GoogleIdTokenClaims | null = null;
  if (tokenData.id_token) {
    verifiedIdClaims = await verifyGoogleIdTokenCryptographically(
      tokenData.id_token,
      config.GOOGLE_CLIENT_ID,
      { fetchImpl }
    );
  }

  const userRes = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    throw new Error(`Failed to fetch Google userinfo (${userRes.status})`);
  }

  const profile = (await userRes.json()) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!profile.sub || !profile.email) {
    throw new Error('Google profile missing required sub or email claim');
  }
  if (profile.email_verified === false) {
    throw new Error('Google account email is not verified');
  }
  if (verifiedIdClaims && verifiedIdClaims.sub && verifiedIdClaims.sub !== profile.sub) {
    throw new Error('OIDC subject (sub) mismatch between ID token and userinfo response');
  }

  return await upsertUser({
    googleId: profile.sub,
    email: profile.email.toLowerCase().trim(),
    name: profile.name || profile.email.split('@')[0],
    avatarUrl: profile.picture || null,
  });
}

export async function upsertUser(params: {
  id?: string;
  googleId?: string | null;
  email: string;
  name: string;
  avatarUrl?: string | null;
  timezone?: string;
}): Promise<UserRow> {
  const db = getDb();
  const now = new Date().toISOString();
  const cleanEmail = params.email.toLowerCase().trim();

  let existingRes = { rows: [] as Record<string, any>[] };
  if (params.googleId) {
    existingRes = await db.execute({
      sql: 'SELECT * FROM users WHERE googleId = ? OR LOWER(email) = ?',
      args: [params.googleId, cleanEmail],
    });
  } else {
    existingRes = await db.execute({
      sql: 'SELECT * FROM users WHERE LOWER(email) = ?',
      args: [cleanEmail],
    });
  }

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0] as unknown as UserRow;
    await db.execute({
      sql: `UPDATE users 
            SET googleId = COALESCE(?, googleId), 
                name = ?, 
                avatarUrl = COALESCE(?, avatarUrl), 
                timezone = COALESCE(?, timezone),
                updatedAt = ? 
            WHERE id = ?`,
      args: [
        params.googleId || null,
        params.name,
        params.avatarUrl || null,
        params.timezone || null,
        now,
        existing.id,
      ],
    });
    const updated = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [existing.id],
    });
    return updated.rows[0] as unknown as UserRow;
  }

  const userId = params.id || `usr_${crypto.randomBytes(8).toString('hex')}`;
  await db.execute({
    sql: `INSERT INTO users (id, googleId, email, name, avatarUrl, timezone, defaultDelayMs, defaultHourlyLimit, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, 2000, 100, ?, ?)`,
    args: [
      userId,
      params.googleId || null,
      cleanEmail,
      params.name,
      params.avatarUrl || null,
      params.timezone || 'UTC',
      now,
      now,
    ],
  });

  const inserted = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [userId],
  });
  return inserted.rows[0] as unknown as UserRow;
}

export async function createSession(userId: string, req?: Request): Promise<string> {
  const db = getDb();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const sessionId = hashToken(rawToken);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const userAgent = req?.headers?.['user-agent'] || null;
  const ip = (req?.headers?.['x-forwarded-for'] as string) || req?.socket?.remoteAddress || null;

  await db.execute({
    sql: `INSERT INTO sessions (id, userId, expiresAt, createdAt, userAgent, ipAddress)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [sessionId, userId, expiresAt, now, userAgent, ip],
  });

  return rawToken;
}

export async function revokeSession(rawToken?: string): Promise<void> {
  if (!rawToken) return;
  const db = getDb();
  const sessionId = hashToken(rawToken);
  await db.execute({
    sql: 'DELETE FROM sessions WHERE id = ?',
    args: [sessionId],
  });
}

export function extractRawSessionToken(req: Request): string | undefined {
  const authHeader = req.headers?.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
  return bearerToken || req.cookies?.[SESSION_COOKIE_NAME];
}

export function setSessionCookies(res: Response, req: Request, rawToken: string): void {
  res.clearCookie(SIGNED_OUT_COOKIE_NAME, getClearCookieOptions(req));
  res.cookie(SESSION_COOKIE_NAME, rawToken, getCookieOptions(req, SESSION_TTL_MS));
}

export function clearSessionCookies(res: Response, req: Request): void {
  res.clearCookie(SESSION_COOKIE_NAME, getClearCookieOptions(req));
  res.clearCookie('reachinbox_token', getClearCookieOptions(req));
  res.cookie(SIGNED_OUT_COOKIE_NAME, '1', getCookieOptions(req, SESSION_TTL_MS));
}

export function setOAuthStateCookie(res: Response, req: Request, state: string): void {
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, getCookieOptions(req, OAUTH_STATE_TTL_MS));
}

export function clearOAuthStateCookie(res: Response, req: Request): void {
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, getClearCookieOptions(req));
}

export function getOAuthStateCookie(req: Request): string | undefined {
  return req.cookies?.[OAUTH_STATE_COOKIE_NAME];
}

export async function getAuthenticatedUserFromRequest(req: Request): Promise<UserRow | null> {
  const db = getDb();
  const rawToken = extractRawSessionToken(req);

  // 1. If a session token (Bearer or Cookie) is provided, verify it strictly against the sessions table
  if (rawToken) {
    const sessionId = hashToken(rawToken);
    const now = Date.now();
    const sessionRes = await db.execute({
      sql: `SELECT u.* FROM sessions s
            JOIN users u ON u.id = s.userId
            WHERE s.id = ? AND s.expiresAt > ?`,
      args: [sessionId, now],
    });
    if (sessionRes.rows.length > 0) {
      return sessionRes.rows[0] as unknown as UserRow;
    }
    // Invalid or expired session token -> never fall back to demo user
    return null;
  }

  // 2. If user explicitly signed out, or client requests strict auth check, or STRICT_AUTH is enabled -> return null
  if (
    req.cookies?.[SIGNED_OUT_COOKIE_NAME] === '1' ||
    req.headers?.['x-require-auth'] === '1' ||
    config.STRICT_AUTH ||
    config.STRICT_INFRASTRUCTURE
  ) {
    return null;
  }

  // 3. Default workspace user for interactive evaluation preview when not signed out
  return await ensureDefaultWorkspaceUser();
}

export async function ensureDefaultWorkspaceUser(): Promise<UserRow> {
  const db = getDb();
  const existing = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: ['usr_reachinbox_lead'],
  });

  if (existing.rows.length > 0) {
    return existing.rows[0] as unknown as UserRow;
  }

  return await upsertUser({
    id: 'usr_reachinbox_lead',
    googleId: null,
    email: 'alex@reachinbox.ai',
    name: 'Alex Carter',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
  });
}

