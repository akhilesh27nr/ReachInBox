import { Worker, Job } from 'bullmq';
import { redisConnection, isRedisOnline } from '../lib/redis.js';
import { config } from '../config/env.js';
import { processEmailJob } from './processor.js';
import { EmailJobData, emailQueue } from '../queues/email.queue.js';

let emailWorker: Worker<EmailJobData, any, string> | null = null;
let memoryTimer: NodeJS.Timeout | null = null;
let activeInMemoryCount = 0;

export function isWorkerRunning(): boolean {
  return Boolean(emailWorker || memoryTimer);
}

export function getWorkerStatus(): {
  running: boolean;
  mode: 'bullmq-redis' | 'embedded-fallback' | 'stopped';
  concurrency: number;
  activeJobs: number;
} {
  if (emailWorker) {
    return {
      running: true,
      mode: 'bullmq-redis',
      concurrency: config.WORKER_CONCURRENCY,
      activeJobs: activeInMemoryCount,
    };
  }
  if (memoryTimer) {
    return {
      running: true,
      mode: 'embedded-fallback',
      concurrency: config.WORKER_CONCURRENCY,
      activeJobs: activeInMemoryCount,
    };
  }
  return {
    running: false,
    mode: 'stopped',
    concurrency: config.WORKER_CONCURRENCY,
    activeJobs: 0,
  };
}

export function startEmailWorker(): Worker<EmailJobData, any, string> | null {
  if (isRedisOnline()) {
    if (emailWorker) return emailWorker;

    emailWorker = new Worker<EmailJobData, any, string>(
      config.QUEUE_NAME,
      async (job: Job<EmailJobData, any, string>, token?: string) => {
        activeInMemoryCount++;
        try {
          return await processEmailJob(job, token);
        } finally {
          activeInMemoryCount = Math.max(0, activeInMemoryCount - 1);
        }
      },
      {
        connection: redisConnection,
        concurrency: config.WORKER_CONCURRENCY,
        lockDuration: 60000,
        maxStalledCount: 1,
      }
    );

    emailWorker.on('completed', (job: Job) => {
      console.log(`[Worker] Job ${job.id} completed successfully`);
    });

    emailWorker.on('failed', (job: Job | undefined, err: Error) => {
      if (err.name === 'DelayedError') {
        console.log(`[Worker] Job ${job?.id} rescheduled to future time window`);
        return;
      }
      console.error(`[Worker] Job ${job?.id} failed with error:`, err.message);
    });

    emailWorker.on('stalled', (jobId: string) => {
      console.warn(`[Worker] Job ${jobId} stalled and will be reclaimed`);
    });

    console.log(`[Worker] BullMQ Worker started with concurrency=${config.WORKER_CONCURRENCY}`);
    return emailWorker;
  }

  if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
    throw new Error(
      'Worker Error: Cannot start BullMQ Worker because Redis is offline and embedded fallback is disabled.'
    );
  }

  // Explicit test/preview embedded queue worker when ALLOW_EMBEDDED_FALLBACK=true
  if (!memoryTimer) {
    memoryTimer = setInterval(async () => {
      if (activeInMemoryCount >= config.WORKER_CONCURRENCY) return;
      const now = Date.now();
      const jobsMap = emailQueue._getMemoryJobs();

      for (const job of jobsMap.values()) {
        if (activeInMemoryCount >= config.WORKER_CONCURRENCY) break;
        if ((job.state === 'waiting' || job.state === 'delayed') && job.runAt <= now) {
          job.state = 'active';
          activeInMemoryCount++;

          (async () => {
            try {
              await processEmailJob(job as unknown as Job<EmailJobData, any, string>, 'memory-token');
              if (job.state === 'active') {
                job.state = 'completed';
              }
            } catch (err: any) {
              if (err?.name === 'DelayedError') {
                job.state = 'delayed';
              } else {
                job.attemptsMade++;
                if (job.attemptsMade < (job.opts?.attempts || config.EMAIL_MAX_ATTEMPTS)) {
                  job.runAt = Date.now() + 5000;
                  job.state = 'delayed';
                } else {
                  job.state = 'failed';
                }
              }
            } finally {
              activeInMemoryCount = Math.max(0, activeInMemoryCount - 1);
            }
          })();
        }
      }
    }, 350);

    console.log(`[Worker] Embedded Fallback Queue Worker started with concurrency=${config.WORKER_CONCURRENCY}`);
  }

  return null;
}

export async function stopEmailWorker(options?: { releaseClaims?: boolean; drainTimeoutMs?: number }): Promise<{
  drained: boolean;
  releasedClaims: number;
}> {
  if (memoryTimer) {
    clearInterval(memoryTimer);
    memoryTimer = null;
  }
  if (emailWorker) {
    console.log('[Worker] Gracefully closing BullMQ Worker...');
    await emailWorker.close();
    emailWorker = null;
    console.log('[Worker] Worker closed.');
  }

  const drainTimeoutMs = options?.drainTimeoutMs ?? 5000;
  const drainStart = Date.now();
  while (activeInMemoryCount > 0 && Date.now() - drainStart < drainTimeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const drained = activeInMemoryCount === 0;

  let releasedClaims = 0;
  if (options?.releaseClaims !== false) {
    try {
      const { getDb } = await import('../db/db.js');
      const db = getDb();
      const nowMs = Date.now();
      const res = await db.execute({
        sql: `UPDATE emails
              SET status = 'SCHEDULED', processingStartedAt = NULL, updatedAt = ?
              WHERE status = 'PROCESSING'`,
        args: [nowMs],
      });
      releasedClaims = res.rowsAffected || 0;
    } catch {
      // Ignore if database is already closed
    }
  }

  return { drained, releasedClaims };
}

