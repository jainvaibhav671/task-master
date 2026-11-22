import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { revokeToken } from '../services/tokens.js';
import { badRequest } from '../utils/errors.js';
import { profileSelect } from '../utils/serialize.js';
import { password } from './auth.js';

const router = Router();
router.use(authenticate);

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    bio: z.string().trim().max(500).nullable().optional(),
    avatarUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

router.get('/me', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: profileSelect });
  res.json(user);
});

router.patch('/me', validate({ body: updateSchema }), async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: req.body,
    select: profileSelect,
  });
  res.json(user);
});

// Changing the password also logs out the current token; the client logs in again.
router.put('/me/password', validate({ body: passwordSchema }), async (req, res) => {
  const ok = await bcrypt.compare(req.body.currentPassword, req.user.passwordHash);
  if (!ok) throw badRequest('Current password is incorrect');
  const passwordHash = await bcrypt.hash(req.body.newPassword, config.bcryptRounds);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
  await revokeToken(req.token);
  res.status(204).end();
});

export default router;
