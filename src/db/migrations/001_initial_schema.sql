-- ReachInbox Pulse — PostgreSQL Relational Schema Migration (001)
-- Covers Users, Sessions, Senders, Slack Connections, Campaigns, Emails, Send Attempts, Outbox Jobs, and Events

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  "googleId" TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  "avatarUrl" TEXT,
  timezone TEXT DEFAULT 'UTC',
  "defaultDelayMs" INTEGER DEFAULT 2000,
  "defaultHourlyLimit" INTEGER DEFAULT 100,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "expiresAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "userAgent" TEXT,
  "ipAddress" TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions("userId", "expiresAt");

CREATE TABLE IF NOT EXISTS senders (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  email TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "smtpHost" TEXT NOT NULL,
  "smtpPort" INTEGER NOT NULL,
  "smtpUser" TEXT NOT NULL,
  "smtpPassEncrypted" TEXT NOT NULL,
  "hourlyQuota" INTEGER DEFAULT 200,
  "isActive" INTEGER DEFAULT 1,
  "createdAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_senders_user ON senders("userId", "isActive");

CREATE TABLE IF NOT EXISTS slack_connections (
  id TEXT PRIMARY KEY,
  "userId" TEXT UNIQUE NOT NULL,
  "teamId" TEXT,
  "teamName" TEXT,
  "channelId" TEXT,
  "channelName" TEXT,
  "webhookUrlEncrypted" TEXT,
  "botTokenEncrypted" TEXT,
  scopes TEXT,
  status TEXT DEFAULT 'CONNECTED',
  "lastNotifiedAt" TEXT,
  "lastNotificationOutcome" TEXT,
  "connectedAt" TEXT,
  "disconnectedAt" TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  "startAt" TEXT NOT NULL,
  "delayBetweenMs" INTEGER NOT NULL,
  "hourlyLimit" INTEGER NOT NULL,
  "totalCount" INTEGER NOT NULL,
  "validCount" INTEGER DEFAULT 0,
  "duplicateCount" INTEGER DEFAULT 0,
  "invalidCount" INTEGER DEFAULT 0,
  "idempotencyKey" TEXT,
  status TEXT DEFAULT 'ACTIVE',
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT,
  UNIQUE("userId", "idempotencyKey")
);

CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns("userId", "createdAt");

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  "campaignId" TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "toEmail" TEXT NOT NULL,
  "recipientName" TEXT,
  "recipientCompany" TEXT,
  "recipientJobTitle" TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'SCHEDULED',
  "scheduledAt" BIGINT NOT NULL,
  "originalScheduledAt" BIGINT NOT NULL,
  "lastAttemptAt" BIGINT,
  "sentAt" BIGINT,
  "failedAt" BIGINT,
  "cancelledAt" BIGINT,
  attempts INTEGER DEFAULT 0,
  "rescheduleCount" INTEGER DEFAULT 0,
  "rescheduledReason" TEXT,
  "messageId" TEXT,
  "previewUrl" TEXT,
  "lastError" TEXT,
  "processingStartedAt" BIGINT,
  sequence INTEGER DEFAULT 0,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  UNIQUE("campaignId", "toEmail")
);

CREATE INDEX IF NOT EXISTS idx_emails_status_sched ON emails(status, "scheduledAt");
CREATE INDEX IF NOT EXISTS idx_emails_user_status ON emails("userId", status, "scheduledAt");
CREATE INDEX IF NOT EXISTS idx_emails_sender_status ON emails("senderId", status);
CREATE INDEX IF NOT EXISTS idx_emails_campaign ON emails("campaignId", sequence);
CREATE INDEX IF NOT EXISTS idx_emails_recipient ON emails("userId", "toEmail");

CREATE TABLE IF NOT EXISTS send_attempts (
  id TEXT PRIMARY KEY,
  "emailId" TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  "campaignId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "startedAt" BIGINT NOT NULL,
  "completedAt" BIGINT,
  outcome TEXT NOT NULL,
  "smtpResponse" TEXT,
  "messageId" TEXT,
  "errorMessage" TEXT
);

CREATE INDEX IF NOT EXISTS idx_send_attempts_email ON send_attempts("emailId", "attemptNumber");

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id TEXT PRIMARY KEY,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  attempts INTEGER DEFAULT 0,
  "lastError" TEXT,
  "createdAt" BIGINT NOT NULL,
  "processedAt" BIGINT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_jobs(status, "createdAt");

CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  "userId" TEXT,
  "campaignId" TEXT,
  "emailId" TEXT,
  "senderId" TEXT,
  type TEXT NOT NULL,
  meta TEXT,
  "createdAt" BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_events_email ON email_events("emailId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_email_events_user ON email_events("userId", "createdAt");
