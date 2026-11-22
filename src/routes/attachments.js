import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { isManager, loadTaskForUser } from '../services/access.js';
import { notify } from '../services/notifications.js';
import { multerEngine, storage } from '../storage/index.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { publicUserSelect } from '../utils/serialize.js';

// Mounted at /tasks/:taskId/attachments (authentication already applied).
const router = Router({ mergeParams: true });

// Uploads stream to the storage driver under a random key, never the
// client-supplied filename.
const upload = multer({
  storage: multerEngine,
  limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
});

const params = z.object({ taskId: z.string().min(1), attachmentId: z.string().min(1) });
const include = { uploader: { select: publicUserSelect } };

const loadAttachment = async (req) => {
  const ctx = await loadTaskForUser(req.params.taskId, req.user.id);
  const attachment = await prisma.attachment.findFirst({
    where: { id: req.params.attachmentId, taskId: ctx.task.id },
  });
  if (!attachment) throw notFound('Attachment');
  return { ...ctx, attachment };
};

export const removeStoredFile = (key) => storage.remove(key);

router.get('/', async (req, res) => {
  const { task } = await loadTaskForUser(req.params.taskId, req.user.id);
  const attachments = await prisma.attachment.findMany({
    where: { taskId: task.id },
    include,
    orderBy: { createdAt: 'asc' },
  });
  res.json(attachments);
});

// Check access before accepting the upload, so outsiders cannot write to disk.
router.post(
  '/',
  async (req, _res, next) => {
    req.taskCtx = await loadTaskForUser(req.params.taskId, req.user.id);
    next();
  },
  upload.single('file'),
  async (req, res) => {
    if (!req.file) throw badRequest('Send the file as multipart/form-data in a field named "file"');
    const { task } = req.taskCtx;
    try {
      const attachment = await prisma.attachment.create({
        data: {
          taskId: task.id,
          uploaderId: req.user.id,
          originalName: path.basename(req.file.originalname).slice(0, 255),
          storageKey: req.file.key,
          mimeType: req.file.mimetype,
          size: req.file.size,
        },
        include,
      });
      await notify({
        userIds: [task.creatorId, task.assigneeId],
        actorId: req.user.id,
        type: 'TASK_UPDATED',
        message: `${req.user.name} attached ${attachment.originalName} to "${task.title}"`,
        data: { taskId: task.id, attachmentId: attachment.id },
      });
      res.status(201).json(attachment);
    } catch (err) {
      await removeStoredFile(req.file.key);
      throw err;
    }
  },
);

router.get('/:attachmentId/download', validate({ params }), async (req, res) => {
  const { attachment } = await loadAttachment(req);
  await storage.sendDownload(res, attachment);
});

router.delete('/:attachmentId', validate({ params }), async (req, res) => {
  const { task, attachment, membership } = await loadAttachment(req);
  const allowed =
    attachment.uploaderId === req.user.id || task.creatorId === req.user.id || isManager(membership);
  if (!allowed) throw forbidden('You cannot delete this attachment');
  await prisma.attachment.delete({ where: { id: attachment.id } });
  await removeStoredFile(attachment.storageKey);
  res.status(204).end();
});

export default router;
