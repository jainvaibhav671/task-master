import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { missedSince, serializeNotification, sseFrame, subscribe } from '../services/notifications.js';
import { notFound } from '../utils/errors.js';
import { afterCursor, decodeCursor, encodeCursor } from '../utils/cursor.js';

const router = Router();

// Browsers' EventSource cannot set headers, so the stream also accepts the
// token as ?access_token=. Only this route reads it from the query string.
const tokenFromQuery = (req, _res, next) => {
  if (!req.get('authorization') && typeof req.query.access_token === 'string') {
    req.headers.authorization = `Bearer ${req.query.access_token}`;
  }
  next();
};

router.get('/stream', tokenFromQuery, authenticate, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Tell the browser how soon to reconnect if this instance goes away.
  res.write(`retry: 3000\nevent: connected\ndata: ${JSON.stringify({ userId: req.user.id })}\n\n`);

  // Subscribe before replaying so nothing published in between is lost. A
  // notification can then arrive twice; clients should ignore repeated ids.
  const unsubscribe = subscribe(req.user.id, res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  const lastEventId = req.get('last-event-id') ?? req.query.lastEventId;
  if (typeof lastEventId === 'string' && lastEventId) {
    for (const n of await missedSince(req.user.id, lastEventId)) res.write(sseFrame(n));
  }
});

router.use(authenticate);

const listQuery = z.object({
  unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Newest first, paged with a cursor.
router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { unread, limit, cursor } = req.validatedQuery;
  const SORT = '-createdAt';
  const where = {
    AND: [
      { userId: req.user.id },
      unread ? { read: false } : {},
      cursor ? afterCursor({ column: 'createdAt', direction: 'desc' }, decodeCursor(cursor, SORT)) : {},
    ],
  };
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit + 1 }),
    prisma.notification.count({ where: { userId: req.user.id, read: false } }),
  ]);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  res.json({
    data: items.map(serializeNotification),
    unreadCount,
    pagination: { limit, nextCursor: hasMore ? encodeCursor(SORT, last.createdAt, last.id) : null },
  });
});

router.post('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, read: false }, data: { read: true } });
  res.status(204).end();
});

router.patch(
  '/:notificationId/read',
  validate({ params: z.object({ notificationId: z.string().min(1) }) }),
  async (req, res) => {
    const { count } = await prisma.notification.updateMany({
      where: { id: req.params.notificationId, userId: req.user.id },
      data: { read: true },
    });
    if (!count) throw notFound('Notification');
    res.status(204).end();
  },
);

export default router;
