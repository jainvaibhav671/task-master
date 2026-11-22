import multer from 'multer';
import { Prisma } from '@prisma/client';
import { HttpError } from '../utils/errors.js';
import { logger } from '../logger.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: { message: err.message } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: { message: 'Resource already exists' } });
    if (err.code === 'P2025') return res.status(404).json({ error: { message: 'Resource not found' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Malformed JSON body' } });
  }
  (req.log ?? logger).error({ err }, 'unhandled error');
  res.status(500).json({ error: { message: 'Internal server error' } });
};
