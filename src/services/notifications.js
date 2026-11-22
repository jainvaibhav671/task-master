import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { createSubscriber, getRedis } from '../redis.js';

const CHANNEL = 'notifications';

// userId -> Set of open SSE responses on THIS instance. With Redis, every
// instance subscribes to one channel and delivers to its own connections, so
// a notification reaches the user whichever instance they're connected to.
const streams = new Map();
let subscriber = null;

const toJson = (n) => ({ ...n, data: n.data ? JSON.parse(n.data) : null });

export const sseFrame = (n) => `id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`;

const deliverLocal = (userId, notification) => {
  const set = streams.get(userId);
  if (!set) return;
  const frame = sseFrame(notification);
  for (const res of set) res.write(frame);
};

export const startNotificationHub = async () => {
  if (!getRedis() || subscriber) return;
  subscriber = createSubscriber();
  subscriber.on('message', (_channel, raw) => {
    try {
      const { userId, notification } = JSON.parse(raw);
      deliverLocal(userId, notification);
    } catch (err) {
      logger.error({ err }, 'bad notification message');
    }
  });
  await subscriber.subscribe(CHANNEL);
};

export const stopNotificationHub = async () => {
  // Ending the streams makes clients reconnect, through the load balancer, to
  // an instance that is still running; Last-Event-ID covers the gap.
  for (const set of streams.values()) for (const res of set) res.end();
  streams.clear();
  if (subscriber) await subscriber.quit().catch(() => {});
  subscriber = null;
};

export const subscribe = (userId, res) => {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  return () => {
    const set = streams.get(userId);
    set?.delete(res);
    if (set?.size === 0) streams.delete(userId);
  };
};

export const localStreamCount = () => [...streams.values()].reduce((n, s) => n + s.size, 0);

// Notifications the user has not received since `lastEventId`, oldest first.
export const missedSince = async (userId, lastEventId, limit = 100) => {
  const last = await prisma.notification.findFirst({
    where: { id: lastEventId, userId },
    select: { createdAt: true, id: true },
  });
  if (!last) return [];
  const rows = await prisma.notification.findMany({
    where: {
      userId,
      OR: [{ createdAt: { gt: last.createdAt } }, { createdAt: last.createdAt, id: { gt: last.id } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  return rows.map(toJson);
};

// Stores notifications in one insert and publishes them. Never notifies the
// actor about their own action. Failures are logged, not thrown, so a
// notification problem never fails the request that triggered it.
export const notify = async ({ userIds, actorId, type, message, data }) => {
  const targets = [...new Set(userIds.filter((id) => id && id !== actorId))];
  if (!targets.length) return;
  try {
    const payload = data ? JSON.stringify(data) : null;
    const rows = await prisma.notification.createManyAndReturn({
      data: targets.map((userId) => ({ userId, type, message, data: payload })),
    });
    const redis = getRedis();
    for (const row of rows) {
      const notification = toJson(row);
      if (redis) await redis.publish(CHANNEL, JSON.stringify({ userId: row.userId, notification }));
      else deliverLocal(row.userId, notification);
    }
  } catch (err) {
    logger.error({ err }, 'failed to send notification');
  }
};

export const serializeNotification = toJson;
