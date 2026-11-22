import os from 'node:os';
import 'dotenv/config';

const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

export const config = {
  env,
  isProd,
  port: Number(process.env.PORT ?? 3000),
  instanceId: process.env.INSTANCE_ID ?? os.hostname(),
  logLevel: process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
  // A dev-only default keeps local setup simple; production must set its own.
  jwtSecret: required('JWT_SECRET', isProd ? undefined : 'dev-only-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  trustProxy: process.env.TRUST_PROXY ?? '1',
  // Without Redis the app runs as a single instance: rate limits and live
  // notifications stay in this process. Set REDIS_URL to run several.
  redisUrl: process.env.REDIS_URL || null,
  storage: {
    driver: process.env.STORAGE_DRIVER ?? 'local', // local | s3
    localDir: process.env.UPLOAD_DIR ?? 'uploads',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024,
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      downloadUrlTtl: Number(process.env.S3_DOWNLOAD_URL_TTL ?? 300),
    },
  },
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
};

if (config.storage.driver === 's3' && !config.storage.s3.bucket) {
  throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
}
