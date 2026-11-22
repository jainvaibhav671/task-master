import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';

export const signToken = (userId) =>
  jwt.sign({ sub: userId, jti: crypto.randomUUID() }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

// Returns the decoded payload, or null when the token is invalid or revoked.
export const verifyToken = async (token) => {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
  const revoked = await prisma.revokedToken.findUnique({ where: { jti: payload.jti } });
  return revoked ? null : payload;
};

export const revokeToken = async (payload) => {
  await prisma.revokedToken.upsert({
    where: { jti: payload.jti },
    create: { jti: payload.jti, expiresAt: new Date(payload.exp * 1000) },
    update: {},
  });
  // Opportunistic cleanup of entries whose tokens would have expired anyway.
  await prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
};
