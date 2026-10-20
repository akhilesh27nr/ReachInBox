# ReachInbox — 5-Minute Live Demo Script & Final Submission Checklist

---

## Part 1: 5-Minute Video Walkthrough Script (< 5:00 Total)

Use this exact sequence to record a clean, unedited demonstration under 5 minutes using real persisted application state:

### 0:00 – 0:45 | Authentication & System Readiness
1. **Show Unauthenticated State**:
   - Open `http://localhost:3000` in an incognito window (or click **Sign Out** in the profile menu).
   - Point out that no fake profile or fake "Slack Connected" badge is shown when signed out.
2. **Sign In via Google OAuth**:
   - Click **Sign in with Google** (`/auth/google`), complete the OAuth flow, and return to the dashboard.
   - *(Note: If recording in an environment without external Google OAuth credentials, click **Workspace Demo Session** and explicitly state that OAuth credentials are environment-configured via `.env`).*
3. **Verify System Readiness**:
   - Show `http://localhost:3000/ready` returning component health for PostgreSQL, Redis/BullMQ, Worker, and Elasticsearch.

### 0:45 – 1:45 | CSV Upload, Validation & Campaign Scheduling
1. **Upload Multi-Row CSV**:
   - In the **Compose Outreach Campaign** panel, upload a CSV file containing valid leads, quoted fields, duplicate rows, and an invalid email address (or click **Load Sample CSV**).
   - Highlight the instant client-side RFC 4180 parser summary showing:
     - Exact **Valid Unique Recipients** count
     - **Duplicates Removed** count
     - **Invalid / Malformed Rows** warning with line numbers
2. **Configure Rate Limits & Pacing**:
   - Set **Subject** (`Scale Outreach for {{name}} at {{company}}`) and **HTML Body**.
   - Set **Start Time**, **Min Delay (`2s`)**, and **Hourly Quota (`50 emails/hr`)**.
   - Click **Preview** to inspect the rendered template with sample lead variables (`{{name}}`, `{{company}}`, `{{email}}`).
3. **Submit Campaign**:
   - Click **Schedule Outreach Campaign (N)**.
   - Show the confirmation banner and observe the **Scheduled Queue** tab populate immediately with persisted records from the backend.

### 1:45 – 2:45 | Protected Bull Board Queue Monitor & Worker Rate-Limit Behavior
1. **Open Protected Bull Board (`/admin/queues`)**:
   - Open `http://localhost:3000/admin/queues`.
   - Show that unauthenticated access returns `401 Unauthorized`, and authenticated access displays the live Redis-backed `email-send` BullMQ queue in `readOnlyMode` with redacted job payloads (`[REDACTED_FOR_PRIVACY]`).
2. **Observe Atomic Rate Limiting & Pacing**:
   - Watch jobs move from `delayed` / `waiting` -> `active` -> `completed` spaced by `MIN_DELAY_BETWEEN_EMAILS_MS` (`2000ms`).
   - Show that when a sender hits its hourly ceiling, overflow jobs transition to `RESCHEDULED` (`moveToDelayed`) for the next UTC hour window without dropping a single job.

### 2:45 – 3:45 | Ethereal SMTP Preview, Elasticsearch Search & Slack Alerts
1. **Verify Real SMTP Acceptance & Ethereal Message Preview**:
   - Switch to the **Sent & Failed** tab.
   - Click **Inspect** on a `SENT` email to open the **Email Delivery & Attempt Audit Modal**.
   - Show the persisted `send_attempts` record (`attemptNumber`, `250 2.0.0 OK`, `Message-ID: <emailId@scheduler.local>`) and click **Open in Ethereal Webmail** (`previewUrl`) to display the rendered email in Ethereal.
2. **Elasticsearch Full-Text Search**:
   - Type a recipient domain or keyword into the search bar and show the search badge (`ES Index` when Elasticsearch is online, or `DB Fallback` when offline) along with paginated results.
3. **Slack Integration & Rate-Limit Notification**:
   - Click the **Slack Disconnected** button in the top bar to open the Slack integration modal.
   - Connect via Slack OAuth (`/auth/slack`) or configure an incoming webhook URL, then click **Test Alert** to verify live Slack Block Kit delivery.

### 3:45 – 4:45 | Crash Recovery, Service Restart & 1,200-Email Load Proof
1. **Demonstrate Persistence Across Process Restart**:
   - Schedule a batch of emails with a future start time (or while jobs are actively queued).
   - Stop and restart the server (`SIGTERM` / `SIGINT` or `npm run dev`).
   - Show the `[Shutdown]` log releasing unfinished `PROCESSING` claims and the `[Reconcile]` startup log verifying that all `SCHEDULED` emails and Redis AOF delayed jobs survive intact with zero duplicate sends.
2. **Run the Reproducible 1,200-Email Load Test**:
   - In the terminal, run:
     ```bash
     npm run test:load
     ```
   - Show the summary output: **1,200 / 1,200 emails scheduled and delivered** across 3 senders and 15 concurrent workers, 4 transient `421` deferrals automatically retried, mid-flight crash reconciliation verified, `0` lost jobs, and `0` duplicate deliveries.

---

## Part 2: Final Submission Checklist (Prompt 24)

### Automated & Repository Hygiene Checks (Completed & Verified)
- [x] **No `.env` or secret files committed**: Verified `.gitignore` and `.dockerignore` exclude `.env`, `.env.*` (except `.env.example`), `*.db`, `*.db-journal`, `*.db-wal`, `dump.rdb`, and `appendonlydir/`.
- [x] **No hardcoded credentials or private recipient data**: Verified `.env.example`, `Dockerfile`, `docker-compose.yml`, and `src/` contain zero real API keys, passwords, or private PII.
- [x] **TypeScript static analysis (`npm run lint`)**: Passed (`0` errors).
- [x] **Automated test suite (`npm test`)**: Passed (**24 / 24 tests passing**, `0` failed, `0` skipped).
- [x] **1,200-email reproducible load test (`npm run test:load`)**: Passed (**1,200 / 1,200 delivered**, `0` lost, `0` duplicates).
- [x] **Production bundle build (`npm run build`)**: Passed (`dist/` compiled cleanly).

### Manual Steps Required Before External Submission
Because external GitHub repository settings, third-party OAuth consoles, and screen recording tools reside outside this workspace container, complete the following manual steps prior to submitting:
1. **GitHub Repository Privacy & Reviewer Access**:
   - Ensure the target GitHub repository visibility is set to **Private**.
   - In GitHub **Settings -> Collaborators**, invite the designated ReachInbox reviewer GitHub account(s) and confirm the invitation is pending/accepted. *(Not claimed as completed inside this container).*
2. **Live External Provider Credentials (Optional for Video Demo)**:
   - Populate `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` in your local `.env` when recording the live OAuth redirect segments of the walkthrough video.
3. **Screen Recording**:
   - Record the <5-minute walkthrough following **Part 1** above and include the video link in your submission form.
