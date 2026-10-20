import { createClient, Client } from '@libsql/client';
import pg from 'pg';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';

const { Pool } = pg;

export interface DbResult {
  rows: Record<string, any>[];
  rowsAffected: number;
}

export interface RelationalAdapter {
  execute(query: string | { sql: string; args?: any[] }): Promise<DbResult>;
  executeMultiple(sqlBatch: string): Promise<void>;
  withTransaction<T>(fn: (tx: RelationalAdapter) => Promise<T>): Promise<T>;
  getEngineName(): 'postgresql' | 'sqlite-embedded';
  close(): Promise<void>;
}

let activeAdapter: RelationalAdapter | null = null;
let engineMode: 'postgresql' | 'sqlite-embedded' = 'sqlite-embedded';

// CamelCase columns that need double-quoting in PostgreSQL if written unquoted
export const CAMEL_COLUMNS = [
  'googleId',
  'avatarUrl',
  'defaultDelayMs',
  'defaultHourlyLimit',
  'createdAt',
  'updatedAt',
  'userId',
  'expiresAt',
  'userAgent',
  'ipAddress',
  'displayName',
  'smtpHost',
  'smtpPort',
  'smtpUser',
  'smtpPassEncrypted',
  'hourlyQuota',
  'isActive',
  'teamId',
  'teamName',
  'channelId',
  'channelName',
  'webhookUrlEncrypted',
  'botTokenEncrypted',
  'lastNotifiedAt',
  'lastNotificationOutcome',
  'connectedAt',
  'disconnectedAt',
  'startAt',
  'delayBetweenMs',
  'hourlyLimit',
  'totalCount',
  'validCount',
  'duplicateCount',
  'invalidCount',
  'idempotencyKey',
  'campaignId',
  'senderId',
  'toEmail',
  'recipientName',
  'recipientCompany',
  'recipientJobTitle',
  'scheduledAt',
  'originalScheduledAt',
  'lastAttemptAt',
  'sentAt',
  'failedAt',
  'cancelledAt',
  'rescheduleCount',
  'rescheduledReason',
  'messageId',
  'previewUrl',
  'lastError',
  'processingStartedAt',
  'emailId',
  'attemptNumber',
  'startedAt',
  'completedAt',
  'smtpResponse',
  'errorMessage',
  'entityType',
  'entityId',
  'processedAt',
  'senderEmail',
  'senderName',
  'browserBindHash',
  'consumedAt',
  'dedupeKey',
  'windowIndex',
];

export function translateSqlForPostgres(sql: string): string {
  let idx = 0;
  let translated = sql.replace(/\?/g, () => `$${++idx}`);
  for (const col of CAMEL_COLUMNS) {
    const regex = new RegExp(`(?<!")\\b${col}\\b(?!")`, 'g');
    translated = translated.replace(regex, `"${col}"`);
  }
  return translated;
}

export async function checkPostgresTcp(urlStr: string, timeoutMs = 350): Promise<boolean> {
  if (!urlStr.startsWith('postgres://') && !urlStr.startsWith('postgresql://')) {
    return false;
  }
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname || '127.0.0.1';
    const port = Number(parsed.port) || 5432;

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

export function createSqliteAdapter(fileUrl: string): RelationalAdapter {
  const client: Client = createClient({ url: fileUrl });
  client.execute('PRAGMA busy_timeout = 5000;').catch(() => {});
  let txChain = Promise.resolve();

  async function withBusyRetry<T>(op: () => Promise<T>, maxRetries = 25): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await op();
      } catch (err: any) {
        const isBusy =
          err?.code === 'SQLITE_BUSY' ||
          String(err?.message || '').includes('SQLITE_BUSY') ||
          String(err?.message || '').includes('database is locked');
        if (isBusy && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error('SQLITE_BUSY retries exhausted');
  }

  const adapter: RelationalAdapter = {
    async execute(query) {
      return await withBusyRetry(async () => {
        const res = await client.execute(query as any);
        return {
          rows: res.rows as unknown as Record<string, any>[],
          rowsAffected: res.rowsAffected || 0,
        };
      });
    },
    async executeMultiple(sqlBatch: string) {
      await withBusyRetry(async () => {
        await client.executeMultiple(sqlBatch);
      });
    },
    async withTransaction<T>(fn: (tx: RelationalAdapter) => Promise<T>): Promise<T> {
      const runTx = async (): Promise<T> => {
        return await withBusyRetry(async () => {
          const tx = await client.transaction('write');
          const txAdapter: RelationalAdapter = {
            async execute(query) {
              const res = await tx.execute(query as any);
              return {
                rows: res.rows as unknown as Record<string, any>[],
                rowsAffected: res.rowsAffected || 0,
              };
            },
            async executeMultiple(sqlBatch: string) {
              await tx.executeMultiple(sqlBatch);
            },
            withTransaction: async (nestedFn) => nestedFn(txAdapter),
            getEngineName: () => 'sqlite-embedded',
            close: async () => {},
          };
          try {
            const result = await fn(txAdapter);
            await tx.commit();
            return result;
          } catch (err) {
            try {
              await tx.rollback();
            } catch {}
            throw err;
          } finally {
            tx.close();
          }
        });
      };

      const next = txChain.then(runTx, runTx);
      txChain = next.then(
        () => {},
        () => {}
      );
      return next;
    },
    getEngineName() {
      return 'sqlite-embedded';
    },
    async close() {
      client.close();
    },
  };

  return adapter;
}

export function createPostgresAdapter(connectionString: string): RelationalAdapter {
  const pool = new Pool({
    connectionString,
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
  });

  const adapter: RelationalAdapter = {
    async execute(query) {
      const rawSql = typeof query === 'string' ? query : query.sql;
      const args = typeof query === 'string' ? [] : query.args || [];
      const pgSql = translateSqlForPostgres(rawSql);
      const res = await pool.query(pgSql, args);
      return {
        rows: res.rows || [],
        rowsAffected: res.rowCount || 0,
      };
    },
    async executeMultiple(sqlBatch: string) {
      await pool.query(sqlBatch);
    },
    async withTransaction<T>(fn: (tx: RelationalAdapter) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const txAdapter: RelationalAdapter = {
        async execute(query) {
          const rawSql = typeof query === 'string' ? query : query.sql;
          const args = typeof query === 'string' ? [] : query.args || [];
          const pgSql = translateSqlForPostgres(rawSql);
          const res = await client.query(pgSql, args);
          return {
            rows: res.rows || [],
            rowsAffected: res.rowCount || 0,
          };
        },
        async executeMultiple(sqlBatch: string) {
          await client.query(sqlBatch);
        },
        async withTransaction(nestedFn) {
          return nestedFn(txAdapter);
        },
        getEngineName() {
          return 'postgresql';
        },
        async close() {},
      };

      try {
        await client.query('BEGIN');
        const result = await fn(txAdapter);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        throw err;
      } finally {
        client.release();
      }
    },
    getEngineName() {
      return 'postgresql';
    },
    async close() {
      await pool.end();
    },
  };

  return adapter;
}

export function getDb(): RelationalAdapter {
  if (!activeAdapter) {
    if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
      throw new Error(
        'Database Error: Database adapter accessed before initDb() completed in strict infrastructure mode.'
      );
    }
    activeAdapter = createSqliteAdapter(process.env.TEST_SQLITE_FILE || 'file:reachinbox.db');
  }
  return activeAdapter;
}

export function getDatabaseEngine(): 'postgresql' | 'sqlite-embedded' {
  return engineMode;
}

export async function closeDb(): Promise<void> {
  if (activeAdapter) {
    await activeAdapter.close();
    activeAdapter = null;
    activeSqliteUrl = null;
  }
}

let activeSqliteUrl: string | null = null;

export interface InitDbOptions {
  databaseUrl?: string;
  strictInfrastructure?: boolean;
  allowEmbeddedFallback?: boolean;
}

export async function initDb(options?: InitDbOptions): Promise<void> {
  const dbUrl = options?.databaseUrl ?? config.DATABASE_URL;
  const strict = options?.strictInfrastructure ?? config.STRICT_INFRASTRUCTURE;
  const allowFallback = strict ? false : (options?.allowEmbeddedFallback ?? config.ALLOW_EMBEDDED_FALLBACK);

  const isPostgresUrl = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');

  if (strict && !isPostgresUrl) {
    throw new Error(
      `Database Error: STRICT_INFRASTRUCTURE requires a PostgreSQL DATABASE_URL (postgresql://...), got "${dbUrl.split('@').pop()}".`
    );
  }

  if (isPostgresUrl) {
    const pgReachable = await checkPostgresTcp(dbUrl, 500);
    if (pgReachable) {
      try {
        const pgAdapter = createPostgresAdapter(dbUrl);
        const migrationPath = path.resolve(process.cwd(), 'src/db/migrations/001_initial_schema.sql');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        await pgAdapter.executeMultiple(migrationSql);
        if (activeAdapter) {
          await activeAdapter.close().catch(() => {});
        }
        activeAdapter = pgAdapter;
        activeSqliteUrl = null;
        engineMode = 'postgresql';
        console.log('[Database] Connected to PostgreSQL and applied migrations.');
        return;
      } catch (err: any) {
        if (!allowFallback) {
          throw new Error(`Database Error: Failed to initialize PostgreSQL: ${err.message}`);
        }
        console.warn('[Database] PostgreSQL initialization failed, falling back to embedded relational store:', err.message);
      }
    } else if (!allowFallback) {
      throw new Error(
        'Database Error: PostgreSQL service is unreachable and ALLOW_EMBEDDED_FALLBACK is false.'
      );
    } else {
      console.warn(
        '[Database] PostgreSQL daemon unreachable on configured port; activating explicit ALLOW_EMBEDDED_FALLBACK (sqlite-embedded).'
      );
    }
  }

  const defaultSqliteFile = process.env.TEST_SQLITE_FILE || 'file:reachinbox.db';
  const fileUrl =
    dbUrl.startsWith('file:') && dbUrl !== 'file:reachinbox.db'
      ? dbUrl
      : defaultSqliteFile;

  if (activeAdapter && engineMode === 'sqlite-embedded' && activeSqliteUrl === fileUrl) {
    return;
  }

  if (activeAdapter) {
    await activeAdapter.close().catch(() => {});
  }
  activeAdapter = createSqliteAdapter(fileUrl);
  activeSqliteUrl = fileUrl;
  engineMode = 'sqlite-embedded';

  await activeAdapter.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      googleId TEXT UNIQUE,
      email TEXT UNIQUE,
      name TEXT,
      avatarUrl TEXT,
      timezone TEXT DEFAULT 'UTC',
      defaultDelayMs INTEGER DEFAULT 2000,
      defaultHourlyLimit INTEGER DEFAULT 100,
      createdAt TEXT,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      userAgent TEXT,
      ipAddress TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId, expiresAt);

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      browserBindHash TEXT,
      userId TEXT,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      consumedAt INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expiresAt);

    CREATE TABLE IF NOT EXISTS senders (
      id TEXT PRIMARY KEY,
      userId TEXT,
      email TEXT,
      displayName TEXT,
      smtpHost TEXT,
      smtpPort INTEGER,
      smtpUser TEXT,
      smtpPassEncrypted TEXT,
      hourlyQuota INTEGER DEFAULT 200,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_senders_user ON senders(userId, isActive);

    CREATE TABLE IF NOT EXISTS slack_connections (
      id TEXT PRIMARY KEY,
      userId TEXT UNIQUE,
      teamId TEXT,
      teamName TEXT,
      channelId TEXT,
      channelName TEXT,
      webhookUrlEncrypted TEXT,
      botTokenEncrypted TEXT,
      scopes TEXT,
      status TEXT DEFAULT 'CONNECTED',
      lastNotifiedAt TEXT,
      lastNotificationOutcome TEXT,
      connectedAt TEXT,
      disconnectedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS slack_alert_dedup (
      dedupeKey TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      senderId TEXT NOT NULL,
      windowIndex INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER DEFAULT 1,
      lastError TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(userId, senderId, windowIndex)
    );

    CREATE INDEX IF NOT EXISTS idx_slack_alert_dedup_user_window ON slack_alert_dedup(userId, senderId, windowIndex);

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      userId TEXT,
      name TEXT,
      subject TEXT,
      body TEXT,
      startAt TEXT,
      delayBetweenMs INTEGER,
      hourlyLimit INTEGER,
      totalCount INTEGER,
      validCount INTEGER DEFAULT 0,
      duplicateCount INTEGER DEFAULT 0,
      invalidCount INTEGER DEFAULT 0,
      idempotencyKey TEXT,
      status TEXT DEFAULT 'ACTIVE',
      createdAt TEXT,
      updatedAt TEXT,
      UNIQUE(userId, idempotencyKey)
    );

    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      campaignId TEXT,
      userId TEXT,
      senderId TEXT,
      toEmail TEXT,
      recipientName TEXT,
      recipientCompany TEXT,
      recipientJobTitle TEXT,
      subject TEXT,
      body TEXT,
      status TEXT DEFAULT 'SCHEDULED',
      scheduledAt INTEGER,
      originalScheduledAt INTEGER,
      lastAttemptAt INTEGER,
      sentAt INTEGER,
      failedAt INTEGER,
      cancelledAt INTEGER,
      attempts INTEGER DEFAULT 0,
      rescheduleCount INTEGER DEFAULT 0,
      rescheduledReason TEXT,
      messageId TEXT,
      previewUrl TEXT,
      lastError TEXT,
      processingStartedAt INTEGER,
      sequence INTEGER,
      createdAt INTEGER,
      updatedAt INTEGER,
      UNIQUE(campaignId, toEmail)
    );

    CREATE INDEX IF NOT EXISTS idx_emails_status_sched ON emails(status, scheduledAt);
    CREATE INDEX IF NOT EXISTS idx_emails_user_status ON emails(userId, status, scheduledAt);
    CREATE INDEX IF NOT EXISTS idx_emails_sender_status ON emails(senderId, status);
    CREATE INDEX IF NOT EXISTS idx_emails_campaign ON emails(campaignId, sequence);
    CREATE INDEX IF NOT EXISTS idx_emails_recipient ON emails(userId, toEmail);

    CREATE TABLE IF NOT EXISTS send_attempts (
      id TEXT PRIMARY KEY,
      emailId TEXT NOT NULL,
      campaignId TEXT NOT NULL,
      senderId TEXT NOT NULL,
      attemptNumber INTEGER NOT NULL,
      startedAt INTEGER NOT NULL,
      completedAt INTEGER,
      outcome TEXT NOT NULL,
      smtpResponse TEXT,
      messageId TEXT,
      errorMessage TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_send_attempts_email ON send_attempts(emailId, attemptNumber);

    CREATE TABLE IF NOT EXISTS outbox_jobs (
      id TEXT PRIMARY KEY,
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      attempts INTEGER DEFAULT 0,
      lastError TEXT,
      createdAt INTEGER NOT NULL,
      processedAt INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_jobs(status, createdAt);

    CREATE TABLE IF NOT EXISTS email_events (
      id TEXT PRIMARY KEY,
      userId TEXT,
      campaignId TEXT,
      emailId TEXT,
      senderId TEXT,
      type TEXT,
      meta TEXT,
      createdAt INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_email_events_email ON email_events(emailId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_email_events_user ON email_events(userId, createdAt);
  `);

  const safeAlterStatements = [
    `ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC'`,
    `ALTER TABLE users ADD COLUMN defaultDelayMs INTEGER DEFAULT 2000`,
    `ALTER TABLE users ADD COLUMN defaultHourlyLimit INTEGER DEFAULT 100`,
    `ALTER TABLE users ADD COLUMN updatedAt TEXT`,
    `ALTER TABLE senders ADD COLUMN hourlyQuota INTEGER DEFAULT 200`,
    `ALTER TABLE slack_connections ADD COLUMN scopes TEXT`,
    `ALTER TABLE slack_connections ADD COLUMN lastNotifiedAt TEXT`,
    `ALTER TABLE slack_connections ADD COLUMN lastNotificationOutcome TEXT`,
    `ALTER TABLE campaigns ADD COLUMN name TEXT`,
    `ALTER TABLE campaigns ADD COLUMN validCount INTEGER DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN duplicateCount INTEGER DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN invalidCount INTEGER DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN updatedAt TEXT`,
    `ALTER TABLE emails ADD COLUMN recipientName TEXT`,
    `ALTER TABLE emails ADD COLUMN recipientCompany TEXT`,
    `ALTER TABLE emails ADD COLUMN recipientJobTitle TEXT`,
    `ALTER TABLE emails ADD COLUMN lastAttemptAt INTEGER`,
    `ALTER TABLE emails ADD COLUMN cancelledAt INTEGER`,
    `ALTER TABLE email_events ADD COLUMN userId TEXT`,
    `ALTER TABLE email_events ADD COLUMN campaignId TEXT`,
    `ALTER TABLE email_events ADD COLUMN senderId TEXT`,
  ];

  for (const stmt of safeAlterStatements) {
    try {
      await activeAdapter.execute(stmt);
    } catch {
      // Column already exists
    }
  }
}

export interface UserRow {
  id: string;
  googleId: string | null;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone?: string;
  defaultDelayMs?: number;
  defaultHourlyLimit?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface SenderRow {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassEncrypted: string;
  hourlyQuota?: number;
  isActive: number;
  createdAt: string;
}

export interface SlackConnectionRow {
  id: string;
  userId: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  webhookUrlEncrypted: string;
  botTokenEncrypted: string;
  scopes?: string | null;
  status: 'CONNECTED' | 'DISCONNECTED' | 'REVOKED';
  lastNotifiedAt?: string | null;
  lastNotificationOutcome?: string | null;
  connectedAt: string;
  disconnectedAt?: string | null;
}

export interface CampaignRow {
  id: string;
  userId: string;
  name?: string | null;
  subject: string;
  body: string;
  startAt: string;
  delayBetweenMs: number;
  hourlyLimit: number;
  totalCount: number;
  validCount?: number;
  duplicateCount?: number;
  invalidCount?: number;
  idempotencyKey: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PAUSED';
  createdAt: string;
  updatedAt?: string | null;
}

export interface EmailRow {
  id: string;
  campaignId: string;
  userId: string;
  senderId: string;
  toEmail: string;
  recipientName?: string | null;
  recipientCompany?: string | null;
  recipientJobTitle?: string | null;
  subject: string;
  body: string;
  status: 'SCHEDULED' | 'QUEUED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'RETRYING' | 'RESCHEDULED';
  scheduledAt: number;
  originalScheduledAt: number;
  lastAttemptAt?: number | null;
  sentAt?: number | null;
  failedAt?: number | null;
  cancelledAt?: number | null;
  attempts: number;
  rescheduleCount: number;
  rescheduledReason?: string | null;
  messageId?: string | null;
  previewUrl?: string | null;
  lastError?: string | null;
  processingStartedAt?: number | null;
  sequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface SendAttemptRow {
  id: string;
  emailId: string;
  campaignId: string;
  senderId: string;
  attemptNumber: number;
  startedAt: number;
  completedAt?: number | null;
  outcome: 'SENT' | 'FAILED' | 'AMBIGUOUS' | 'RATE_LIMITED';
  smtpResponse?: string | null;
  messageId?: string | null;
  errorMessage?: string | null;
}
