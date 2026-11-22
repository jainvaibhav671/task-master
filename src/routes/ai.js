import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { makeLimiter } from '../middleware/rateLimit.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { loadTaskForUser } from '../services/access.js';
import { generateDescription, summarizeTask } from '../services/ai.js';

const router = Router();
router.use(authenticate);
router.use(
  makeLimiter({
    name: 'ai',
    windowMs: 60 * 1000,
    limit: 10,
    keyGenerator: (req) => req.user.id,
    message: 'Too many AI requests, slow down',
  }),
);

const descriptionBody = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).optional(),
});

// Returns a suggested description; the client decides whether to save it.
router.post('/task-description', validate({ body: descriptionBody }), async (req, res) => {
  const description = await generateDescription(req.body);
  res.json({ description });
});

router.post(
  '/tasks/:taskId/summary',
  validate({ params: z.object({ taskId: z.string().min(1) }) }),
  async (req, res) => {
    const { task } = await loadTaskForUser(req.params.taskId, req.user.id);
    const comments = await prisma.comment.findMany({
      where: { taskId: task.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const summary = await summarizeTask(task, comments);
    res.json({ summary });
  },
);

export default router;
