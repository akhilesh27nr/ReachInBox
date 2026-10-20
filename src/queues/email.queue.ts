import { Queue } from 'bullmq';
import { redisConnection, isRedisOnline } from '../lib/redis.js';
import { config } from '../config/env.js';

export interface EmailJobData {
  emailId: string;
  slotAt?: number;
}

export interface InMemoryJob {
  id: string;
  name: string;
  data: EmailJobData;
  opts: any;
  runAt: number;
  state: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
  attemptsMade: number;
  updateData: (newData: EmailJobData) => Promise<void>;
  moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
  remove: () => Promise<void>;
}

const memoryJobs = new Map<string, InMemoryJob>();

function assertQueueFallbackAllowed(): void {
  if (config.STRICT_INFRASTRUCTURE || !config.ALLOW_EMBEDDED_FALLBACK) {
    throw new Error(
      'Queue Error: BullMQ Redis connection is unavailable and embedded queue fallback is disabled.'
    );
  }
}

function createMemoryJob(name: string, data: EmailJobData, opts: any = {}): InMemoryJob {
  assertQueueFallbackAllowed();
  const id = String(opts.jobId || data.emailId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const delay = Math.max(0, Number(opts.delay) || 0);
  const runAt = Date.now() + delay;

  const job: InMemoryJob = {
    id,
    name,
    data: { ...data },
    opts: { attempts: config.EMAIL_MAX_ATTEMPTS, ...opts },
    runAt,
    state: delay > 0 ? 'delayed' : 'waiting',
    attemptsMade: 0,
    async updateData(newData: EmailJobData) {
      job.data = { ...newData };
    },
    async moveToDelayed(timestamp: number) {
      job.runAt = timestamp;
      job.state = 'delayed';
    },
    async remove() {
      memoryJobs.delete(id);
    },
  };

  memoryJobs.set(id, job);
  return job;
}

let bullQueue: Queue<EmailJobData> | null = null;

export function getBullQueue(): Queue<EmailJobData> | null {
  if (!isRedisOnline()) return null;
  if (!bullQueue) {
    bullQueue = new Queue<EmailJobData>(config.QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: config.EMAIL_MAX_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 3600,
          count: 2000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600,
        },
      },
    });
  }
  return bullQueue;
}

export async function closeEmailQueue(): Promise<void> {
  if (bullQueue) {
    await bullQueue.close();
    bullQueue = null;
  }
}

export const emailQueue = {
  async add(name: string, data: EmailJobData, opts?: any): Promise<any> {
    const q = getBullQueue();
    if (q) {
      return await q.add(name, data, opts);
    }
    return createMemoryJob(name, data, opts);
  },

  async addBulk(jobs: Array<{ name: string; data: EmailJobData; opts?: any }>): Promise<any[]> {
    const q = getBullQueue();
    if (q) {
      return await q.addBulk(jobs);
    }
    return jobs.map((j) => createMemoryJob(j.name, j.data, j.opts));
  },

  async getJob(jobId: string): Promise<any> {
    const q = getBullQueue();
    if (q) {
      return await q.getJob(jobId);
    }
    assertQueueFallbackAllowed();
    return memoryJobs.get(jobId) || null;
  },

  async getJobCounts(..._types: string[]): Promise<{
    waiting: number;
    delayed: number;
    active: number;
    failed: number;
    completed: number;
  }> {
    const q = getBullQueue();
    if (q) {
      const c = await q.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
      return {
        waiting: c.waiting || 0,
        delayed: c.delayed || 0,
        active: c.active || 0,
        failed: c.failed || 0,
        completed: c.completed || 0,
      };
    }

    assertQueueFallbackAllowed();
    const now = Date.now();
    let waiting = 0;
    let delayed = 0;
    let active = 0;
    let failed = 0;
    let completed = 0;

    for (const j of memoryJobs.values()) {
      if (j.state === 'delayed' && j.runAt <= now) {
        j.state = 'waiting';
      }
      if (j.state === 'waiting') waiting++;
      else if (j.state === 'delayed') delayed++;
      else if (j.state === 'active') active++;
      else if (j.state === 'failed') failed++;
      else if (j.state === 'completed') completed++;
    }

    return { waiting, delayed, active, failed, completed };
  },

  _getMemoryJobs(): Map<string, InMemoryJob> {
    return memoryJobs;
  },

  _clearMemoryJobs(): void {
    memoryJobs.clear();
  },
};
