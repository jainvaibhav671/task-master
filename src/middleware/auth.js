import { prisma } from '../db.js';
import { verifyToken } from '../services/tokens.js';
import { unauthorized } from '../utils/errors.js';

const extractToken = (req) => {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
};

export const authenticate = async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next(unauthorized());
  const payload = await verifyToken(token);
  if (!payload) return next(unauthorized('Invalid or expired token'));
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return next(unauthorized('Invalid or expired token'));
  req.user = user;
  req.token = payload;
  next();
};
