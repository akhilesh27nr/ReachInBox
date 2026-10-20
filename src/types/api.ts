/**
 * Shared TypeScript API Contracts & Pagination Builders (Prompt 18)
 */

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  size: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  // Backward-compatible aliases for existing email table consumers
  emails?: T[];
  total?: number;
  pageSize?: number;
  source?: 'elasticsearch' | 'database';
  esHealthy?: boolean;
  fallbackReason?: string | null;
}

export function buildPaginatedResponse<T>(
  items: T[],
  page: number,
  size: number,
  totalItems: number,
  extra: Record<string, unknown> = {}
): PaginatedResponse<T> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.max(1, Math.floor(size) || 10);
  const safeTotal = Math.max(0, Math.floor(totalItems) || 0);
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / safeSize);
  const hasNext = safePage < totalPages;

  return {
    items,
    page: safePage,
    size: safeSize,
    totalItems: safeTotal,
    totalPages,
    hasNext,
    emails: items,
    total: safeTotal,
    pageSize: safeSize,
    ...extra,
  };
}

export interface SlackStatusResponse {
  connected: boolean;
  connectionType: 'OAUTH' | 'WEBHOOK' | null;
  oauthConfigured: boolean;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  status: 'CONNECTED' | 'DISCONNECTED';
  lastNotifiedAt: string | null;
  lastNotificationOutcome: string | null;
}

export interface ReadinessServiceCheck {
  healthy: boolean;
  mode: string;
  latencyMs?: number;
  message?: string;
}

export interface ReadinessResponse {
  status: 'ready' | 'degraded' | 'unhealthy';
  strictMode: boolean;
  timestamp: string;
  uptimeSec: number;
  services: {
    database: ReadinessServiceCheck;
    redis: ReadinessServiceCheck;
    worker: ReadinessServiceCheck;
    elasticsearch: ReadinessServiceCheck;
    smtp: ReadinessServiceCheck;
  };
}
