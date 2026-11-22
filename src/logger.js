import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { instance: config.instanceId },
  redact: ['req.headers.authorization', 'req.headers.cookie', 'req.query.access_token'],
});
