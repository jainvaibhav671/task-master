import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { getRedis } from './redis.js';
import { storage } from './storage/index.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import teamRoutes from './routes/teams.js';
import invitationRoutes from './routes/invitations.js';
import taskRoutes from './routes/tasks.js';
import notificationRoutes from './routes/notifications.js';
import aiRoutes from './routes/ai.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

// Flipped by the server on shutdown so the load balancer stops routing here
// while in-flight requests finish.
const state = { draining: false };
export const markDraining = () => {
  state.draining = true;
};

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  // Number of proxy hops to trust, so rate limits key on the real client IP.
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      // Reuse the load balancer's request id when there is one, so a request
      // can be traced across the proxy and every instance it touched.
      genReqId: (req, res) => {
        const id = req.headers['x-request-id'] || crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json({ limit: '1mb' }));

  // Liveness: the process is up.
  app.get('/health', (_req, res) => res.json({ status: 'ok', instance: config.instanceId }));

  // Readiness: this instance can serve traffic right now.
  app.get('/ready', async (_req, res) => {
    if (state.draining) return res.status(503).json({ status: 'draining' });
    const checks = {
      database: () => prisma.$queryRaw`SELECT 1`,
      redis: () => (getRedis() ? getRedis().ping() : 'disabled'),
      storage: () => storage.ready(),
    };
    // allSettled: every check gets a handler at once, so one failing fast can
    // never become an unhandled rejection that takes the process down.
    const names = Object.keys(checks);
    const settled = await Promise.allSettled(names.map((n) => withTimeout(Promise.resolve().then(checks[n]), 2000)));
    const results = {};
    let ok = true;
    settled.forEach((r, i) => {
      if (r.status === 'rejected') ok = false;
      results[names[i]] = r.status === 'rejected' ? 'failing' : r.value === 'disabled' ? 'disabled' : 'ok';
    });
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable', checks: results });
  });

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/teams', teamRoutes);
  api.use('/invitations', invitationRoutes);
  api.use('/tasks', taskRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/ai', aiRoutes);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
