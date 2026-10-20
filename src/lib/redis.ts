import Redis from 'ioredis';
import net from 'net';
import { config } from '../config/env.js';

let redisOnline = false;
let checkedOnce = false;

// In-memory store used ONLY when ALLOW_EMBEDDED_FALLBACK=true and external Redis daemon is offline
const memoryStore = new Map<string, { value: string; expiresAt?: number }>();

function getMemoryValue(key: string): string | null {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

function setMemoryValue(key: string, value: string, ttlMs?: number): void {
  const expiresAt = ttlMs ? Date.now() + ttlMs : undefined;
  memoryStore.set(key, { value: String(value), expiresAt });
}

function assertFallbackPermitted(operation: string): void {
  if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
    throw new Error(
      `Redis Error: Redis is offline during ${operation} and embedded fallback is disabled (STRICT_INFRASTRUCTURE=true / ALLOW_EMBEDDED_FALLBACK=false).`
    );
  }
}

/**
 * Fast TCP probe to check if Redis port is listening before attaching BullMQ/ioredis
 */
export async function checkRedisTcp(urlStr = config.REDIS_URL, timeoutMs = 350): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname || '127.0.0.1';
    const port = Number(parsed.port) || 6379;

    return await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(ok);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  } catch {
    return false;
  }
}

export async function ensureRedisReady(options?: {
  strictInfrastructure?: boolean;
  allowEmbeddedFallback?: boolean;
}): Promise<boolean> {
  const strict = options?.strictInfrastructure ?? config.STRICT_INFRASTRUCTURE;
  const allowFallback = strict ? false : (options?.allowEmbeddedFallback ?? config.ALLOW_EMBEDDED_FALLBACK);

  if (!checkedOnce || options) {
    checkedOnce = true;
    redisOnline = await checkRedisTcp(config.REDIS_URL, 350);
    if (redisOnline) {
      try {
        await redisConnection.connect().catch(() => {});
        await rawRedisClient.connect().catch(() => {});
        const pong = await rawRedisClient.ping();
        redisOnline = pong === 'PONG';
      } catch {
        redisOnline = false;
      }
    }
  }

  if (!redisOnline && !allowFallback) {
    throw new Error(
      'Redis Error: Required Redis service is unreachable and ALLOW_EMBEDDED_FALLBACK is false.'
    );
  }

  return redisOnline;
}

export function isRedisOnline(): boolean {
  return redisOnline;
}

export const redisConnection = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableOfflineQueue: false,
  retryStrategy: (times) => {
    if (!redisOnline || times > 2) return null;
    return Math.min(times * 200, 1000);
  },
});

export const rawRedisClient = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => {
    if (!redisOnline || times > 2) return null;
    return Math.min(times * 200, 1000);
  },
});

redisConnection.on('error', () => {});
rawRedisClient.on('error', () => {});

export const redisClient = {
  async ping(): Promise<string> {
    if (redisOnline) {
      return await rawRedisClient.ping();
    }
    assertFallbackPermitted('ping');
    return 'PONG';
  },

  async get(key: string): Promise<string | null> {
    if (redisOnline) {
      return await rawRedisClient.get(key);
    }
    assertFallbackPermitted('get');
    return getMemoryValue(key);
  },

  async set(key: string, value: string | number, ...args: any[]): Promise<string | null> {
    if (redisOnline) {
      return await (rawRedisClient.set as any)(key, String(value), ...args);
    }
    assertFallbackPermitted('set');
    const mode = typeof args[0] === 'string' ? args[0].toUpperCase() : undefined;
    const duration = typeof args[1] === 'number' ? args[1] : undefined;
    const flag = typeof args[2] === 'string' ? args[2].toUpperCase() : undefined;

    if (flag === 'NX' && getMemoryValue(key) !== null) {
      return null;
    }

    let ttlMs: number | undefined;
    if (mode === 'PX' && duration) ttlMs = duration;
    else if (mode === 'EX' && duration) ttlMs = duration * 1000;

    setMemoryValue(key, String(value), ttlMs);
    return 'OK';
  },

  async incr(key: string): Promise<number> {
    if (redisOnline) {
      return await rawRedisClient.incr(key);
    }
    assertFallbackPermitted('incr');
    const current = Number(getMemoryValue(key) || '0') + 1;
    const existing = memoryStore.get(key);
    memoryStore.set(key, { value: String(current), expiresAt: existing?.expiresAt });
    return current;
  },

  async expire(key: string, seconds: number): Promise<number> {
    if (redisOnline) {
      return await rawRedisClient.expire(key, seconds);
    }
    assertFallbackPermitted('expire');
    const existing = memoryStore.get(key);
    if (existing) {
      existing.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    return 0;
  },

  async del(...keys: string[]): Promise<number> {
    if (redisOnline) {
      return await rawRedisClient.del(...keys);
    }
    assertFallbackPermitted('del');
    let count = 0;
    for (const k of keys) {
      if (memoryStore.delete(k)) count++;
    }
    return count;
  },

  async script(subcommand: string, scriptBody: string): Promise<string> {
    if (redisOnline) {
      return (await rawRedisClient.script(subcommand as any, scriptBody)) as string;
    }
    assertFallbackPermitted('script');
    return 'in_memory_lua_sha_1';
  },

  async evalsha(sha: string, numKeys: number, ...args: string[]): Promise<any> {
    if (redisOnline) {
      return await (rawRedisClient.evalsha as any)(sha, numKeys, ...args);
    }
    assertFallbackPermitted('evalsha');
    throw new Error('FALLBACK_TO_MEMORY_RESERVE');
  },

  async quit(): Promise<string> {
    if (redisOnline) {
      try {
        await rawRedisClient.quit();
        await redisConnection.quit();
      } catch {}
    }
    return 'OK';
  },

  _getMemoryValue: getMemoryValue,
  _setMemoryValue: setMemoryValue,
  _clearMemory(): void {
    memoryStore.clear();
  },
};

export async function pingRedis(strict = config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK): Promise<boolean> {
  if (strict && !redisOnline) {
    return false;
  }
  try {
    const pong = await redisClient.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
