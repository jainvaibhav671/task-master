import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config.js';
import { getRedis } from '../redis.js';

// With Redis the counters are shared by every instance, so a client can't
// get N times the limit by hitting N instances.
export const makeLimiter = ({ name, windowMs, limit, keyGenerator, message }) => {
  const redis = getRedis();
  return rateLimit({
    windowMs,
    limit: config.env === 'test' ? 10000 : limit,
    keyGenerator,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { message } },
    ...(redis && {
      store: new RedisStore({
        prefix: `rl:${name}:`,
        sendCommand: (command, ...args) => redis.call(command, ...args),
      }),
    }),
  });
};
