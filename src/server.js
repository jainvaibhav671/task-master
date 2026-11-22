import { createApp, markDraining } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { closeRedis } from './redis.js';
import { startNotificationHub, stopNotificationHub } from './services/notifications.js';

await startNotificationHub();
if (!config.redisUrl) {
  logger.warn('REDIS_URL is not set: running in single-instance mode (rate limits and live notifications are per process)');
}

const server = createApp().listen(config.port, () => {
  logger.info({ port: config.port }, 'Task Master API listening');
});
// Keep idle keep-alive sockets open longer than the load balancer does, so
// the balancer never reuses a socket this server has just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  markDraining();
  // Close SSE streams first: they never end on their own and would hold
  // server.close() open. Clients reconnect to another instance.
  await stopNotificationHub();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const force = setTimeout(() => {
    logger.warn('forcing remaining connections closed');
    server.closeAllConnections();
  }, 10_000);
  await closed;
  clearTimeout(force);
  await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
