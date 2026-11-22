import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { makeLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { signToken, revokeToken } from '../services/tokens.js';
import { conflict, unauthorized } from '../utils/errors.js';
import { profileSelect } from '../utils/serialize.js';

const router = Router();

const authLimiter = makeLimiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many attempts, try again later',
});

const email = z.string().trim().toLowerCase().email().max(254);
export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters') // bcrypt input limit
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(100),
});

const loginSchema = z.object({ email, password: z.string().min(1) });

const tokenResponse = (user) => ({
  token: signToken(user.id),
  tokenType: 'Bearer',
  expiresIn: config.jwtExpiresIn,
  user,
});

router.post('/register', authLimiter, validate({ body: registerSchema }), async (req, res) => {
  const { email, password, name } = req.body;
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await prisma.user.create({
    data: { email, name, passwordHash },
    select: profileSelect,
  });
  res.status(201).json(tokenResponse(user));
});

// Hash compared against when the email is unknown, so response time does not
// reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/login', authLimiter, validate({ body: loginSchema }), async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email or password');

  const { passwordHash: _omit, ...profile } = user;
  res.json(tokenResponse(profile));
});

router.post('/logout', authenticate, async (req, res) => {
  await revokeToken(req.token);
  res.status(204).end();
});

export default router;
