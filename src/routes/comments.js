import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { isManager, loadTaskForUser } from '../services/access.js';
import { notify } from '../services/notifications.js';
import { forbidden, notFound } from '../utils/errors.js';
import { publicUserSelect } from '../utils/serialize.js';

// Mounted at /tasks/:taskId/comments (authentication already applied).
const router = Router({ mergeParams: true });

const body = z.object({ body: z.string().trim().min(1).max(5000) });
const commentParams = z.object({ taskId: z.string().min(1), commentId: z.string().min(1) });
const include = { author: { select: publicUserSelect } };

const loadComment = async (req) => {
  const ctx = await loadTaskForUser(req.params.taskId, req.user.id);
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, taskId: ctx.task.id },
  });
  if (!comment) throw notFound('Comment');
  return { ...ctx, comment };
};

router.get('/', async (req, res) => {
  const { task } = await loadTaskForUser(req.params.taskId, req.user.id);
  const comments = await prisma.comment.findMany({
    where: { taskId: task.id },
    include,
    orderBy: { createdAt: 'asc' },
  });
  res.json(comments);
});

router.post('/', validate({ body }), async (req, res) => {
  const { task } = await loadTaskForUser(req.params.taskId, req.user.id);
  const comment = await prisma.comment.create({
    data: { taskId: task.id, authorId: req.user.id, body: req.body.body },
    include,
  });
  await notify({
    userIds: [task.creatorId, task.assigneeId],
    actorId: req.user.id,
    type: 'TASK_COMMENTED',
    message: `${req.user.name} commented on "${task.title}"`,
    data: { taskId: task.id, commentId: comment.id },
  });
  res.status(201).json(comment);
});

router.patch('/:commentId', validate({ params: commentParams, body }), async (req, res) => {
  const { comment } = await loadComment(req);
  if (comment.authorId !== req.user.id) throw forbidden('You can only edit your own comments');
  const updated = await prisma.comment.update({
    where: { id: comment.id },
    data: { body: req.body.body },
    include,
  });
  res.json(updated);
});

router.delete('/:commentId', validate({ params: commentParams }), async (req, res) => {
  const { comment, membership } = await loadComment(req);
  if (comment.authorId !== req.user.id && !isManager(membership)) {
    throw forbidden('You can only delete your own comments');
  }
  await prisma.comment.delete({ where: { id: comment.id } });
  res.status(204).end();
});

export default router;
