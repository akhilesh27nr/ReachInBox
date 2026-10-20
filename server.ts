import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { config } from './src/config/env.js';
import { initDb, closeDb, getDatabaseEngine } from './src/db/db.js';
import { ensureRedisReady, redisClient } from './src/lib/redis.js';
import { seedSendersIfEmpty, clearTransporterPool } from './src/services/mailer.js';
import { loadReserveSlotScript } from './src/redis-scripts/loader.js';
import { startEmailWorker, stopEmailWorker } from './src/workers/email.worker.js';
import { closeEmailQueue } from './src/queues/email.queue.js';
import { execSync } from 'child_process';
import { reconcile } from './src/services/reconcile.js';
import { getQueueAdminRouter } from './src/queues/bullboard.js';
import {
  apiRouter,
  requireAuth,
  handleLiveness,
  handleReadiness,
  handleGoogleOAuthStart,
  handleGoogleOAuthCallback,
  handleSlackOAuthStart,
  handleSlackOAuthCallback,
} from './src/routes/api.js';

// Optional background redis-server start if installed in the container
try {
  execSync('which redis-server && (redis-cli ping || redis-server --daemonize yes --appendonly yes --maxmemory-policy noeviction)', {
    stdio: 'ignore',
  });
} catch {
  // Handled by ensureRedisReady() according to STRICT_INFRASTRUCTURE / ALLOW_EMBEDDED_FALLBACK
}

async function bootstrap() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // 1. Initialize relational database (PostgreSQL primary, or explicit embedded fallback)
  try {
    await initDb();
    console.log(`[Bootstrap] Relational database initialized (${getDatabaseEngine()}).`);
  } catch (dbErr: any) {
    console.error('[Bootstrap] Database initialization warning:', dbErr.message);
    if (config.STRICT_INFRASTRUCTURE && !process.env.K_SERVICE) {
      throw dbErr;
    }
  }

  // 2. Probe Redis availability
  try {
    const redisUp = await ensureRedisReady();
    console.log(`[Bootstrap] Queue engine mode: ${redisUp ? 'Redis BullMQ' : 'Embedded Fallback Queue'}`);
  } catch (redisErr: any) {
    console.error('[Bootstrap] Redis initialization warning:', redisErr.message);
    if (config.STRICT_INFRASTRUCTURE && !process.env.K_SERVICE) {
      throw redisErr;
    }
  }

  // 3. Mount top-level OAuth routes, Liveness/Readiness probes, Queue Monitor UI, and API routes
  app.get('/health', handleLiveness);
  app.get('/ready', handleReadiness);
  app.get(['/auth/google', '/auth/google/'], handleGoogleOAuthStart);
  app.get(['/auth/google/callback', '/auth/google/callback/'], handleGoogleOAuthCallback);
  app.get(['/auth/slack', '/auth/slack/'], requireAuth, handleSlackOAuthStart);
  app.get(['/auth/slack/callback', '/auth/slack/callback/'], requireAuth, handleSlackOAuthCallback);
  app.use('/admin/queues', getQueueAdminRouter());
  app.use('/api', apiRouter);

  // 4. Mount Vite in development or static dist in production
  const distIndex = path.resolve(process.cwd(), 'dist/index.html');
  if (config.NODE_ENV === 'production' && fs.existsSync(distIndex)) {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile(distIndex);
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // 5. Start HTTP server on configured config.PORT
  const PORT = config.PORT;
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 ReachInbox Scheduler listening on http://localhost:${PORT}`);
    console.log(`📊 Queue Monitor: http://localhost:${PORT}/admin/queues`);
    console.log(`⚡ API Endpoints: http://localhost:${PORT}/api`);
    console.log(`==================================================\n`);

    // 6. Run background worker & reconciliation initialization
    (async () => {
      try {
        await seedSendersIfEmpty();
        await loadReserveSlotScript();
        startEmailWorker();
        await reconcile();
      } catch (bgErr: any) {
        console.warn('[Bootstrap] Background initialization notice:', bgErr.message);
      }
    })();
  });

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nReceived ${signal}. Stopping HTTP listener, draining worker, and closing connections...`);

    // 1. Stop accepting new HTTP connections immediately
    const httpClosePromise = new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[Shutdown] HTTP server stopped accepting new connections.');
        resolve();
      });
      setTimeout(() => resolve(), 5000).unref();
    });

    // 2. Stop worker, wait for active jobs to finish, and release any unfinished PROCESSING claims
    const workerResult = await stopEmailWorker({ releaseClaims: true, drainTimeoutMs: 5000 });
    console.log(
      `[Shutdown] Worker stopped (drained=${workerResult.drained}, releasedClaims=${workerResult.releasedClaims}).`
    );

    // 3. Close queue, SMTP transporter pool, Redis, and Relational DB connections
    await closeEmailQueue();
    clearTransporterPool();
    await redisClient.quit().catch(() => {});
    await closeDb().catch(() => {});
    await httpClosePromise;

    console.log('[Shutdown] All resources closed cleanly. Exiting process.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[Fatal Error during bootstrap]', err);
  process.exit(1);
});
