import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, registerUser } from './helpers.js';

test('register, login, profile, logout', async () => {
  const email = `alice-${Date.now()}@example.com`;
  const reg = await api().post('/api/v1/auth/register').send({ email, password: 'secret123', name: 'Alice' });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token);
  assert.equal(reg.body.user.passwordHash, undefined);

  const dup = await api().post('/api/v1/auth/register').send({ email, password: 'secret123', name: 'A' });
  assert.equal(dup.status, 409);

  const bad = await api().post('/api/v1/auth/login').send({ email, password: 'wrong-pass1' });
  assert.equal(bad.status, 401);

  const login = await api().post('/api/v1/auth/login').send({ email: email.toUpperCase(), password: 'secret123' });
  assert.equal(login.status, 200);
  const auth = { Authorization: `Bearer ${login.body.token}` };

  const me = await api().get('/api/v1/users/me').set(auth);
  assert.equal(me.status, 200);
  assert.equal(me.body.email, email);

  const upd = await api().patch('/api/v1/users/me').set(auth).send({ name: 'Alice B', bio: 'Hi' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Alice B');

  const out = await api().post('/api/v1/auth/logout').set(auth);
  assert.equal(out.status, 204);
  const after = await api().get('/api/v1/users/me').set(auth);
  assert.equal(after.status, 401);
});

test('validation errors are reported per field', async () => {
  const res = await api().post('/api/v1/auth/register').send({ email: 'nope', password: 'short', name: '' });
  assert.equal(res.status, 400);
  const paths = res.body.error.details.map((d) => d.path);
  assert.ok(paths.includes('email'));
  assert.ok(paths.includes('password'));
  assert.ok(paths.includes('name'));
});

test('protected routes reject missing and forged tokens', async () => {
  assert.equal((await api().get('/api/v1/tasks')).status, 401);
  const forged = await api().get('/api/v1/tasks').set({ Authorization: 'Bearer abc.def.ghi' });
  assert.equal(forged.status, 401);
});

test('changing password revokes the current token', async () => {
  const u = await registerUser('Pw');
  const wrong = await api().put('/api/v1/users/me/password').set(u.auth).send({ currentPassword: 'x', newPassword: 'newpass123' });
  assert.equal(wrong.status, 400);
  const ok = await api().put('/api/v1/users/me/password').set(u.auth).send({ currentPassword: 'secret123', newPassword: 'newpass123' });
  assert.equal(ok.status, 204);
  assert.equal((await api().get('/api/v1/users/me').set(u.auth)).status, 401);
  const login = await api().post('/api/v1/auth/login').send({ email: u.email, password: 'newpass123' });
  assert.equal(login.status, 200);
});
