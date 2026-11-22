import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

let client = null;

// Shared command connection, or null when REDIS_URL is not set.
export const getRedis = () => {
  if (!config.redisUrl) return null;
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    client.on('error', (err) => logger.error({ err }, 'redis error'));
  }
  return client;
};

// Pub/sub needs its own connection: a subscribed connection can't run other commands.
export const createSubscriber = () => {
  const sub = new Redis(config.redisUrl);
  sub.on('error', (err) => logger.error({ err }, 'redis subscriber error'));
  return sub;
};

export const closeRedis = async () => {
  if (client) await client.quit().catch(() => {});
  client = null;
};
