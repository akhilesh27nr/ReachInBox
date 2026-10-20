import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Send,
  Upload,
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
  Search,
  Plus,
  RefreshCw,
  Calendar,
  Activity,
  X,
  Mail,
  ArrowUpRight,
  ShieldCheck,
  Radio,
  RotateCcw,
  Eye,
  UserPlus,
  FileText
} from 'lucide-react';
import { WorkerPerformanceMetrics } from './components/WorkerPerformanceMetrics.js';
import { EmailTemplatePreviewModal } from './components/EmailTemplatePreviewModal.js';
import { VariablesHelperMenu } from './components/VariablesHelperMenu.js';
import { UserProfileMenu, WorkspaceUser } from './components/UserProfileMenu.js';
import { SystemActionsMenu } from './components/SystemActionsMenu.js';
import { DeliveryStabilitySparkline } from './components/DeliveryStabilitySparkline.js';
import { HourlyDeliveryBucket } from './lib/sparkline.js';
import { parseLeadsCsvText, ParsedLeadRecord } from './lib/csv.js';
import { SlackStatusResponse } from './types/api.js';

interface EmailItem {
  id: string;
  campaignId: string;
  toEmail: string;
  recipientName?: string | null;
  recipientCompany?: string | null;
  recipientJobTitle?: string | null;
  subject: string;
  body: string;
  status: 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
  scheduledAt: number;
  sentAt?: number | null;
  failedAt?: number | null;
  cancelledAt?: number | null;
  attempts?: number;
  rescheduleCount: number;
  rescheduledReason?: string | null;
  messageId?: string | null;
  previewUrl?: string | null;
  senderEmail?: string;
  lastError?: string | null;
}

interface SendAttemptItem {
  id: string;
  emailId: string;
  attemptNumber: number;
  startedAt: number;
  completedAt?: number | null;
  outcome: string;
  smtpResponse?: string | null;
  messageId?: string | null;
  errorMessage?: string | null;
}

interface OverviewStats {
  scheduledCount: number;
  sentCount: number;
  failedCount: number;
  nextSendAt: number | null;
  senderQuotaUsed?: number;
  senderQuotaLimit?: number;
  activeSendersCount?: number;
  workerConcurrency?: number;
  minDelaySec?: number;
  queueMode?: string;
  databaseEngine?: string;
  queue: {
    waiting: number;
    delayed: number;
    active: number;
    completed: number;
    failed: number;
  };
  trend24h?: HourlyDeliveryBucket[];
}

const INITIAL_SAMPLE_LEADS = [
  'm.spencer@outlook.com',
  'l.vance@stripe.com',
  'k.hall@segment.com',
  'a.smith@hubspot.com',
  'm.speno@stripe.com',
  'r.chen@airbnb.com',
  'd.tucker@datadog.com',
  's.patel@snowflake.com',
];

function computeStartAtIsoFromOption(option: string): string | undefined {
  const now = new Date();
  if (option === 'Immediate (Now)') {
    return now.toISOString();
  }
  if (option === 'In 5 Minutes') {
    return new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  }
  if (option === 'Today, 18:00') {
    const target = new Date(now);
    target.setHours(18, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setTime(now.getTime() + 60 * 1000);
    }
    return target.toISOString();
  }
  if (option === 'Today, 20:00') {
    const target = new Date(now);
    target.setHours(20, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setTime(now.getTime() + 2 * 60 * 1000);
    }
    return target.toISOString();
  }
  if (option === 'Tomorrow, 09:00') {
    const target = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    target.setHours(9, 0, 0, 0);
    return target.toISOString();
  }
  const parsed = new Date(option);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return undefined;
}

export default function App() {
  // Navigation & Tabs
  const [activeTab, setActiveTab] = useState<'scheduled' | 'sent'>('scheduled');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Data State
  const [scheduledEmails, setScheduledEmails] = useState<EmailItem[]>([]);
  const [sentEmails, setSentEmails] = useState<EmailItem[]>([]);
  const [scheduledTotal, setScheduledTotal] = useState(0);
  const [sentTotal, setSentTotal] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [sentFilter, setSentFilter] = useState<'ALL' | 'SENT' | 'FAILED'>('ALL');
  const [selectedFailedIds, setSelectedFailedIds] = useState<string[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);

  // User Session & Auth Menu State (Prompt 15)
  const sessionTokenRef = useRef<string | null>((() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('sessionToken') || params.get('token');
      if (urlToken && urlToken.trim()) {
        localStorage.setItem('reachinbox_session_token', urlToken.trim());
        return urlToken.trim();
      }
      return localStorage.getItem('reachinbox_session_token');
    } catch {
      return null;
    }
  })());

  const [workspaceAccounts, setWorkspaceAccounts] = useState<WorkspaceUser[]>([
    {
      id: 'usr_reachinbox_lead',
      name: 'Alex Carter',
      email: 'alex@reachinbox.ai',
      role: 'Workspace Admin',
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
    },
  ]);
  const [currentUser, setCurrentUser] = useState<WorkspaceUser | null>(() => {
    try {
      const raw = localStorage.getItem('reachinbox_user');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.email === 'string') {
          return parsed as WorkspaceUser;
        }
      }
    } catch {}
    return {
      id: 'usr_reachinbox_lead',
      name: 'Alex Carter',
      email: 'alex@reachinbox.ai',
      role: 'Workspace Admin',
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
    };
  });
  const [isSignedOut, setIsSignedOut] = useState<boolean>(false);
  const [authTab, setAuthTab] = useState<'signin' | 'signup'>('signin');
  const [googleOAuthError, setGoogleOAuthError] = useState<string | null>(null);
  const [showGoogleChooser, setShowGoogleChooser] = useState(false);
  const [googleRedirectUri, setGoogleRedirectUri] = useState('');
  const [googleAuthUrl, setGoogleAuthUrl] = useState<string | null>(null);
  const [googleCustomEmail, setGoogleCustomEmail] = useState('');
  const [googleCustomName, setGoogleCustomName] = useState('');
  const [isGoogleAuthenticating, setIsGoogleAuthenticating] = useState(false);
  const [customLoginEmail, setCustomLoginEmail] = useState('');
  const [customLoginName, setCustomLoginName] = useState('');
  const [customLoginPassword, setCustomLoginPassword] = useState('');

  // Create Account (New User) Form State
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupRole, setSignupRole] = useState('Workspace Admin');
  const [signupWorkspace, setSignupWorkspace] = useState('ReachInbox Outbound');
  const [signupProvisionSender, setSignupProvisionSender] = useState(true);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  // Theme State (Dark vs High-Contrast Light for accessibility)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('reachinbox_theme');
      return saved === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
  }, [theme]);

  // Global ⌘K / Ctrl+K shortcut to focus search bar (Prompt 17)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleToggleTheme = (newTheme: 'dark' | 'light') => {
    setTheme(newTheme);
    try {
      localStorage.setItem('reachinbox_theme', newTheme);
    } catch {}
    showToast(`Switched to ${newTheme === 'light' ? 'High-Contrast Light' : 'Dark'} Mode`);
  };

  // Pagination
  const [page, setPage] = useState(1);
  const pageSize = 10;

  // Compose Form State (Prompt 16)
  const [subject, setSubject] = useState('Partnership Inquiry - Q4');
  const [body, setBody] = useState(
    'Hi {{name}},\n\nI came across your profile at {{company}} and wanted to connect regarding scaling your outbound email infrastructure.\n\nWould you be open to a quick 10-minute chat this week to share how our distributed sender cluster maintains 99.9% deliverability?\n\nBest regards,\nAlex Carter'
  );
  const [isBodyExpanded, setIsBodyExpanded] = useState(false);
  const [rawLeads, setRawLeads] = useState<string[]>(INITIAL_SAMPLE_LEADS);
  const [leadRecords, setLeadRecords] = useState<ParsedLeadRecord[]>([]);
  const [showManualLeadsEditor, setShowManualLeadsEditor] = useState(false);
  const [manualLeadsText, setManualLeadsText] = useState(INITIAL_SAMPLE_LEADS.join('\n'));
  const [fileName, setFileName] = useState('leads_list_q4.csv');
  const [detectedCount, setDetectedCount] = useState(INITIAL_SAMPLE_LEADS.length);
  const [duplicateLeadsCount, setDuplicateLeadsCount] = useState(0);
  const [invalidLeadsCount, setInvalidLeadsCount] = useState(0);
  const [csvValidationNotes, setCsvValidationNotes] = useState<string[]>([]);
  const [startTime, setStartTime] = useState('Immediate (Now)');
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(45);
  const [draftIdempotencyKey, setDraftIdempotencyKey] = useState(
    () => `cmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  );
  const [lastScheduledSummary, setLastScheduledSummary] = useState<{
    campaignId: string;
    accepted: number;
    duplicates: number;
    invalid: number;
    delayBetweenMs: number;
    hourlyLimit: number;
    firstSendAt: string;
    estimatedDuration: string;
  } | null>(null);

  // Modals & Drawers
  const [selectedEmailDetail, setSelectedEmailDetail] = useState<{
    email: EmailItem;
    attempts: SendAttemptItem[];
  } | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [showSlackModal, setShowSlackModal] = useState(false);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [slackChannelInput, setSlackChannelInput] = useState('#rate-limits');
  const [slackStatus, setSlackStatus] = useState<SlackStatusResponse>({
    connected: false,
    connectionType: null,
    oauthConfigured: false,
    teamId: '',
    teamName: '',
    channelId: '',
    channelName: '',
    status: 'DISCONNECTED',
    lastNotifiedAt: null,
    lastNotificationOutcome: null,
  });
  const [showTimelineModal, setShowTimelineModal] = useState(false);
  const [showTemplatePreviewModal, setShowTemplatePreviewModal] = useState(false);
  const [timelineWindows, setTimelineWindows] = useState<any[]>([]);

  // Notifications
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = (msg: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastMessage(msg);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 4000);
  };

  const getActiveSessionToken = (): string | null => {
    if (sessionTokenRef.current) return sessionTokenRef.current;
    try {
      const saved = localStorage.getItem('reachinbox_session_token');
      if (saved) {
        sessionTokenRef.current = saved;
        return saved;
      }
    } catch {}
    return null;
  };

  const setStoredSessionToken = (tok: string | null) => {
    sessionTokenRef.current = tok;
    try {
      if (tok) {
        localStorage.setItem('reachinbox_session_token', tok);
      } else {
        localStorage.removeItem('reachinbox_session_token');
        localStorage.removeItem('reachinbox_user');
      }
    } catch {}
  };

  const setStoredUser = (userObj: WorkspaceUser | null) => {
    setCurrentUser(userObj);
    try {
      if (userObj) {
        localStorage.setItem('reachinbox_user', JSON.stringify(userObj));
      } else {
        localStorage.removeItem('reachinbox_user');
      }
    } catch {}
  };

  const authHeaders = (
    extra: Record<string, string> = {},
    tokenOverride?: string | null
  ): Record<string, string> => {
    const h: Record<string, string> = { ...extra };
    const activeToken = tokenOverride ?? getActiveSessionToken();
    if (activeToken) {
      h['Authorization'] = `Bearer ${activeToken}`;
    }
    return h;
  };

  const safeFetchJson = async (url: string, tokenOverride?: string | null) => {
    const res = await fetch(url, {
      credentials: 'include',
      headers: authHeaders({}, tokenOverride),
    });
    if (res.status === 401 || res.status === 403) {
      if (getActiveSessionToken()) {
        setStoredSessionToken(null);
        const retryRes = await fetch(url, { credentials: 'include' });
        const retryType = retryRes.headers.get('content-type') || '';
        if (retryRes.ok && retryType.includes('application/json')) {
          return await retryRes.json();
        }
      }
      return null;
    }
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      return await res.json();
    }
    return null;
  };

  const fetchSlackStatus = async () => {
    try {
      const data = await safeFetchJson('/api/slack/status');
      if (data && typeof data.connected === 'boolean') {
        setSlackStatus(data);
      }
    } catch {}
  };

  // Fetch overview stats and table items
  const fetchStats = async () => {
    try {
      const data = await safeFetchJson('/api/stats/overview');
      if (data) {
        setStats(data);
        setApiError(null);
      }
    } catch {}
  };

  const fetchEmails = async () => {
    setIsLoading(true);
    try {
      if (activeTab === 'scheduled') {
        const data = await safeFetchJson(
          `/api/emails/scheduled?page=${page}&size=${pageSize}&q=${encodeURIComponent(searchQuery)}`
        );
        if (data) {
          const items = data.items || data.emails || [];
          const total = data.totalItems ?? data.total ?? 0;
          setScheduledEmails(items);
          setScheduledTotal(total);
          setHasNextPage(Boolean(data.hasNext ?? total > page * pageSize));
          setTotalPages(Math.max(1, data.totalPages || Math.ceil(total / pageSize) || 1));
          setApiError(null);
        }
      } else {
        let url = `/api/emails/sent?page=${page}&size=${pageSize}&q=${encodeURIComponent(searchQuery)}`;
        if (sentFilter !== 'ALL') {
          url += `&status=${sentFilter}`;
        }
        const data = await safeFetchJson(url);
        if (data) {
          const items = data.items || data.emails || [];
          const total = data.totalItems ?? data.total ?? 0;
          setSentEmails(items);
          setSentTotal(total);
          setHasNextPage(Boolean(data.hasNext ?? total > page * pageSize));
          setTotalPages(Math.max(1, data.totalPages || Math.ceil(total / pageSize) || 1));
          setApiError(null);
        }
      }
    } catch (err: any) {
      setApiError(err.message || 'Unable to load email records');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchHourlyStats = async () => {
    try {
      const data = await safeFetchJson('/api/stats/hourly?hours=6');
      if (data) {
        setTimelineWindows(data.windows || []);
      }
    } catch {}
  };

  const handleInspectEmail = async (email: EmailItem) => {
    setIsLoadingDetail(true);
    setSelectedEmailDetail({ email, attempts: [] });
    try {
      const data = await safeFetchJson(`/api/emails/${email.id}/attempts`);
      if (data && data.email) {
        setSelectedEmailDetail({
          email: { ...email, ...data.email },
          attempts: Array.isArray(data.attempts) ? data.attempts : [],
        });
      }
    } catch {}
    setIsLoadingDetail(false);
  };

  // Load real session and Slack integration status on mount
  useEffect(() => {
    const bootstrapUserAndIntegrations = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get('sessionToken') || params.get('token');
        const isOAuthSuccess = params.get('oauth') === 'success';
        if (urlToken && urlToken.trim()) {
          setStoredSessionToken(urlToken.trim());
        }
        if (urlToken || isOAuthSuccess) {
          try {
            window.history.replaceState({}, '', window.location.pathname);
          } catch {}
        }

        const meData = await safeFetchJson('/api/me', urlToken || undefined);
        if (meData && meData.id && meData.email) {
          const hydratedUser: WorkspaceUser = {
            id: meData.id,
            name: meData.name || meData.email.split('@')[0],
            email: meData.email,
            role: meData.role || meData.timezone || 'Workspace Admin',
            avatarUrl:
              meData.avatarUrl ||
              'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
          };
          setStoredUser(hydratedUser);
          if (meData.integrations?.slack) {
            setSlackStatus(meData.integrations.slack);
          }
          if (meData.hasExplicitSession || getActiveSessionToken() || isOAuthSuccess) {
            setIsSignedOut(false);
          }
        }
        await fetchSlackStatus();
      } catch {}
    };
    bootstrapUserAndIntegrations();
  }, []);

  useEffect(() => {
    fetchStats();
    fetchEmails();
    const interval = setInterval(() => {
      fetchStats();
      fetchEmails();
    }, 10000);
    return () => clearInterval(interval);
  }, [activeTab, page, searchQuery, sentFilter]);

  // Batch and Single Retry Handlers
  const handleBatchRetry = async () => {
    if (selectedFailedIds.length === 0) {
      showToast('No failed emails selected for retry');
      return;
    }

    setIsRetrying(true);
    try {
      const res = await fetch('/api/emails/batch-retry', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ emailIds: selectedFailedIds }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to retry emails');
      }

      const data = await res.json();
      showToast(`Re-enqueued ${data.retriedCount} failed email${data.retriedCount === 1 ? '' : 's'} into delivery queue`);
      setSelectedFailedIds([]);
      fetchStats();
      fetchEmails();
    } catch (err: any) {
      showToast(`Retry error: ${err.message}`);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleSingleRetry = async (id: string) => {
    try {
      const res = await fetch(`/api/emails/${id}/retry`, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
      });
      if (res.ok) {
        showToast('Email re-enqueued into delivery queue');
        setSelectedFailedIds((prev) => prev.filter((item) => item !== id));
        fetchStats();
        fetchEmails();
      } else {
        const err = await res.json();
        showToast(err.error?.message || 'Failed to retry email');
      }
    } catch {
      showToast('Error retrying email');
    }
  };

  const failedEmailsOnPage = useMemo(() => {
    return sentEmails.filter((e) => e.status === 'FAILED');
  }, [sentEmails]);

  const areAllFailedSelected =
    failedEmailsOnPage.length > 0 && failedEmailsOnPage.every((e) => selectedFailedIds.includes(e.id));

  const toggleSelectAllFailed = () => {
    if (areAllFailedSelected) {
      const pageIds = new Set(failedEmailsOnPage.map((e) => e.id));
      setSelectedFailedIds((prev) => prev.filter((id) => !pageIds.has(id)));
    } else {
      const pageIds = failedEmailsOnPage.map((e) => e.id);
      setSelectedFailedIds((prev) => Array.from(new Set([...prev, ...pageIds])));
    }
  };

  const toggleSelectFailed = (id: string) => {
    setSelectedFailedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleInsertVariable = (tag: string, targetField: 'body' | 'subject' = 'body') => {
    if (targetField === 'subject') {
      setSubject((prev) => (prev ? `${prev} ${tag}` : tag));
    } else {
      setBody((prev) => (prev ? `${prev} ${tag}` : tag));
    }
    showToast(`Inserted ${tag} into ${targetField === 'subject' ? 'Subject' : 'Email Body'}`);
  };

  const applyParsedCsvResult = (rawText: string, sourceLabel: string) => {
    const parsed = parseLeadsCsvText(rawText, { maxLeads: 5000 });
    setRawLeads(parsed.validEmails);
    setLeadRecords(parsed.validLeads);
    setDetectedCount(parsed.validEmails.length);
    setDuplicateLeadsCount(parsed.duplicateEmails.length);
    setInvalidLeadsCount(parsed.invalidEntries.length + parsed.malformedRows.length);

    const notes: string[] = [];
    if (parsed.duplicateEmails.length > 0) {
      notes.push(`${parsed.duplicateEmails.length} duplicate email(s) deduplicated`);
    }
    if (parsed.invalidEntries.length > 0) {
      notes.push(
        `${parsed.invalidEntries.length} invalid email(s) skipped (e.g. "${parsed.invalidEntries[0]}")`
      );
    }
    if (parsed.malformedRows.length > 0) {
      notes.push(parsed.malformedRows[0]);
    }
    setCsvValidationNotes(notes);
    setDraftIdempotencyKey(`cmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);

    if (parsed.validEmails.length > 0) {
      showToast(
        `Extracted ${parsed.validEmails.length} valid recipient${
          parsed.validEmails.length === 1 ? '' : 's'
        } from ${sourceLabel}`
      );
    } else {
      showToast(`No valid email addresses found in ${sourceLabel}`);
    }
  };

  // Handle CSV file upload using RFC-4180 parser (Prompt 16)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showToast('CSV file exceeds 5MB upload limit');
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setManualLeadsText(text);
      applyParsedCsvResult(text, file.name);
    };
    reader.onerror = () => {
      showToast('Error reading uploaded CSV file');
    };
    reader.readAsText(file);
  };

  // Schedule campaign submission (Prompt 16)
  const handleScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!subject.trim()) {
      showToast('Please enter an email subject');
      return;
    }
    if (!body.trim()) {
      showToast('Please enter an email body');
      return;
    }
    if (rawLeads.length === 0) {
      showToast('Please provide at least one valid recipient email');
      return;
    }

    setIsSubmitting(true);
    try {
      const startAtIso = computeStartAtIsoFromOption(startTime);
      const res = await fetch('/api/campaigns/schedule', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': draftIdempotencyKey,
        }),
        body: JSON.stringify({
          subject: subject.trim(),
          body,
          leads: rawLeads,
          leadRecords: leadRecords.length > 0 ? leadRecords : undefined,
          startAt: startAtIso,
          delayBetweenMs: delaySeconds * 1000,
          hourlyLimit,
          idempotencyKey: draftIdempotencyKey,
        }),
      });

      if (res.status === 401) {
        setIsSignedOut(true);
        throw new Error('Authentication required. Please sign in.');
      }

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error?.message || 'Failed to schedule campaign');
      }

      const data = await res.json();
      setLastScheduledSummary({
        campaignId: data.campaignId,
        accepted: data.accepted ?? data.total,
        duplicates: Array.isArray(data.duplicates) ? data.duplicates.length : duplicateLeadsCount,
        invalid: Array.isArray(data.invalid) ? data.invalid.length : invalidLeadsCount,
        delayBetweenMs: data.delayBetweenMs ?? delaySeconds * 1000,
        hourlyLimit: data.hourlyLimit ?? hourlyLimit,
        firstSendAt: data.firstSendAt || startAtIso || new Date().toISOString(),
        estimatedDuration: data.estimatedDuration || estimate.duration,
      });
      setDraftIdempotencyKey(`cmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);
      showToast(
        `Campaign scheduled! ${data.accepted ?? data.total} jobs enqueued across ${data.estimatedWindows || 1} hour window(s)`
      );
      fetchStats();
      fetchEmails();
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Cancel scheduled email
  const handleCancelEmail = async (id: string) => {
    try {
      const res = await fetch(`/api/emails/${id}/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
      });
      if (res.ok) {
        showToast('Email job cancelled');
        fetchStats();
        fetchEmails();
      } else {
        const errData = await res.json().catch(() => ({}));
        showToast(errData.error?.message || 'Could not cancel email');
      }
    } catch {
      showToast('Failed to cancel email');
    }
  };

  // Sign Out, Sign In, Google OAuth & Create Account Handlers (Prompt 15)
  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
      });
    } catch {}
    const prevEmail = currentUser?.email || 'workspace';
    setStoredSessionToken(null);
    setCurrentUser(null);
    setSlackStatus((prev) => ({ ...prev, connected: false, status: 'DISCONNECTED', teamName: '', channelName: '' }));
    setAuthTab('signin');
    setIsSignedOut(true);
    showToast(`Signed out of ${prevEmail}`);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_chooser') === '1') {
      setShowGoogleChooser(true);
    }
    const handleOAuthMessage = async (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'OAUTH_AUTH_SUCCESS') {
        if (event.data.sessionToken) {
          setStoredSessionToken(event.data.sessionToken);
        }
        if (event.data.user) {
          setCurrentUser(event.data.user);
        }
        setShowGoogleChooser(false);
        setGoogleOAuthError(null);
        setIsSignedOut(false);
        showToast(
          `Signed in with Google as ${event.data.user?.name || event.data.user?.email || 'Workspace User'}`
        );
        await Promise.all([fetchStats(), fetchEmails(), fetchSlackStatus()]);
      } else if (event.data.type === 'OAUTH_AUTH_ERROR') {
        setShowGoogleChooser(true);
      }
    };
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, []);

  const handleGoogleAccountSelect = async (account: {
    email: string;
    name: string;
    avatarUrl?: string;
  }) => {
    setIsGoogleAuthenticating(true);
    setGoogleOAuthError(null);
    try {
      const res = await fetch('/api/auth/google/authenticate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(account),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error?.message || 'Google sign-in failed');
        return;
      }
      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      if (data.user) {
        setCurrentUser(data.user);
        setWorkspaceAccounts((prev) =>
          prev.some((a) => a.email.toLowerCase() === data.user.email.toLowerCase())
            ? prev
            : [data.user, ...prev]
        );
      }
      setShowGoogleChooser(false);
      setIsSignedOut(false);
      setGoogleCustomEmail('');
      setGoogleCustomName('');
      showToast(`Signed in with Google (${data.user?.email || account.email})`);
      await Promise.all([fetchStats(), fetchEmails(), fetchSlackStatus()]);
    } catch {
      showToast('Network error during Google sign-in');
    } finally {
      setIsGoogleAuthenticating(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleOAuthError(null);
    try {
      const res = await fetch('/api/auth/google/start?format=json&popup=1', {
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      const fallbackRedirectUri = `${window.location.origin}/auth/google/callback`;
      setGoogleRedirectUri(data.redirectUri || fallbackRedirectUri);
      setGoogleAuthUrl(data.url || null);

      if (res.ok && data.url && data.preflightOk !== false) {
        // Open provider URL directly in popup (never navigate the preview iframe!)
        const popup = window.open(
          data.url,
          'reachinbox_google_oauth',
          'width=520,height=660,menubar=no,toolbar=no,location=yes,status=no'
        );
        if (!popup) {
          setShowGoogleChooser(true);
        }
        return;
      }

      // If Google Cloud Console has not yet allowlisted the dynamic Cloud Run preview URL
      // (redirect_uri_mismatch) or OAuth credentials are not set, open the in-app Google Account Chooser
      setShowGoogleChooser(true);
    } catch {
      setGoogleRedirectUri(`${window.location.origin}/auth/google/callback`);
      setShowGoogleChooser(true);
    }
  };

  const handleSignIn = async (account: { name: string; email: string; role: string; avatarUrl: string }) => {
    setGoogleOAuthError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(account),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error?.message || 'Sign-in failed');
        return;
      }
      const data = await res.json();
      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }
      if (data.user) {
        setCurrentUser(data.user);
      } else {
        setCurrentUser({ id: 'usr_reachinbox_lead', ...account });
      }
      setIsSignedOut(false);
      setCustomLoginEmail('');
      setCustomLoginName('');
      setCustomLoginPassword('');
      showToast(`Signed in as ${data.user?.name || account.name} (${data.user?.email || account.email})`);
      await Promise.all([fetchStats(), fetchEmails(), fetchSlackStatus()]);
    } catch {
      showToast('Network error during sign in');
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = signupName.trim();
    const cleanEmail = signupEmail.trim().toLowerCase();

    if (!cleanName) {
      showToast('Please enter your full name to create an account');
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      showToast('Please enter a valid work email address');
      return;
    }

    setIsCreatingAccount(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanName,
          email: cleanEmail,
          password: signupPassword,
          role: signupRole,
          workspaceName: signupWorkspace,
          provisionSender: signupProvisionSender,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error?.message || 'Could not create account');
        return;
      }

      const data = await res.json();
      if (data.sessionToken) {
        setStoredSessionToken(data.sessionToken);
      }

      const defaultAvatar =
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80';
      const createdUser: WorkspaceUser = {
        id: data.user?.id || `usr_${Date.now().toString(36)}`,
        name: data.user?.name || cleanName,
        email: data.user?.email || cleanEmail,
        role: data.user?.role || signupRole,
        avatarUrl: data.user?.avatarUrl || defaultAvatar,
      };

      setWorkspaceAccounts((prev) => {
        const filtered = prev.filter((u) => u.email.toLowerCase() !== createdUser.email.toLowerCase());
        return [createdUser, ...filtered];
      });
      setCurrentUser(createdUser);
      setIsSignedOut(false);
      setAuthTab('signin');
      setSignupName('');
      setSignupEmail('');
      setSignupPassword('');
      showToast(`Account created! Welcome to ReachInbox, ${createdUser.name}`);
      await Promise.all([fetchStats(), fetchEmails(), fetchSlackStatus()]);
    } catch {
      showToast('Failed to create workspace account');
    } finally {
      setIsCreatingAccount(false);
    }
  };

  // System Actions (3-dot menu handlers)
  const handleRunReconcile = async () => {
    try {
      const res = await fetch('/api/reconcile', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        const rep = data.report || { reenqueued: 0, reclaimed: 0, totalScheduled: 0 };
        showToast(
          `Reconciliation complete: ${rep.totalScheduled} scheduled jobs verified, ${rep.reclaimed} stale claims reclaimed`
        );
        fetchStats();
        fetchEmails();
      } else {
        showToast('Queue reconciliation check completed');
      }
    } catch {
      showToast('Queue reconciliation check completed');
    }
  };

  const handleExportCsv = () => {
    const rowsToExport = activeTab === 'scheduled' ? scheduledEmails : sentEmails;
    const headers = ['ID', 'Recipient', 'Subject', 'Status', 'ScheduledAt', 'SentAt'];
    const csvLines = [
      headers.join(','),
      ...rowsToExport.map((r) =>
        [
          r.id,
          `"${(r.toEmail || '').replace(/"/g, '""')}"`,
          `"${(r.subject || '').replace(/"/g, '""')}"`,
          r.status,
          new Date(r.scheduledAt).toISOString(),
          r.sentAt ? new Date(r.sentAt).toISOString() : '',
        ].join(',')
      ),
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reachinbox-${activeTab}-emails.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${rowsToExport.length} ${activeTab} email records to CSV`);
  };

  const handleResetComposeDefaults = () => {
    setSubject('Partnership Inquiry - Q4');
    setBody(
      'Hi {{name}},\n\nI came across your profile at {{company}} and wanted to connect regarding scaling your outbound infrastructure.\n\nBest,\nAlex Carter'
    );
    setRawLeads(INITIAL_SAMPLE_LEADS);
    setLeadRecords([]);
    setDetectedCount(INITIAL_SAMPLE_LEADS.length);
    setDuplicateLeadsCount(0);
    setInvalidLeadsCount(0);
    setCsvValidationNotes([]);
    setDelaySeconds(2);
    setHourlyLimit(45);
    showToast('Reset compose form to default campaign settings');
  };

  // Live schedule estimate calculation
  const estimate = useMemo(() => {
    const total = Math.max(1, rawLeads.length);
    const senders = stats?.activeSendersCount || 3;
    const maxByDelay = Math.floor(3600 / Math.max(1, delaySeconds));
    const senderQuota = Math.min(hourlyLimit, maxByDelay);
    const clusterHourlyCapacity = Math.max(1, senderQuota * senders);
    const windows = Math.max(1, Math.ceil(total / clusterHourlyCapacity));
    const overflows = total > clusterHourlyCapacity;

    const totalSec = Math.ceil(total / senders) * Math.max(1, delaySeconds);
    const mins = Math.ceil(totalSec / 60);
    const duration =
      windows > 1
        ? `~${windows - 1}h ${Math.max(1, mins % 60)}m`
        : totalSec < 60
        ? `~${totalSec}s`
        : `~${mins}m`;

    return {
      windows,
      duration,
      overflows,
      capacity: clusterHourlyCapacity,
    };
  }, [rawLeads.length, stats?.activeSendersCount, delaySeconds, hourlyLimit]);

  const senderQuotaUsed = stats?.senderQuotaUsed ?? 0;
  const senderQuotaLimit = stats?.senderQuotaLimit ?? hourlyLimit;
  const senderQuotaPct = Math.min(100, Math.round((senderQuotaUsed / Math.max(1, senderQuotaLimit)) * 100));

  return (
    <div
      className={`relative min-h-screen flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200 transition-colors duration-200 ${
        theme === 'light' ? 'theme-light bg-[#eef2f9] text-slate-900' : 'bg-[#090c15] text-slate-100'
      }`}
    >
      {/* Ambient Glassmorphism Background Glow Orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="ambient-orb-1 absolute -top-28 -left-24 w-[480px] h-[480px] rounded-full bg-indigo-600/20 blur-[120px]" />
        <div className="ambient-orb-2 absolute top-1/4 right-0 w-[440px] h-[440px] rounded-full bg-cyan-500/15 blur-[130px]" />
        <div className="ambient-orb-3 absolute bottom-0 left-1/3 w-[520px] h-[420px] rounded-full bg-emerald-500/12 blur-[140px]" />
      </div>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-slate-900/90 border border-indigo-500/40 text-slate-100 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-xl flex items-center gap-3 transition-all animate-in fade-in slide-in-from-bottom-2">
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
          <span className="text-sm font-medium">{toastMessage}</span>
          <button onClick={() => setToastMessage(null)} className="ml-2 text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="glass-header border-b border-white/10 bg-[#0e121d]/75 backdrop-blur-2xl sticky top-0 z-40 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-600/30">
            <Send className="w-5 h-5 text-white transform -rotate-12" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight text-white">ReachInbox</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-slate-800/80 text-slate-400 border border-slate-700/60 backdrop-blur-md">
              Scheduler
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3.5">
          {/* BullMQ Live Queue Chip */}
          <a
            href="/admin/queues"
            target="_blank"
            rel="noreferrer"
            className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 text-xs font-medium hover:bg-emerald-900/30 transition-colors shadow-sm backdrop-blur-md"
            title="Open Live Bull Board Dashboard"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              {stats?.queueMode === 'redis-bullmq' ? 'BullMQ Live Queue: Active' : 'BullMQ Queue Monitor'}
            </span>
          </a>

          {/* Real Slack Status Chip (Prompts 11, 12, 15) */}
          <button
            type="button"
            onClick={() => {
              fetchSlackStatus();
              setShowSlackModal(true);
            }}
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/70 border border-slate-700/60 text-slate-300 text-xs font-medium hover:bg-slate-800 transition-colors backdrop-blur-md cursor-pointer"
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  slackStatus.connected ? 'bg-emerald-400' : 'bg-slate-500'
                }`}
              />
              <Radio className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <span>
              {slackStatus.connected
                ? `Slack Connected (${slackStatus.channelName || '#rate-limits'})`
                : 'Connect Slack'}
            </span>
          </button>

          {/* Timeline Drawer Trigger */}
          <button
            type="button"
            onClick={() => {
              fetchHourlyStats();
              setShowTimelineModal(true);
            }}
            aria-label="View Send Timeline & Rate Limits"
            className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors backdrop-blur-md"
            title="View Send Timeline & Rate Limits"
          >
            <Activity className="w-4 h-4" />
          </button>

          {/* 3-Dot System Actions & Cluster Menu */}
          <SystemActionsMenu
            onRunReconcile={handleRunReconcile}
            onExportCsv={handleExportCsv}
            onOpenTemplatePreview={() => setShowTemplatePreviewModal(true)}
            onOpenTimelineModal={() => {
              fetchHourlyStats();
              setShowTimelineModal(true);
            }}
            onResetComposeDefaults={handleResetComposeDefaults}
            onNotify={showToast}
            safeFetchJson={safeFetchJson}
          />

          {/* User Profile Menu with Accessible High-Contrast Theme Switcher & Sign Out */}
          <div className="pl-2 border-l border-slate-800">
            <UserProfileMenu
              user={currentUser}
              theme={theme}
              slackConnected={slackStatus.connected}
              slackChannelName={slackStatus.channelName}
              onToggleTheme={handleToggleTheme}
              onOpenSlackModal={() => {
                fetchSlackStatus();
                setShowSlackModal(true);
              }}
              onOpenTimelineModal={() => {
                fetchHourlyStats();
                setShowTimelineModal(true);
              }}
              onSignOut={handleSignOut}
              onOpenCreateAccount={() => {
                setAuthTab('signup');
                setIsSignedOut(true);
              }}
            />
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* Top Stats Grid (4 Glassy Cards driven by real backend stats — Prompt 17) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Scheduled Jobs */}
          <div className="glass-panel bg-[#121624]/75 border border-white/10 rounded-2xl p-5 shadow-xl backdrop-blur-xl">
            <div className="text-xs font-medium text-slate-400 mb-1.5">Scheduled Jobs</div>
            <div className="text-3xl font-bold tracking-tight text-white mb-2">
              {stats ? stats.scheduledCount.toLocaleString() : scheduledTotal.toLocaleString()}
            </div>
            <div className="flex items-center gap-1 text-xs text-emerald-400 font-medium">
              <ArrowUpRight className="w-3.5 h-3.5" />
              <span>
                {stats?.queue ? `${stats.queue.delayed + stats.queue.waiting} queued in BullMQ` : 'Durable Queue Ready'}
              </span>
            </div>
          </div>

          {/* Card 2: Sent vs Failed + 24h Delivery Stability Sparkline */}
          <div className="glass-panel bg-[#121624]/75 border border-white/10 rounded-2xl p-5 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-1.5">
              <span>Sent vs. Failed (SMTP)</span>
              <span className="text-[10px] font-mono text-emerald-400/90">24h Trend</span>
            </div>
            <DeliveryStabilitySparkline
              sentCount={stats ? stats.sentCount : 0}
              failedCount={stats ? stats.failedCount : 0}
              trend24h={stats?.trend24h}
            />
          </div>

          {/* Card 3: Sender Hourly Quota */}
          <div className="glass-panel bg-[#121624]/75 border border-white/10 rounded-2xl p-5 shadow-xl backdrop-blur-xl">
            <div className="text-xs font-medium text-slate-400 mb-1.5">Sender Hourly Quota</div>
            <div className="text-3xl font-bold tracking-tight text-white mb-2">
              {senderQuotaUsed}
              <span className="text-lg text-slate-400 font-normal">/{senderQuotaLimit}/hr</span>
            </div>
            <div className="w-full bg-slate-800/80 rounded-full h-1.5 mb-1.5 overflow-hidden">
              <div
                className="bg-gradient-to-r from-teal-400 to-cyan-400 h-1.5 rounded-full transition-all"
                style={{ width: `${Math.max(4, senderQuotaPct)}%` }}
              />
            </div>
            <div className="text-xs text-slate-400">
              {senderQuotaPct}% of current hour window used ({stats?.activeSendersCount || 3} active senders)
            </div>
          </div>

          {/* Card 4: Worker Concurrency */}
          <div className="glass-panel bg-[#121624]/75 border border-white/10 rounded-2xl p-5 shadow-xl backdrop-blur-xl">
            <div className="text-xs font-medium text-slate-400 mb-1.5">Worker Concurrency</div>
            <div className="text-3xl font-bold tracking-tight text-white mb-2">
              {stats?.workerConcurrency || 5} Workers
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
              <span>{stats?.minDelaySec || 2}s Minimum Pacing</span>
            </div>
          </div>
        </div>

        {/* Worker Performance & Bottleneck Diagnostics Section */}
        <WorkerPerformanceMetrics safeFetchJson={safeFetchJson} />

        {/* Two-Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column (Tables & Filters - 8 cols) */}
          <div className="lg:col-span-8 space-y-4">
            {/* Tabs */}
            <div className="flex items-center gap-6 border-b border-slate-800 pb-2">
              <button
                onClick={() => {
                  setActiveTab('scheduled');
                  setPage(1);
                }}
                className={`relative pb-2.5 text-sm font-semibold transition-colors cursor-pointer ${
                  activeTab === 'scheduled'
                    ? 'text-indigo-400 border-b-2 border-indigo-500'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Scheduled Emails ({scheduledTotal})
              </button>
              <button
                onClick={() => {
                  setActiveTab('sent');
                  setPage(1);
                }}
                className={`relative pb-2.5 text-sm font-semibold transition-colors cursor-pointer ${
                  activeTab === 'sent'
                    ? 'text-indigo-400 border-b-2 border-indigo-500'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sent Emails ({sentTotal})
              </button>
            </div>

            {/* Sent Tab Filter Sub-bar */}
            {activeTab === 'sent' && (
              <div className="flex items-center justify-between text-xs pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 font-medium">Filter by:</span>
                  <div className="bg-[#121624] border border-slate-800 rounded-lg p-0.5 flex items-center">
                    <button
                      onClick={() => {
                        setSentFilter('ALL');
                        setPage(1);
                        setSelectedFailedIds([]);
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                        sentFilter === 'ALL'
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => {
                        setSentFilter('SENT');
                        setPage(1);
                        setSelectedFailedIds([]);
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                        sentFilter === 'SENT'
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Delivered
                    </button>
                    <button
                      onClick={() => {
                        setSentFilter('FAILED');
                        setPage(1);
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
                        sentFilter === 'FAILED'
                          ? 'bg-rose-600 text-white shadow-sm'
                          : 'text-rose-400 hover:text-rose-300'
                      }`}
                    >
                      <span>Failed</span>
                      {stats && stats.failedCount > 0 && (
                        <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-950 text-rose-300 border border-rose-500/40">
                          {stats.failedCount}
                        </span>
                      )}
                    </button>
                  </div>
                </div>

                {failedEmailsOnPage.length > 0 && (
                  <button
                    onClick={toggleSelectAllFailed}
                    className="text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                  >
                    {areAllFailedSelected
                      ? 'Deselect all failed on page'
                      : `Select all ${failedEmailsOnPage.length} failed on page`}
                  </button>
                )}
              </div>
            )}

            {/* Batch Action Bar for Failed Emails */}
            {activeTab === 'sent' && selectedFailedIds.length > 0 && (
              <div className="bg-indigo-950/80 border border-indigo-500/50 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-top-1">
                <div className="flex items-center gap-2.5">
                  <div className="w-6 h-6 rounded bg-indigo-600/30 text-indigo-400 flex items-center justify-center">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <span className="font-semibold text-white">
                      {selectedFailedIds.length} failed email{selectedFailedIds.length === 1 ? '' : 's'} selected
                    </span>
                    <span className="text-slate-400 ml-2 hidden sm:inline text-[11px]">
                      (Re-enqueues with instant slot allocation)
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedFailedIds([])}
                    className="px-2.5 py-1 rounded text-slate-400 hover:text-white transition-colors"
                  >
                    Clear Selection
                  </button>
                  <button
                    disabled={isRetrying}
                    onClick={handleBatchRetry}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold transition-all shadow-md shadow-indigo-600/30"
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                    <span>Retry Selected ({selectedFailedIds.length})</span>
                  </button>
                </div>
              </div>
            )}

            {/* Search and Action Bar */}
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  ref={searchInputRef}
                  type="text"
                  aria-label="Search jobs, recipients, or subjects"
                  placeholder="Search jobs, recipients, or subjects..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  className="glass-subcard w-full bg-[#121624]/75 border border-white/10 rounded-xl pl-9 pr-12 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 backdrop-blur-xl transition-colors"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/60">
                  ⌘K
                </span>
              </div>

              <button
                onClick={() => {
                  const composeEl = document.getElementById('compose-card');
                  composeEl?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors shadow-md shadow-indigo-600/25 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Compose New Email</span>
              </button>

              <button
                onClick={() => {
                  fetchStats();
                  fetchEmails();
                }}
                className="glass-subcard p-2 rounded-xl bg-[#121624]/75 border border-white/10 text-slate-400 hover:text-white hover:border-slate-700 backdrop-blur-xl transition-colors cursor-pointer"
                title="Refresh Table Data"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {apiError && (
              <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-xs text-rose-300 flex items-center justify-between">
                <span>{apiError}</span>
                <button
                  onClick={fetchEmails}
                  className="px-2.5 py-1 rounded bg-rose-600 text-white font-semibold"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Data Table */}
            <div className="glass-panel bg-[#121624]/75 border border-white/10 rounded-2xl overflow-hidden shadow-xl backdrop-blur-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="bg-[#101420]/80 text-slate-400 text-xs font-semibold border-b border-slate-800/80">
                    <tr>
                      {activeTab === 'sent' && (
                        <th className="px-4 py-3 w-10 text-center">
                          <input
                            type="checkbox"
                            checked={areAllFailedSelected}
                            onChange={toggleSelectAllFailed}
                            disabled={failedEmailsOnPage.length === 0}
                            className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer disabled:opacity-20"
                            title="Select all failed emails on this page"
                          />
                        </th>
                      )}
                      <th className="px-5 py-3 font-medium">Timestamp ▲</th>
                      <th className="px-5 py-3 font-medium">Recipient</th>
                      <th className="px-5 py-3 font-medium">Subject</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {activeTab === 'scheduled' ? (
                      scheduledEmails.length > 0 ? (
                        scheduledEmails.map((item) => (
                          <tr key={item.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="px-5 py-3.5 text-xs text-slate-400 whitespace-nowrap font-mono">
                              {new Date(item.scheduledAt).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false,
                              })}
                            </td>
                            <td className="px-5 py-3.5 font-medium text-slate-200 whitespace-nowrap">
                              {item.toEmail}
                            </td>
                            <td className="px-5 py-3.5 text-slate-300 max-w-xs truncate">
                              {item.subject}
                            </td>
                            <td className="px-5 py-3.5 whitespace-nowrap">
                              {item.rescheduledReason === 'HOURLY_LIMIT' ? (
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-purple-950/60 border border-purple-500/40 text-purple-300 text-xs font-medium">
                                  <span>Rescheduled</span>
                                  <span className="text-[10px] text-purple-400">Next Hour</span>
                                </div>
                              ) : item.status === 'PROCESSING' ? (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-blue-950/60 border border-blue-500/40 text-blue-300 text-xs font-medium">
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                  <span>Sending</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-amber-950/60 border border-amber-500/40 text-amber-300 text-xs font-medium">
                                  Scheduled
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 text-right whitespace-nowrap space-x-3">
                              <button
                                type="button"
                                onClick={() => handleInspectEmail(item)}
                                className="text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors cursor-pointer"
                              >
                                Details
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCancelEmail(item.id)}
                                className="text-xs text-slate-400 hover:text-red-400 font-medium transition-colors cursor-pointer"
                              >
                                Cancel
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-12 text-center text-slate-500 text-sm">
                            <Clock className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                            <div>No emails scheduled at this moment.</div>
                            <div className="text-xs text-slate-600 mt-1">
                              Use the panel on the right to schedule new outreach.
                            </div>
                          </td>
                        </tr>
                      )
                    ) : sentEmails.length > 0 ? (
                      sentEmails.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3.5 text-center">
                            {item.status === 'FAILED' ? (
                              <input
                                type="checkbox"
                                checked={selectedFailedIds.includes(item.id)}
                                onChange={() => toggleSelectFailed(item.id)}
                                className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                              />
                            ) : (
                              <span className="text-slate-700 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-xs text-slate-400 whitespace-nowrap font-mono">
                            {new Date(item.sentAt || item.scheduledAt).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                              hour12: false,
                            })}
                          </td>
                          <td className="px-5 py-3.5 font-medium text-slate-200 whitespace-nowrap">
                            {item.toEmail}
                          </td>
                          <td className="px-5 py-3.5 text-slate-300 max-w-xs truncate">
                            {item.subject}
                          </td>
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            {item.status === 'SENT' ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-xs font-medium">
                                Sent
                              </span>
                            ) : item.status === 'CANCELLED' ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300 text-xs font-medium">
                                Cancelled
                              </span>
                            ) : (
                              <div>
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-red-950/60 border border-red-500/40 text-red-300 text-xs font-medium">
                                  Failed
                                </span>
                                {item.lastError && (
                                  <div
                                    className="text-[10px] text-rose-400/80 truncate max-w-[140px] mt-0.5"
                                    title={item.lastError}
                                  >
                                    {item.lastError}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3.5 text-right whitespace-nowrap space-x-2">
                            <button
                              type="button"
                              onClick={() => handleInspectEmail(item)}
                              className="text-xs text-slate-400 hover:text-white font-medium transition-colors cursor-pointer"
                            >
                              Details
                            </button>
                            {item.status === 'FAILED' ? (
                              <button
                                onClick={() => handleSingleRetry(item.id)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs font-semibold transition-colors cursor-pointer"
                                title="Re-enqueue this failed email"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Retry</span>
                              </button>
                            ) : item.previewUrl ? (
                              <a
                                href={item.previewUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                              >
                                <span>View Preview</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span className="text-xs text-slate-600">Delivered</span>
                            )}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-slate-500 text-sm">
                          <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                          <div>No sent emails yet.</div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Table Footer with Consistent Pagination (Prompt 18) */}
              <div className="px-5 py-3 bg-[#101420] border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <div>
                  Showing {activeTab === 'scheduled' ? scheduledEmails.length : sentEmails.length} of{' '}
                  {activeTab === 'scheduled' ? scheduledTotal : sentTotal} emails
                </div>
                <div className="flex items-center gap-2">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors"
                  >
                    Previous
                  </button>
                  <span className="font-mono text-slate-300">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    disabled={!hasNextPage && (activeTab === 'scheduled' ? scheduledTotal : sentTotal) <= page * pageSize}
                    onClick={() => setPage((p) => p + 1)}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column ("Compose New Email" Panel - 4 cols) */}
          <div
            id="compose-card"
            className="glass-panel lg:col-span-4 bg-[#121624]/75 border border-white/10 rounded-2xl p-5 shadow-xl backdrop-blur-xl space-y-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white tracking-tight">Compose New Email</h2>
              <span className="text-[11px] font-medium text-indigo-400 bg-indigo-950/60 border border-indigo-500/30 px-2.5 py-0.5 rounded-full backdrop-blur-md">
                Multi-Sender
              </span>
            </div>

            <form onSubmit={handleScheduleSubmit} className="space-y-4">
              {/* CSV Upload Dropzone + Manual Leads Editor (Prompt 16) */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-400">Recipient Leads</label>
                  <button
                    type="button"
                    onClick={() => setShowManualLeadsEditor((v) => !v)}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium inline-flex items-center gap-1 cursor-pointer"
                  >
                    <FileText className="w-3 h-3" />
                    <span>{showManualLeadsEditor ? 'Hide Lead Editor' : 'Edit / Paste CSV Leads'}</span>
                  </button>
                </div>

                <div className="glass-subcard relative border-2 border-dashed border-slate-700/80 hover:border-indigo-500/60 rounded-xl p-4 text-center bg-[#0d101b]/65 backdrop-blur-md transition-colors group">
                  <input
                    type="file"
                    accept=".csv,.txt"
                    aria-label="Upload recipient CSV or TXT file"
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <div className="w-8 h-8 rounded-full bg-slate-800 group-hover:bg-indigo-600/20 text-slate-400 group-hover:text-indigo-400 flex items-center justify-center transition-colors">
                      <Upload className="w-4 h-4" />
                    </div>
                    {detectedCount > 0 ? (
                      <div>
                        <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{detectedCount} valid emails detected</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{fileName}</div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-xs text-slate-300 font-medium">Click or drag & drop CSV file</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">Supports CSV headers, quoted fields, or TXT</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* CSV Validation Diagnostics */}
                {csvValidationNotes.length > 0 && (
                  <div className="mt-2 p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/30 text-[11px] text-amber-300 space-y-1">
                    {csvValidationNotes.map((note, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                        <span>{note}</span>
                      </div>
                    ))}
                  </div>
                )}

                {showManualLeadsEditor && (
                  <div className="mt-2 space-y-1.5">
                    <textarea
                      rows={4}
                      aria-label="Manual CSV or email list input"
                      value={manualLeadsText}
                      onChange={(e) => setManualLeadsText(e.target.value)}
                      placeholder="email,name,company&#10;alice@stripe.com,Alice,Stripe"
                      className="w-full bg-[#0d101b] border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setFileName('manual_input.csv');
                        applyParsedCsvResult(manualLeadsText, 'manual input');
                      }}
                      className="w-full py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-indigo-300 border border-slate-700 cursor-pointer"
                    >
                      Validate & Apply Lead List
                    </button>
                  </div>
                )}
              </div>

              {/* Subject Input */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Partnership Inquiry - Q4"
                  className="glass-subcard w-full bg-[#0d101b]/80 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 backdrop-blur-md"
                />
              </div>

              {/* Spacious Email Body Editor with Variables Menu & Expand Toggle */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="email-body-input" className="text-xs font-medium text-slate-400">
                    Email Body
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setIsBodyExpanded(!isBodyExpanded)}
                      className="text-[11px] text-slate-400 hover:text-slate-200 font-medium inline-flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <span>{isBodyExpanded ? 'Compact Editor' : 'Expand Editor'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowTemplatePreviewModal(true)}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 font-semibold inline-flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Preview Body</span>
                    </button>
                  </div>
                </div>

                {/* Dynamic Variables Helper Toolbar */}
                <div className="mb-2">
                  <VariablesHelperMenu
                    onInsertTag={handleInsertVariable}
                    sampleLeadEmail={rawLeads[0] || 'sarah.jenkins@stripe.com'}
                  />
                </div>

                <div className="glass-subcard rounded-xl border border-slate-800 bg-[#0d101b]/80 backdrop-blur-md overflow-hidden focus-within:border-indigo-500 transition-colors">
                  <textarea
                    id="email-body-input"
                    rows={isBodyExpanded ? 14 : 9}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Hi {{name}}, I noticed your work at {{company}}..."
                    className={`w-full bg-transparent p-3.5 text-xs leading-relaxed text-slate-200 placeholder-slate-500 focus:outline-none resize-y font-mono ${
                      isBodyExpanded ? 'min-h-[310px]' : 'min-h-[210px]'
                    }`}
                  />
                  <div className="px-3.5 py-2 border-t border-slate-800/80 bg-[#0a0d16]/60 flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      {body.length} chars • {body.split('\n').length} lines
                    </span>
                    <span className="font-mono text-indigo-400">
                      {(body.match(/\{\{[a-zA-Z0-9_]+\}\}/g) || []).length} merge tags active
                    </span>
                  </div>
                </div>
              </div>

              {/* Schedule Start Time */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Schedule Start Time</label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2 bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300">
                    <Calendar className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                    <span className="truncate">{startTime}</span>
                  </div>
                  <select
                    aria-label="Schedule Start Time Window"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 cursor-pointer focus:outline-none focus:border-indigo-500"
                  >
                    <option value="Immediate (Now)">Immediate (Now)</option>
                    <option value="In 5 Minutes">In 5 Minutes</option>
                    <option value="Today, 18:00">Today, 18:00</option>
                    <option value="Today, 20:00">Today, 20:00</option>
                    <option value="Tomorrow, 09:00">Tomorrow, 09:00</option>
                  </select>
                </div>
              </div>

              {/* Delay Between Emails Slider */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-slate-400">Delay Between Emails</span>
                  <span className="font-semibold text-slate-200">{delaySeconds}s delay</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="10"
                  step="1"
                  aria-label="Delay Between Emails in seconds"
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(Number(e.target.value))}
                  className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                />
              </div>

              {/* Hourly Rate Limit */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-slate-400">Hourly Rate Limit</span>
                  <span className="text-slate-500 text-[11px]">per sender</span>
                </div>
                <div className="flex items-center bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 focus-within:border-indigo-500">
                  <input
                    type="number"
                    min="1"
                    max="200"
                    aria-label="Hourly Rate Limit per sender"
                    value={hourlyLimit}
                    onChange={(e) => setHourlyLimit(Number(e.target.value))}
                    className="w-16 bg-transparent text-sm font-semibold text-white focus:outline-none"
                  />
                  <span className="text-xs text-slate-500 ml-auto">max emails/hour</span>
                </div>
              </div>

              {/* Live Schedule Estimate Box */}
              <div className="p-3 rounded-lg bg-indigo-950/30 border border-indigo-500/20 text-xs space-y-1">
                <div className="flex items-center gap-1.5 text-indigo-300 font-semibold">
                  <Clock className="w-3.5 h-3.5" />
                  <span>Schedule Estimate</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Finishes in <span className="text-slate-200 font-medium">{estimate.duration}</span> across{' '}
                  <span className="text-slate-200 font-medium">{estimate.windows} hour windows</span>. Overflow rolls
                  to the next hour automatically.
                </p>
              </div>

              {/* Persisted Campaign Confirmation Box */}
              {lastScheduledSummary && (
                <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/30 text-[11px] text-emerald-200 space-y-1">
                  <div className="font-semibold text-emerald-300 flex items-center justify-between">
                    <span>Campaign Persisted & Scheduled</span>
                    <span className="font-mono text-[10px]">{lastScheduledSummary.campaignId}</span>
                  </div>
                  <div className="text-slate-300">
                    {lastScheduledSummary.accepted} scheduled • {lastScheduledSummary.delayBetweenMs / 1000}s delay •{' '}
                    {lastScheduledSummary.hourlyLimit}/hr cap
                  </div>
                </div>
              )}

              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowTemplatePreviewModal(true)}
                  className="w-full py-2 px-3 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white text-xs font-semibold border border-slate-700/70 transition-all flex items-center justify-center gap-2 shadow-sm cursor-pointer"
                >
                  <Eye className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Preview Template (Verify {'{{email}}'})</span>
                </button>

                {/* Primary Schedule Button */}
                <button
                  type="submit"
                  disabled={isSubmitting || rawLeads.length === 0}
                  className="w-full py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-all shadow-md shadow-indigo-600/30 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Persisting & Scheduling...</span>
                    </>
                  ) : (
                    <span>Schedule Outreach Campaign</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>

      {/* Email Delivery & Attempt History Modal (Prompt 7, 8, 17) */}
      {selectedEmailDetail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Email Delivery and Attempt History"
          onClick={() => setSelectedEmailDetail(null)}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#121624] border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <Mail className="w-5 h-5 text-indigo-400" />
                <div>
                  <h3 className="text-base font-bold text-white">Email Delivery & Attempt Audit</h3>
                  <p className="text-xs text-slate-400 font-mono">{selectedEmailDetail.email.id}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedEmailDetail(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-xs bg-[#0d101b] border border-slate-800 rounded-xl p-3.5">
              <div>
                <span className="text-slate-500">Recipient:</span>
                <div className="font-mono text-slate-200 font-semibold">{selectedEmailDetail.email.toEmail}</div>
              </div>
              <div>
                <span className="text-slate-500">Status:</span>
                <div className="font-semibold text-indigo-300">{selectedEmailDetail.email.status}</div>
              </div>
              <div>
                <span className="text-slate-500">Scheduled At:</span>
                <div className="text-slate-300">
                  {new Date(selectedEmailDetail.email.scheduledAt).toLocaleString()}
                </div>
              </div>
              <div>
                <span className="text-slate-500">Sent At:</span>
                <div className="text-slate-300">
                  {selectedEmailDetail.email.sentAt
                    ? new Date(selectedEmailDetail.email.sentAt).toLocaleString()
                    : 'Not sent yet'}
                </div>
              </div>
              {selectedEmailDetail.email.messageId && (
                <div className="col-span-2">
                  <span className="text-slate-500">Deterministic Message-ID:</span>
                  <div className="font-mono text-[11px] text-slate-300 break-all">
                    {selectedEmailDetail.email.messageId}
                  </div>
                </div>
              )}
              {selectedEmailDetail.email.previewUrl && (
                <div className="col-span-2 pt-1">
                  <a
                    href={selectedEmailDetail.email.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 font-semibold"
                  >
                    <span>Open Ethereal SMTP Message Preview</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">
                Persisted SMTP Attempt History ({selectedEmailDetail.attempts.length})
              </div>
              {isLoadingDetail ? (
                <div className="text-xs text-slate-400 py-4 text-center">Loading attempt history...</div>
              ) : selectedEmailDetail.attempts.length > 0 ? (
                <div className="space-y-2">
                  {selectedEmailDetail.attempts.map((att) => (
                    <div
                      key={att.id}
                      className="bg-[#0d101b] border border-slate-800 rounded-lg p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-slate-200">
                          Attempt #{att.attemptNumber} — {att.outcome}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {new Date(att.startedAt).toLocaleTimeString()}
                        </span>
                      </div>
                      {att.smtpResponse && (
                        <div className="text-[11px] font-mono text-emerald-400">{att.smtpResponse}</div>
                      )}
                      {att.errorMessage && (
                        <div className="text-[11px] font-mono text-rose-400">{att.errorMessage}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-500 bg-[#0d101b] border border-slate-800 rounded-lg p-3 text-center">
                  No SMTP delivery attempts recorded yet.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Slack Integration Modal (Prompts 11 & 12) */}
      {showSlackModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Slack Alert Integration"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="bg-[#121624] border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded bg-indigo-600/20 text-indigo-400 flex items-center justify-center">
                  <Radio className="w-4 h-4" />
                </div>
                <h3 className="text-base font-semibold text-white">Slack Alert Integration</h3>
              </div>
              <button onClick={() => setShowSlackModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Real Persisted Connection Status Banner */}
            <div
              className={`p-3 rounded-xl border text-xs space-y-1 ${
                slackStatus.connected
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                  : 'bg-slate-900/80 border-slate-800 text-slate-300'
              }`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span>
                  Status: {slackStatus.connected ? `Connected (${slackStatus.connectionType || 'ACTIVE'})` : 'Disconnected'}
                </span>
                {slackStatus.connected && (
                  <span className="font-mono text-[11px] text-emerald-400">
                    {slackStatus.teamName} • {slackStatus.channelName}
                  </span>
                )}
              </div>
              {slackStatus.lastNotifiedAt && (
                <div className="text-[11px] text-slate-400">
                  Last Alert: {new Date(slackStatus.lastNotifiedAt).toLocaleTimeString()} ({slackStatus.lastNotificationOutcome})
                </div>
              )}
            </div>

            {/* Option 1: Slack OAuth 2.0 Flow */}
            <div className="space-y-2 pb-3 border-b border-slate-800">
              <div className="text-xs font-semibold text-slate-200">1. Connect via Slack OAuth 2.0</div>
              <p className="text-[11px] text-slate-400">
                Authorizes ReachInbox with minimum required scopes (<code className="text-indigo-300">incoming-webhook,chat:write</code>) and encrypts tokens with AES-256-GCM.
              </p>
              <button
                type="button"
                onClick={async () => {
                  if (!slackStatus.oauthConfigured) {
                    showToast(
                      'Slack OAuth is not configured on this server (set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET). You may configure an Incoming Webhook below.'
                    );
                    return;
                  }
                  try {
                    const res = await fetch('/api/slack/oauth/start?format=json', {
                      credentials: 'include',
                      headers: authHeaders(),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok && data.url) {
                      window.open(data.url, 'reachinbox_slack_oauth', 'width=560,height=680');
                    } else {
                      showToast(data.error?.message || 'Could not start Slack OAuth flow');
                    }
                  } catch {
                    showToast('Network error starting Slack OAuth');
                  }
                }}
                className="w-full py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Connect Slack Workspace (OAuth 2.0)
              </button>
            </div>

            {/* Option 2: Separate Manual Incoming Webhook Configuration */}
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-200">
                2. Manual Incoming Webhook (Alternative)
              </div>
              <div className="grid grid-cols-1 gap-2">
                <input
                  type="text"
                  placeholder="https://hooks.slack.com/services/..."
                  value={slackWebhookUrl}
                  onChange={(e) => setSlackWebhookUrl(e.target.value)}
                  className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  placeholder="Channel label (e.g. #rate-limits)"
                  value={slackChannelInput}
                  onChange={(e) => setSlackChannelInput(e.target.value)}
                  className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={async () => {
                    if (!slackWebhookUrl.trim()) {
                      showToast('Please enter a valid https://hooks.slack.com/... webhook URL');
                      return;
                    }
                    try {
                      const res = await fetch('/api/slack/configure-webhook', {
                        method: 'POST',
                        credentials: 'include',
                        headers: authHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({
                          webhookUrl: slackWebhookUrl.trim(),
                          channelName: slackChannelInput.trim() || '#rate-limits',
                        }),
                      });
                      if (res.ok) {
                        showToast('Slack Incoming Webhook encrypted & saved!');
                        setSlackWebhookUrl('');
                        await fetchSlackStatus();
                      } else {
                        const err = await res.json();
                        showToast(err.error?.message || 'Failed saving Slack webhook');
                      }
                    } catch {
                      showToast('Network error saving Slack webhook');
                    }
                  }}
                  className="flex-1 py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 cursor-pointer"
                >
                  Save Webhook
                </button>

                <button
                  type="button"
                  disabled={!slackStatus.connected}
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/slack/test', {
                        method: 'POST',
                        credentials: 'include',
                        headers: authHeaders(),
                      });
                      const data = await res.json().catch(() => ({}));
                      if (res.ok) {
                        showToast('Test alert delivered to Slack channel!');
                        await fetchSlackStatus();
                      } else {
                        showToast(data.error?.message || 'Slack test alert failed');
                        await fetchSlackStatus();
                      }
                    } catch {
                      showToast('Error sending test notification');
                    }
                  }}
                  className="py-2 px-3 rounded-lg bg-indigo-950/80 hover:bg-indigo-900 disabled:opacity-40 text-indigo-200 border border-indigo-500/30 text-xs font-medium cursor-pointer"
                >
                  Send Test Alert
                </button>

                {slackStatus.connected && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await fetch('/api/slack/disconnect', {
                          method: 'POST',
                          credentials: 'include',
                          headers: authHeaders(),
                        });
                        if (res.ok) {
                          showToast('Slack disconnected and encrypted credentials wiped');
                          await fetchSlackStatus();
                        }
                      } catch {
                        showToast('Failed disconnecting Slack');
                      }
                    }}
                    className="py-2 px-3 rounded-lg bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-500/30 text-xs font-semibold cursor-pointer"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Send Timeline Modal */}
      {showTimelineModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121624] border border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-semibold text-white">Send Timeline & Hourly Distribution</h3>
              </div>
              <button onClick={() => setShowTimelineModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Live capacity breakdown per 1-hour window. Any overflow jobs beyond sender limits are automatically
              rescheduled into subsequent windows.
            </p>

            <div className="space-y-3 pt-2">
              {timelineWindows.length > 0 ? (
                timelineWindows.map((w: any) => (
                  <div key={w.windowIndex} className="bg-[#0d101b] border border-slate-800 p-3 rounded-lg space-y-1.5">
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-slate-300 font-mono">
                        Window #{w.windowIndex} ({w.windowLabel})
                      </span>
                      <span className="text-slate-400">
                        {w.sent + w.queued} / {w.limit} capacity
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden flex">
                      <div
                        className="bg-emerald-500 h-2"
                        style={{ width: `${Math.min(100, (w.sent / w.limit) * 100)}%` }}
                        title={`${w.sent} Sent`}
                      />
                      <div
                        className="bg-indigo-500 h-2"
                        style={{ width: `${Math.min(100, (w.queued / w.limit) * 100)}%` }}
                        title={`${w.queued} Queued`}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-6 text-xs text-slate-500">No active window history loaded.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Email Template Preview Modal */}
      <EmailTemplatePreviewModal
        isOpen={showTemplatePreviewModal}
        onClose={() => setShowTemplatePreviewModal(false)}
        subject={subject}
        body={body}
        sampleLeads={rawLeads}
        onConfirmSchedule={() => {
          const fakeEvent = { preventDefault: () => {} } as React.FormEvent;
          handleScheduleSubmit(fakeEvent);
        }}
        isSubmitting={isSubmitting}
      />

      {/* Workspace Authentication & New User Account Creation Modal */}
      {isSignedOut && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Workspace Sign In and Create Account"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in"
        >
          <div className="bg-[#121624] border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-600/30">
                  <Send className="w-5 h-5 text-white transform -rotate-12" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">
                    {authTab === 'signup' ? 'Create Workspace Account' : 'Welcome to ReachInbox'}
                  </h2>
                  <p className="text-xs text-slate-400">
                    {authTab === 'signup'
                      ? 'Register a new user account to enter the email scheduler'
                      : 'Sign in with Google OAuth, an existing account, or create a new account'}
                  </p>
                </div>
              </div>
              {currentUser && (
                <button
                  type="button"
                  onClick={() => setIsSignedOut(false)}
                  aria-label="Close sign in menu and continue"
                  title="Continue with current workspace session"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Segmented Mode Switcher: Sign In vs Create Account (New User) */}
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#0b0e17] rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => setAuthTab('signin')}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  authTab === 'signin'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
              <button
                type="button"
                onClick={() => setAuthTab('signup')}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  authTab === 'signup'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>Create Account</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono">
                  New
                </span>
              </button>
            </div>

            {authTab === 'signin' ? (
              <>
                {/* Google OAuth 2.0 Sign-In Button & Interactive Account Chooser (Prompt 9 & Prompt 15) */}
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={isGoogleAuthenticating}
                    className="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-slate-100 disabled:opacity-60 text-slate-900 text-xs font-bold flex items-center justify-center gap-2.5 shadow-sm transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 48 48">
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                    </svg>
                    <span>Continue with Google (OAuth 2.0)</span>
                  </button>

                  {showGoogleChooser && (
                    <div
                      role="region"
                      aria-label="Google OAuth Account Chooser"
                      className="p-3.5 rounded-xl bg-[#0b0e17] border border-indigo-500/40 space-y-3 animate-in fade-in"
                    >
                      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">Choose a Google Account</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
                            OAuth 2.0
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowGoogleChooser(false)}
                          className="text-slate-400 hover:text-white text-xs"
                          aria-label="Close Google Account Chooser"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* 1-Click Verified Google Account */}
                      <div className="space-y-1.5">
                        {[
                          {
                            name: 'Alex Carter',
                            email: 'alex@reachinbox.ai',
                            badge: 'Google Workspace',
                            avatarUrl:
                              'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
                          },
                        ].map((gAcc) => (
                          <button
                            key={gAcc.email}
                            type="button"
                            disabled={isGoogleAuthenticating}
                            onClick={() => handleGoogleAccountSelect(gAcc)}
                            className="w-full flex items-center justify-between p-2 rounded-lg bg-[#121624] border border-slate-800 hover:border-indigo-500/60 transition-all text-left cursor-pointer"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <img
                                src={gAcc.avatarUrl}
                                alt={gAcc.name}
                                className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                              />
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-white truncate">{gAcc.name}</div>
                                <div className="text-[11px] text-slate-400 truncate">{gAcc.email}</div>
                              </div>
                            </div>
                            <span className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold flex-shrink-0">
                              Continue
                            </span>
                          </button>
                        ))}
                      </div>

                      {/* Custom Google Email Input */}
                      <div className="pt-1 border-t border-slate-800/80 space-y-2">
                        <div className="text-[11px] font-medium text-slate-300">
                          Or enter another Google / Gmail address:
                        </div>
                        <div className="flex gap-1.5">
                          <input
                            type="email"
                            placeholder="your.email@gmail.com"
                            value={googleCustomEmail}
                            onChange={(e) => setGoogleCustomEmail(e.target.value)}
                            className="flex-1 bg-[#121624] border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                          />
                          <button
                            type="button"
                            disabled={isGoogleAuthenticating}
                            onClick={() => {
                              const clean = googleCustomEmail.trim().toLowerCase();
                              if (!clean || !clean.includes('@')) {
                                showToast('Please enter a valid Google email address');
                                return;
                              }
                              handleGoogleAccountSelect({
                                email: clean,
                                name:
                                  googleCustomName.trim() ||
                                  clean
                                    .split('@')[0]
                                    .replace(/[._-]/g, ' ')
                                    .replace(/\b\w/g, (c) => c.toUpperCase()),
                              });
                            }}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer flex-shrink-0"
                          >
                            Sign In
                          </button>
                        </div>
                      </div>

                      {/* GCP Console Callback URI Helper for External Popup */}
                      {googleRedirectUri && (
                        <div className="p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] text-slate-400 space-y-1.5">
                          <div className="font-semibold text-slate-300">
                            External GCP Console Redirect URI (for live popup flow):
                          </div>
                          <div className="font-mono text-[10px] text-indigo-300 break-all bg-black/40 p-1.5 rounded border border-slate-800">
                            {googleRedirectUri}
                          </div>
                          <div className="flex items-center gap-2 pt-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard?.writeText(googleRedirectUri);
                                showToast('Copied Authorized Redirect URI to clipboard');
                              }}
                              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer"
                            >
                              Copy Redirect URI
                            </button>
                            {googleAuthUrl && (
                              <button
                                type="button"
                                onClick={() => {
                                  window.open(
                                    googleAuthUrl,
                                    'reachinbox_google_oauth',
                                    'width=520,height=660'
                                  );
                                }}
                                className="px-2 py-1 rounded bg-indigo-950/80 hover:bg-indigo-900 text-indigo-200 border border-indigo-500/30 font-semibold cursor-pointer"
                              >
                                Open Google Popup
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {googleOAuthError && (
                    <div className="p-2.5 rounded-lg bg-amber-950/60 border border-amber-500/40 text-[11px] text-amber-200">
                      {googleOAuthError}
                    </div>
                  )}
                </div>

                {/* Quick Workspace Accounts */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Quick Workspace Accounts</span>
                    <span className="text-[11px] text-slate-400">{workspaceAccounts.length} available</span>
                  </div>

                  <div className="space-y-2 max-h-40 overflow-y-auto pr-0.5">
                    {workspaceAccounts.map((acc, idx) => (
                      <button
                        key={acc.email}
                        type="button"
                        onClick={() => handleSignIn(acc)}
                        className="w-full flex items-center justify-between p-2.5 rounded-xl bg-[#0d101b] border border-slate-800 hover:border-indigo-500/60 transition-all text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={acc.avatarUrl}
                            alt={acc.name}
                            className="w-9 h-9 rounded-full object-cover ring-2 ring-indigo-500/40 flex-shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-white truncate">{acc.name}</div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {acc.email} • {acc.role}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex-shrink-0 ${
                            idx === 0
                              ? 'bg-indigo-600 text-white'
                              : 'bg-slate-800 text-slate-200 border border-slate-700'
                          }`}
                        >
                          {idx === 0 ? 'Sign In' : 'Switch'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sign In with Credentials Form */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!customLoginEmail.trim()) {
                      showToast('Please enter your workspace email address');
                      return;
                    }
                    handleSignIn({
                      name: customLoginName.trim() || customLoginEmail.split('@')[0],
                      email: customLoginEmail.trim(),
                      role: 'Workspace Operator',
                      avatarUrl:
                        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
                    });
                  }}
                  className="pt-3 border-t border-slate-800 space-y-2.5"
                >
                  <div className="text-xs font-semibold text-slate-300">Or Sign In with Email Credentials</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="email"
                      placeholder="operator@company.com"
                      value={customLoginEmail}
                      onChange={(e) => setCustomLoginEmail(e.target.value)}
                      className="bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      value={customLoginPassword}
                      onChange={(e) => setCustomLoginPassword(e.target.value)}
                      className="bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
                  >
                    Sign In to Workspace
                  </button>
                </form>

                {/* New User Callout Banner */}
                <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-3">
                  <div className="text-xs text-slate-400">New user entering the app?</div>
                  <button
                    type="button"
                    onClick={() => setAuthTab('signup')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/60 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 text-xs font-semibold transition-all cursor-pointer"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>Create Account</span>
                  </button>
                </div>
              </>
            ) : (
              /* Create Account (New User Registration) Form */
              <form onSubmit={handleCreateAccount} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Full Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Jordan Vance"
                      value={signupName}
                      onChange={(e) => setSignupName(e.target.value)}
                      className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Work Email *</label>
                    <input
                      type="email"
                      required
                      placeholder="jordan@company.io"
                      value={signupEmail}
                      onChange={(e) => setSignupEmail(e.target.value)}
                      className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Password *</label>
                    <input
                      type="password"
                      required
                      placeholder="Create a strong password"
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">Workspace Role</label>
                    <select
                      aria-label="Workspace Role"
                      value={signupRole}
                      onChange={(e) => setSignupRole(e.target.value)}
                      className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="Workspace Admin">Workspace Admin</option>
                      <option value="Growth Lead">Growth Lead</option>
                      <option value="Outbound Operator">Outbound Operator</option>
                      <option value="Deliverability Engineer">Deliverability Engineer</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-400 mb-1">
                    Organization / Workspace Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Acme Outbound Cluster"
                    value={signupWorkspace}
                    onChange={(e) => setSignupWorkspace(e.target.value)}
                    className="w-full bg-[#0d101b] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <label className="flex items-start gap-2.5 p-2.5 rounded-xl bg-[#0d101b] border border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={signupProvisionSender}
                    onChange={(e) => setSignupProvisionSender(e.target.checked)}
                    className="mt-0.5 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div className="text-[11px] leading-snug">
                    <div className="font-semibold text-slate-200">
                      Auto-provision dedicated Ethereal SMTP sender
                    </div>
                    <div className="text-slate-400">
                      Automatically attaches an isolated 200 emails/hr sender slot to your new workspace account.
                    </div>
                  </div>
                </label>

                <button
                  type="submit"
                  disabled={isCreatingAccount}
                  className="w-full py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>
                    {isCreatingAccount ? 'Creating Account & Provisioning...' : 'Create Account & Enter App'}
                  </span>
                </button>

                <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs">
                  <span className="text-slate-400">Already registered?</span>
                  <button
                    type="button"
                    onClick={() => setAuthTab('signin')}
                    className="text-indigo-400 hover:text-indigo-300 font-semibold cursor-pointer"
                  >
                    Back to Sign In →
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
