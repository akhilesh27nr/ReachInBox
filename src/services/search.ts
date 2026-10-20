import { getDb, EmailRow } from '../db/db.js';
import { config } from '../config/env.js';
import { buildPaginatedResponse, PaginatedResponse } from '../types/api.js';

let esClientAvailable = false;
let esIndexEnsured = false;
let searchFetchImpl: typeof fetch = fetch;
let indexingErrorCount = 0;
let lastIndexError: string | null = null;
let lastCheckedAt: string | null = null;

export function setSearchFetchImpl(fn: typeof fetch | null): void {
  searchFetchImpl = fn || fetch;
  esIndexEnsured = false;
}

export function resetSearchDiagnostics(): void {
  indexingErrorCount = 0;
  lastIndexError = null;
  esIndexEnsured = false;
}

/**
 * Explicit Elasticsearch index mapping for emails (Prompt 13)
 */
export const EMAILS_INDEX_MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      userId: { type: 'keyword' },
      campaignId: { type: 'keyword' },
      senderId: { type: 'keyword' },
      toEmail: {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      recipientName: { type: 'text' },
      recipientCompany: { type: 'text' },
      subject: { type: 'text' },
      body: { type: 'text' },
      status: { type: 'keyword' },
      scheduledAt: { type: 'long' },
      sentAt: { type: 'long' },
      failedAt: { type: 'long' },
      cancelledAt: { type: 'long' },
      previewUrl: { type: 'keyword' },
      lastError: { type: 'text' },
      updatedAt: { type: 'long' },
    },
  },
};

export async function checkElasticsearchHealth(): Promise<boolean> {
  lastCheckedAt = new Date().toISOString();
  try {
    const res = await searchFetchImpl(`${config.ELASTICSEARCH_URL}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    esClientAvailable = res.ok;
    if (res.ok && !esIndexEnsured) {
      await ensureElasticsearchIndex().catch(() => {});
    }
    return res.ok;
  } catch (err: any) {
    esClientAvailable = false;
    return false;
  }
}

export function isElasticsearchHealthy(): boolean {
  return esClientAvailable;
}

export async function ensureElasticsearchIndex(): Promise<boolean> {
  try {
    const indexUrl = `${config.ELASTICSEARCH_URL}/${config.ES_EMAILS_INDEX}`;
    const headRes = await searchFetchImpl(indexUrl, { method: 'HEAD' });
    if (headRes.ok) {
      esIndexEnsured = true;
      esClientAvailable = true;
      return true;
    }

    const createRes = await searchFetchImpl(indexUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EMAILS_INDEX_MAPPING),
    });

    if (createRes.ok) {
      esIndexEnsured = true;
      esClientAvailable = true;
      return true;
    }

    const bodyText = await createRes.text().catch(() => '');
    if (bodyText.includes('resource_already_exists_exception')) {
      esIndexEnsured = true;
      esClientAvailable = true;
      return true;
    }

    throw new Error(`Elasticsearch index creation failed (${createRes.status})`);
  } catch (err: any) {
    esIndexEnsured = false;
    esClientAvailable = false;
    lastIndexError = err.message || 'Index creation error';
    return false;
  }
}

async function recordSearchOutboxEvent(
  emailId: string,
  doc: Record<string, any>,
  status: 'PENDING' | 'PROCESSED',
  errorMsg?: string | null
): Promise<void> {
  try {
    const db = getDb();
    const outboxId = `outbox_es_${emailId}`;
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO outbox_jobs (id, entityType, entityId, payload, status, attempts, lastError, createdAt, processedAt)
            VALUES (?, 'SEARCH_INDEX', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              payload = excluded.payload,
              status = excluded.status,
              attempts = CASE WHEN excluded.status = 'PENDING' THEN outbox_jobs.attempts + 1 ELSE outbox_jobs.attempts END,
              lastError = excluded.lastError,
              processedAt = excluded.processedAt`,
      args: [
        outboxId,
        emailId,
        JSON.stringify(doc),
        status,
        status === 'PENDING' ? 1 : 0,
        errorMsg || null,
        now,
        status === 'PROCESSED' ? now : null,
      ],
    });
  } catch {
    // Ignore if DB not initialized during unit test
  }
}

/**
 * Idempotently indexes an email document into Elasticsearch using email.id as stable _id.
 * If Elasticsearch is unavailable or fails, persists a PENDING SEARCH_INDEX outbox event
 * so updates never silently disappear and can be replayed when ES recovers.
 */
export async function indexEmailInSearch(email: Partial<EmailRow>): Promise<boolean> {
  if (!email.id) return false;

  const doc = {
    id: email.id,
    userId: email.userId,
    campaignId: email.campaignId,
    senderId: email.senderId,
    toEmail: email.toEmail,
    recipientName: email.recipientName || null,
    recipientCompany: email.recipientCompany || null,
    subject: email.subject,
    body: email.body,
    status: email.status,
    scheduledAt: email.scheduledAt,
    sentAt: email.sentAt ?? null,
    failedAt: email.failedAt ?? null,
    cancelledAt: email.cancelledAt ?? null,
    previewUrl: email.previewUrl ?? null,
    lastError: email.lastError ?? null,
    updatedAt: Date.now(),
  };

  try {
    if (!esIndexEnsured) {
      await ensureElasticsearchIndex();
    }

    const url = `${config.ELASTICSEARCH_URL}/${config.ES_EMAILS_INDEX}/_doc/${encodeURIComponent(email.id)}`;
    const res = await searchFetchImpl(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });

    if (!res.ok) {
      throw new Error(`Elasticsearch PUT _doc returned HTTP ${res.status}`);
    }

    esClientAvailable = true;
    await recordSearchOutboxEvent(email.id, doc, 'PROCESSED', null);
    return true;
  } catch (err: any) {
    esClientAvailable = false;
    indexingErrorCount++;
    lastIndexError = err.message || 'Elasticsearch indexing failed';
    await recordSearchOutboxEvent(email.id, doc, 'PENDING', lastIndexError);
    return false;
  }
}

/**
 * Replays any PENDING SEARCH_INDEX outbox events into Elasticsearch.
 */
export async function reconcileSearchIndex(): Promise<{
  reindexed: number;
  failed: number;
  esHealthy: boolean;
}> {
  const healthy = await checkElasticsearchHealth();
  if (!healthy) {
    return { reindexed: 0, failed: 0, esHealthy: false };
  }

  const db = getDb();
  const pendingRes = await db.execute({
    sql: `SELECT id, entityId FROM outbox_jobs WHERE entityType = 'SEARCH_INDEX' AND status = 'PENDING' LIMIT 500`,
  });

  let reindexed = 0;
  let failed = 0;

  for (const row of pendingRes.rows) {
    const emailRes = await db.execute({
      sql: 'SELECT * FROM emails WHERE id = ?',
      args: [row.entityId],
    });
    if (emailRes.rows.length === 0) {
      await db.execute({
        sql: `UPDATE outbox_jobs SET status = 'PROCESSED', processedAt = ? WHERE id = ?`,
        args: [Date.now(), row.id],
      });
      continue;
    }

    const ok = await indexEmailInSearch(emailRes.rows[0] as unknown as EmailRow);
    if (ok) {
      reindexed++;
    } else {
      failed++;
    }
  }

  return { reindexed, failed, esHealthy: esClientAvailable };
}

/**
 * Full reindex of a user's persisted emails from the relational database into Elasticsearch.
 */
export async function reindexUserEmails(userId?: string): Promise<{
  total: number;
  indexed: number;
  failed: number;
  esHealthy: boolean;
}> {
  const db = getDb();
  const res = userId
    ? await db.execute({ sql: 'SELECT * FROM emails WHERE userId = ?', args: [userId] })
    : await db.execute('SELECT * FROM emails');

  let indexed = 0;
  let failed = 0;
  for (const row of res.rows) {
    const ok = await indexEmailInSearch(row as unknown as EmailRow);
    if (ok) indexed++;
    else failed++;
  }

  return {
    total: res.rows.length,
    indexed,
    failed,
    esHealthy: esClientAvailable,
  };
}

export async function getSearchDiagnostics() {
  let pendingOutboxCount = 0;
  try {
    const db = getDb();
    const res = await db.execute(
      `SELECT COUNT(*) as cnt FROM outbox_jobs WHERE entityType = 'SEARCH_INDEX' AND status = 'PENDING'`
    );
    pendingOutboxCount = Number(res.rows[0]?.cnt || 0);
  } catch {}

  return {
    configuredUrl: config.ELASTICSEARCH_URL,
    indexName: config.ES_EMAILS_INDEX,
    esHealthy: esClientAvailable,
    searchMode: esClientAvailable ? 'elasticsearch' : 'database-fallback',
    pendingOutboxCount,
    indexingErrorCount,
    lastIndexError,
    lastCheckedAt,
  };
}

function escapeSqlLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type SearchSortField = 'scheduledAt' | 'sentAt' | 'createdAt' | 'toEmail' | 'status';

export interface SearchOptions {
  userId: string;
  query?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sortBy?: SearchSortField;
  sortOrder?: 'asc' | 'desc';
}

const ALLOWED_SORT_COLUMNS: Record<SearchSortField, string> = {
  scheduledAt: 'scheduledAt',
  sentAt: 'sentAt',
  createdAt: 'createdAt',
  toEmail: 'toEmail',
  status: 'status',
};

export async function searchEmails(options: SearchOptions): Promise<PaginatedResponse<EmailRow>> {
  const {
    userId,
    query,
    status,
    page = 1,
    pageSize = 20,
    sortBy = 'scheduledAt',
    sortOrder = 'desc',
  } = options;

  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
  const offset = (safePage - 1) * safeSize;
  const safeSortField: SearchSortField = ALLOWED_SORT_COLUMNS[sortBy] ? sortBy : 'scheduledAt';
  const safeSortOrder: 'asc' | 'desc' = sortOrder === 'asc' ? 'asc' : 'desc';

  let fallbackReason: string | null = esClientAvailable ? null : 'Elasticsearch unreachable; using relational database search';

  // 1. Try Elasticsearch first if healthy
  if (esClientAvailable) {
    try {
      const filterClauses: any[] = [{ term: { userId } }];
      const mustClauses: any[] = [];

      if (status && status !== 'ALL') {
        filterClauses.push({ term: { status } });
      }
      if (query && query.trim()) {
        mustClauses.push({
          multi_match: {
            query: query.trim(),
            fields: ['toEmail^3', 'subject^2', 'body', 'recipientName', 'recipientCompany'],
            fuzziness: 'AUTO',
          },
        });
      }

      const sortFieldEs = safeSortField === 'toEmail' ? 'toEmail.keyword' : safeSortField;

      const esRes = await searchFetchImpl(
        `${config.ELASTICSEARCH_URL}/${config.ES_EMAILS_INDEX}/_search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: offset,
            size: safeSize,
            query: {
              bool: {
                filter: filterClauses,
                must: mustClauses.length > 0 ? mustClauses : [{ match_all: {} }],
              },
            },
            sort: [{ [sortFieldEs]: { order: safeSortOrder } }],
          }),
        }
      );

      if (esRes.ok) {
        const data = (await esRes.json()) as any;
        const hits = data.hits?.hits || [];
        // Enforce strict userId ownership filter on returned documents as defense-in-depth
        const emails = hits
          .map((h: any) => h._source as EmailRow)
          .filter((doc: EmailRow) => doc && doc.userId === userId);
        const total =
          typeof data.hits?.total?.value === 'number' ? data.hits.total.value : emails.length;

        return buildPaginatedResponse(emails, safePage, safeSize, total, {
          source: 'elasticsearch',
          esHealthy: true,
          fallbackReason: null,
        });
      } else {
        esClientAvailable = false;
        fallbackReason = `Elasticsearch returned HTTP ${esRes.status}`;
      }
    } catch (err: any) {
      esClientAvailable = false;
      fallbackReason = err.message || 'Elasticsearch query error';
    }
  }

  // 2. Observable Database Fallback (user-scoped, special-character safe)
  const db = getDb();
  let whereSql = 'WHERE userId = ?';
  const args: any[] = [userId];

  if (status && status !== 'ALL') {
    whereSql += ' AND status = ?';
    args.push(status);
  }

  if (query && query.trim()) {
    const escaped = escapeSqlLike(query.trim().toLowerCase());
    const qLike = `%${escaped}%`;
    whereSql += ` AND (LOWER(toEmail) LIKE ? ESCAPE '\\' OR LOWER(subject) LIKE ? ESCAPE '\\' OR LOWER(body) LIKE ? ESCAPE '\\')`;
    args.push(qLike, qLike, qLike);
  }

  const countRes = await db.execute({
    sql: `SELECT COUNT(*) as cnt FROM emails ${whereSql}`,
    args,
  });
  const total = Number(countRes.rows[0]?.cnt || 0);

  const sortCol = ALLOWED_SORT_COLUMNS[safeSortField];
  const orderDir = safeSortOrder === 'asc' ? 'ASC' : 'DESC';

  const listRes = await db.execute({
    sql: `SELECT * FROM emails ${whereSql} ORDER BY ${sortCol} ${orderDir}, createdAt DESC LIMIT ? OFFSET ?`,
    args: [...args, safeSize, offset],
  });

  const emails = listRes.rows as unknown as EmailRow[];

  return buildPaginatedResponse(emails, safePage, safeSize, total, {
    source: 'database',
    esHealthy: false,
    fallbackReason,
  });
}
