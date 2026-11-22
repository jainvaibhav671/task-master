import crypto from 'node:crypto';
import { after } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { closeRedis } from '../src/redis.js';
import { startNotificationHub, stopNotificationHub } from '../src/services/notifications.js';

await startNotificationHub();
after(async () => {
  await stopNotificationHub();
  await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
});

export const app = createApp();
export const api = () => request(app);

export const registerUser = async (name = 'User') => {
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ email, password: 'secret123', name });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.token, auth: { Authorization: `Bearer ${res.body.token}` } };
};

// Creates a team owned by `owner` and adds every user in `members` through
// the real invite + accept flow.
export const createTeam = async (owner, members = []) => {
  const team = await api().post('/api/v1/teams').set(owner.auth).send({ name: 'Team' });
  for (const m of members) {
    const inv = await api()
      .post(`/api/v1/teams/${team.body.id}/invitations`)
      .set(owner.auth)
      .send({ email: m.email });
    await api().post(`/api/v1/invitations/${inv.body.id}/accept`).set(m.auth);
  }
  return team.body;
};
