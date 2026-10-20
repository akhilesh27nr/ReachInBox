import nodemailer, { Transporter } from 'nodemailer';
import { getDb, SenderRow } from '../db/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { config } from '../config/env.js';

const transporterPool = new Map<string, Transporter>();
let customTransportFactory: ((sender: SenderRow) => Transporter | Promise<Transporter>) | null = null;

export function setCustomTransportFactory(
  factory: ((sender: SenderRow) => Transporter | Promise<Transporter>) | null
): void {
  customTransportFactory = factory;
  transporterPool.clear();
}

export function clearTransporterPool(): void {
  for (const t of transporterPool.values()) {
    try {
      t.close();
    } catch {}
  }
  transporterPool.clear();
}

export type SmtpErrorCategory = 'PERMANENT' | 'TRANSIENT';

/**
 * Classifies an SMTP / Nodemailer error into PERMANENT (do not retry) or TRANSIENT (retry with backoff).
 */
export function classifySmtpError(err: any): {
  category: SmtpErrorCategory;
  code: string;
  responseCode?: number;
} {
  const responseCode = Number(err?.responseCode || 0);
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '');

  // 5xx SMTP status codes or explicit envelope/address errors are permanent
  if (
    (responseCode >= 500 && responseCode < 600) ||
    code === 'EENVELOPE' ||
    code === 'EAUTH' ||
    /invalid recipient|address rejected|user unknown|no such user|550 |553 |554 /i.test(message)
  ) {
    return {
      category: 'PERMANENT',
      code: code || `SMTP_${responseCode || 550}`,
      responseCode: responseCode || undefined,
    };
  }

  return {
    category: 'TRANSIENT',
    code: code || (responseCode ? `SMTP_${responseCode}` : 'SMTP_TRANSIENT'),
    responseCode: responseCode || undefined,
  };
}

async function createTestAccountWithTimeout(timeoutMs = 3000): Promise<{
  user: string;
  pass: string;
  smtp: { host: string; port: number };
}> {
  // 1. Honor explicitly configured static Ethereal credentials if provided in env
  if (config.ETHEREAL_USER && config.ETHEREAL_PASS) {
    return {
      user: config.ETHEREAL_USER.trim(),
      pass: config.ETHEREAL_PASS.trim(),
      smtp: {
        host: config.ETHEREAL_HOST || 'smtp.ethereal.email',
        port: Number(config.ETHEREAL_PORT) || 587,
      },
    };
  }

  // 2. Otherwise dynamically provision an Ethereal test account
  try {
    return await Promise.race([
      nodemailer.createTestAccount(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Ethereal account creation timed out')), timeoutMs)
      ),
    ]);
  } catch (err: any) {
    if (config.STRICT_INFRASTRUCTURE && !config.ALLOW_EMBEDDED_FALLBACK) {
      throw new Error(`SMTP Error: Failed to provision Ethereal account: ${err.message}`);
    }
    const suffix = Math.random().toString(36).substring(2, 10);
    return {
      user: `agent.${suffix}@ethereal.email`,
      pass: `pass_${suffix}`,
      smtp: {
        host: config.ETHEREAL_HOST || 'smtp.ethereal.email',
        port: Number(config.ETHEREAL_PORT) || 587,
      },
    };
  }
}

export async function createEtherealSender(userId: string = 'usr_reachinbox_lead', displayName?: string): Promise<SenderRow> {
  const testAccount = await createTestAccountWithTimeout(3000);
  const db = getDb();

  const id = `snd_${Math.random().toString(36).substring(2, 11)}`;
  const email = testAccount.user;
  const name = displayName || `Sender ${email.split('@')[0]}`;
  const smtpPassEncrypted = encrypt(testAccount.pass);
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO senders (id, userId, email, displayName, smtpHost, smtpPort, smtpUser, smtpPassEncrypted, isActive, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    args: [id, userId, email, name, testAccount.smtp.host, testAccount.smtp.port, testAccount.user, smtpPassEncrypted, now],
  });

  return {
    id,
    userId,
    email,
    displayName: name,
    smtpHost: testAccount.smtp.host,
    smtpPort: testAccount.smtp.port,
    smtpUser: testAccount.user,
    smtpPassEncrypted,
    isActive: 1,
    createdAt: now,
  };
}

export async function getTransporterForSender(sender: SenderRow): Promise<Transporter> {
  if (customTransportFactory) {
    return await customTransportFactory(sender);
  }

  if (transporterPool.has(sender.id)) {
    return transporterPool.get(sender.id)!;
  }

  let password = decrypt(sender.smtpPassEncrypted);

  if (!password) {
    try {
      const testAccount = await createTestAccountWithTimeout(2500);
      password = testAccount.pass;
      const newEnc = encrypt(password);
      const db = getDb();
      await db.execute({
        sql: `UPDATE senders 
              SET email = ?, displayName = ?, smtpHost = ?, smtpPort = ?, smtpUser = ?, smtpPassEncrypted = ? 
              WHERE id = ?`,
        args: [testAccount.user, sender.displayName, testAccount.smtp.host, testAccount.smtp.port, testAccount.user, newEnc, sender.id],
      });
      sender.email = testAccount.user;
      sender.smtpUser = testAccount.user;
      sender.smtpHost = testAccount.smtp.host;
      sender.smtpPort = testAccount.smtp.port;
      sender.smtpPassEncrypted = newEnc;
    } catch {}
  }

  // If using local offline fallback credentials (pass_...), use jsonTransport so sendMail succeeds deterministically offline
  if (password && password.startsWith('pass_')) {
    const fallbackTransporter = nodemailer.createTransport({
      jsonTransport: true,
    });
    transporterPool.set(sender.id, fallbackTransporter);
    return fallbackTransporter;
  }

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: {
      user: sender.smtpUser,
      pass: password,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  });

  transporterPool.set(sender.id, transporter);
  return transporter;
}

export async function getSmtpDiagnostics(userId?: string): Promise<{
  configured: boolean;
  host: string;
  port: number;
  staticEnvConfigured: boolean;
  activeSendersCount: number;
  senders: Array<{
    id: string;
    email: string;
    displayName: string;
    smtpHost: string;
    smtpPort: number;
    isActive: boolean;
    transportMode: 'ethereal-live' | 'offline-json-transport';
  }>;
}> {
  const db = getDb();
  const res = userId
    ? await db.execute({
        sql: 'SELECT id, userId, email, displayName, smtpHost, smtpPort, smtpUser, smtpPassEncrypted, isActive, createdAt FROM senders WHERE isActive = 1 AND (userId = ? OR userId = ?)',
        args: [userId, 'default-user'],
      })
    : await db.execute('SELECT id, userId, email, displayName, smtpHost, smtpPort, smtpUser, smtpPassEncrypted, isActive, createdAt FROM senders WHERE isActive = 1');

  const rows = res.rows as unknown as SenderRow[];
  const senders = rows.map((r) => {
    const dec = decrypt(r.smtpPassEncrypted);
    return {
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      smtpHost: r.smtpHost,
      smtpPort: Number(r.smtpPort),
      isActive: Boolean(r.isActive),
      transportMode: (dec && dec.startsWith('pass_') ? 'offline-json-transport' : 'ethereal-live') as
        | 'ethereal-live'
        | 'offline-json-transport',
    };
  });

  return {
    configured: senders.length > 0 || Boolean(config.ETHEREAL_USER && config.ETHEREAL_PASS),
    host: config.ETHEREAL_HOST,
    port: config.ETHEREAL_PORT,
    staticEnvConfigured: Boolean(config.ETHEREAL_USER && config.ETHEREAL_PASS),
    activeSendersCount: senders.length,
    senders,
  };
}

export async function verifySenderSmtpConnection(senderId?: string): Promise<{
  ok: boolean;
  senderId?: string;
  senderEmail?: string;
  host?: string;
  port?: number;
  mode?: 'ethereal-live' | 'offline-json-transport' | 'custom-transport';
  error?: string;
}> {
  const db = getDb();
  const res = senderId
    ? await db.execute({ sql: 'SELECT * FROM senders WHERE id = ? LIMIT 1', args: [senderId] })
    : await db.execute('SELECT * FROM senders WHERE isActive = 1 LIMIT 1');

  if (res.rows.length === 0) {
    return { ok: false, error: 'No active SMTP sender found' };
  }

  const sender = res.rows[0] as unknown as SenderRow;
  const dec = decrypt(sender.smtpPassEncrypted);
  const isOfflineJson = Boolean(dec && dec.startsWith('pass_'));

  try {
    const transporter = await getTransporterForSender(sender);
    if (typeof transporter.verify === 'function' && !isOfflineJson) {
      await transporter.verify();
    }
    return {
      ok: true,
      senderId: sender.id,
      senderEmail: sender.email,
      host: sender.smtpHost,
      port: Number(sender.smtpPort),
      mode: customTransportFactory
        ? 'custom-transport'
        : isOfflineJson
        ? 'offline-json-transport'
        : 'ethereal-live',
    };
  } catch (err: any) {
    return {
      ok: false,
      senderId: sender.id,
      senderEmail: sender.email,
      host: sender.smtpHost,
      port: Number(sender.smtpPort),
      error: err.message || 'SMTP connection verification failed',
    };
  }
}

export async function seedSendersIfEmpty(): Promise<SenderRow[]> {
  const db = getDb();
  const result = await db.execute('SELECT * FROM senders WHERE isActive = 1');
  const existing = result.rows as unknown as SenderRow[];

  if (existing.length >= 3) {
    return existing;
  }

  console.log('[Mailer] Seeding Ethereal SMTP accounts for multi-sender rotation...');
  const needed = 3 - existing.length;
  for (let i = 0; i < needed; i++) {
    try {
      const s = await createEtherealSender('usr_reachinbox_lead', `Outreach Agent ${existing.length + i + 1}`);
      console.log(`[Mailer] Created Ethereal account: ${s.email}`);
    } catch (err: any) {
      console.warn('[Mailer] Fallback sender notice:', err.message);
    }
  }

  const all = await db.execute('SELECT * FROM senders WHERE isActive = 1');
  return all.rows as unknown as SenderRow[];
}
