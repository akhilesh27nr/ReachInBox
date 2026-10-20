import fs from 'fs';
import path from 'path';
import { redisClient, isRedisOnline } from '../lib/redis.js';
import { config } from '../config/env.js';

let scriptSha: string | null = null;
let scriptContent: string | null = null;

export async function loadReserveSlotScript(): Promise<string> {
  if (scriptSha) return scriptSha;

  const scriptPath = path.resolve(process.cwd(), 'src/redis-scripts/reserveSlot.lua');
  if (fs.existsSync(scriptPath)) {
    scriptContent = fs.readFileSync(scriptPath, 'utf8');
  } else {
    throw new Error(`Missing required Lua rate-limit script at ${scriptPath}`);
  }

  scriptSha = await redisClient.script('LOAD', scriptContent);
  return scriptSha;
}

export interface ReservationResult {
  targetTs: number;
  limitHit: boolean;
  windowIndex: number;
  reservedCount: number;
  firstFullWindow: number;
}

/**
 * Deterministic, synchronous (atomic on Node event loop) replica of reserveSlot.lua
 * Used ONLY when ALLOW_EMBEDDED_FALLBACK=true and external Redis daemon is offline.
 */
function reserveSlotInMemory(
  slotKey: string,
  nowMs: number,
  minDelayMs: number,
  hourlyLimit: number,
  windowMs: number,
  counterPrefix: string,
  counterTtlSec: number,
  maxLookahead: number
): ReservationResult {
  if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
    throw new Error(
      'RateLimit Error: Redis is unreachable for atomic slot reservation and embedded fallback is disabled.'
    );
  }

  const baseWindow = Math.floor(nowMs / windowMs);
  const maxWindow = baseWindow + maxLookahead;

  const last = Number(redisClient._getMemoryValue(slotKey) || '0');
  let t = Math.max(nowMs, last + minDelayMs);
  let limitHit = 0;
  let firstFullWindow = -1;

  const baseCount = Number(redisClient._getMemoryValue(`${counterPrefix}${baseWindow}`) || '0');
  if (baseCount >= hourlyLimit) {
    limitHit = 1;
    firstFullWindow = baseWindow;
  }

  while (true) {
    const w = Math.floor(t / windowMs);
    if (w > maxWindow) {
      break;
    }

    const key = `${counterPrefix}${w}`;
    const c = Number(redisClient._getMemoryValue(key) || '0');

    if (c < hourlyLimit) {
      redisClient._setMemoryValue(key, String(c + 1), counterTtlSec * 1000);
      redisClient._setMemoryValue(slotKey, String(t), windowMs * 48);
      return {
        targetTs: t,
        limitHit: limitHit === 1,
        windowIndex: w,
        reservedCount: c + 1,
        firstFullWindow,
      };
    }

    if (limitHit === 0) {
      limitHit = 1;
      firstFullWindow = w;
    }
    t = (w + 1) * windowMs;
  }

  return {
    targetTs: -1,
    limitHit: limitHit === 1,
    windowIndex: -1,
    reservedCount: -1,
    firstFullWindow,
  };
}

export async function executeReserveSlot(
  senderId: string,
  nowMs: number,
  minDelayMs: number,
  hourlyLimit: number,
  maxLookahead: number = 72
): Promise<ReservationResult> {
  if (!senderId || !senderId.trim()) {
    throw new Error('senderId is required for rate-limit slot reservation');
  }
  if (minDelayMs < 0) {
    throw new Error('minDelayMs must be >= 0');
  }
  if (hourlyLimit < 1) {
    throw new Error('hourlyLimit must be >= 1');
  }

  const slotKey = `slot:{${senderId}}`;
  const counterPrefix = `rl:{${senderId}}:`;
  const windowMs = 3_600_000;
  const counterTtlSec = 10_800; // 3 hours

  if (!isRedisOnline()) {
    return reserveSlotInMemory(
      slotKey,
      nowMs,
      minDelayMs,
      hourlyLimit,
      windowMs,
      counterPrefix,
      counterTtlSec,
      maxLookahead
    );
  }

  const sha = await loadReserveSlotScript();

  try {
    const rawResult = (await redisClient.evalsha(
      sha,
      1,
      slotKey,
      nowMs.toString(),
      minDelayMs.toString(),
      hourlyLimit.toString(),
      windowMs.toString(),
      counterPrefix,
      counterTtlSec.toString(),
      maxLookahead.toString()
    )) as [number, number, number, number, number];

    return {
      targetTs: Number(rawResult[0]),
      limitHit: Number(rawResult[1]) === 1,
      windowIndex: Number(rawResult[2]),
      reservedCount: Number(rawResult[3]),
      firstFullWindow: Number(rawResult[4]),
    };
  } catch (err: any) {
    if (err.message && err.message.includes('NOSCRIPT')) {
      scriptSha = null;
      const newSha = await loadReserveSlotScript();
      const rawResult = (await redisClient.evalsha(
        newSha,
        1,
        slotKey,
        nowMs.toString(),
        minDelayMs.toString(),
        hourlyLimit.toString(),
        windowMs.toString(),
        counterPrefix,
        counterTtlSec.toString(),
        maxLookahead.toString()
      )) as [number, number, number, number, number];

      return {
        targetTs: Number(rawResult[0]),
        limitHit: Number(rawResult[1]) === 1,
        windowIndex: Number(rawResult[2]),
        reservedCount: Number(rawResult[3]),
        firstFullWindow: Number(rawResult[4]),
      };
    }

    if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
      throw err;
    }

    return reserveSlotInMemory(
      slotKey,
      nowMs,
      minDelayMs,
      hourlyLimit,
      windowMs,
      counterPrefix,
      counterTtlSec,
      maxLookahead
    );
  }
}
