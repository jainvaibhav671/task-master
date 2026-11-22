import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, app, createTeam, registerUser } from './helpers.js';

test('team invitations', async () => {
  const owner = await registerUser('Owner');
  const invitee = await registerUser('Invitee');
  const team = await api().post('/api/v1/teams').set(owner.auth).send({ name: 'Core', description: 'Core team' });
  assert.equal(team.status, 201);
  assert.equal(team.body.members[0].role, 'OWNER');

  const inv = await api().post(`/api/v1/teams/${team.body.id}/invitations`).set(owner.auth).send({ email: invitee.email });
  assert.equal(inv.status, 201);
  const dup = await api().post(`/api/v1/teams/${team.body.id}/invitations`).set(owner.auth).send({ email: invitee.email });
  assert.equal(dup.status, 409);

  // The invitee cannot see the team before accepting.
  assert.equal((await api().get(`/api/v1/teams/${team.body.id}`).set(invitee.auth)).status, 404);

  const pending = await api().get('/api/v1/invitations').set(invitee.auth);
  assert.equal(pending.body.length, 1);
  assert.equal(pending.body[0].team.name, 'Core');

  assert.equal((await api().post(`/api/v1/invitations/${inv.body.id}/accept`).set(invitee.auth)).status, 200);
  assert.equal((await api().post(`/api/v1/invitations/${inv.body.id}/accept`).set(invitee.auth)).status, 409);

  const detail = await api().get(`/api/v1/teams/${team.body.id}`).set(invitee.auth);
  assert.equal(detail.body.members.length, 2);

  // Members cannot invite; only owners and admins can.
  const memberInvite = await api().post(`/api/v1/teams/${team.body.id}/invitations`).set(invitee.auth).send({ email: 'x@example.com' });
  assert.equal(memberInvite.status, 403);
});

test('comments and attachments', async () => {
  const owner = await registerUser('Owner');
  const member = await registerUser('Member');
  const outsider = await registerUser('Outsider');
  const team = await createTeam(owner, [member]);
  const task = (await api().post('/api/v1/tasks').set(owner.auth).send({ title: 'Doc', teamId: team.id })).body;
  const base = `/api/v1/tasks/${task.id}`;

  const c = await api().post(`${base}/comments`).set(member.auth).send({ body: 'Looks good' });
  assert.equal(c.status, 201);
  assert.equal(c.body.author.id, member.id);
  assert.equal((await api().patch(`${base}/comments/${c.body.id}`).set(owner.auth).send({ body: 'hijack' })).status, 403);
  const edited = await api().patch(`${base}/comments/${c.body.id}`).set(member.auth).send({ body: 'Looks great' });
  assert.equal(edited.body.body, 'Looks great');
  assert.equal((await api().get(`${base}/comments`).set(outsider.auth)).status, 404);

  const up = await api().post(`${base}/attachments`).set(member.auth).attach('file', Buffer.from('hello world'), 'notes.txt');
  assert.equal(up.status, 201);
  assert.equal(up.body.originalName, 'notes.txt');
  assert.equal(up.body.size, 11);

  const dl = await api().get(`${base}/attachments/${up.body.id}/download`).set(owner.auth).buffer(true);
  assert.equal(dl.status, 200);
  assert.equal(dl.text ?? dl.body.toString(), 'hello world');
  assert.match(dl.headers['content-disposition'], /attachment; filename="?notes.txt"?/);

  const blocked = await api().post(`${base}/attachments`).set(outsider.auth).attach('file', Buffer.from('x'), 'x.txt');
  assert.equal(blocked.status, 404);

  const list = await api().get(`${base}/attachments`).set(owner.auth);
  assert.equal(list.body.length, 1);
  assert.equal((await api().delete(`${base}/attachments/${up.body.id}`).set(owner.auth)).status, 204);
});

test('notifications are stored and streamed over SSE', async () => {
  const owner = await registerUser('Owner');
  const member = await registerUser('Member');
  const team = await createTeam(owner, [member]);

  const server = http.createServer(app).listen(0);
  const { port } = server.address();
  const received = new Promise((resolve, reject) => {
    const req = http.get(
      `http://localhost:${port}/api/v1/notifications/stream?access_token=${member.token}`,
      (res) => {
        if (!res.headers['content-type']?.startsWith('text/event-stream')) {
          req.destroy();
          return reject(new Error(`unexpected content-type ${res.headers['content-type']}`));
        }
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('event: notification')) {
            req.destroy();
            resolve(buf);
          } else if (buf.includes('event: connected')) {
            // Stream is live: trigger an assignment.
            api().post('/api/v1/tasks').set(owner.auth)
              .send({ title: 'Ship it', teamId: team.id, assigneeId: member.id })
              .catch(reject);
          }
        });
      },
    );
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });

  const timeout = setTimeout(() => server.closeAllConnections(), 5000);
  const frame = await received.finally(() => {
    clearTimeout(timeout);
    server.closeAllConnections();
    server.close();
  });
  assert.match(frame, /TASK_ASSIGNED/);
  assert.match(frame, /Ship it/);

  const list = await api().get('/api/v1/notifications?unread=true').set(member.auth);
  const assigned = list.body.data.find((n) => n.type === 'TASK_ASSIGNED');
  assert.ok(assigned);
  assert.ok(assigned.data.taskId);
  assert.equal((await api().patch(`/api/v1/notifications/${assigned.id}/read`).set(member.auth)).status, 204);
  assert.equal((await api().patch(`/api/v1/notifications/${assigned.id}/read`).set(owner.auth)).status, 404);
});

test('AI endpoints report when not configured', async () => {
  const u = await registerUser('Ai');
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const res = await api().post('/api/v1/ai/task-description').set(u.auth).send({ title: 'Migrate DB' });
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  assert.equal(res.status, 503);
});

test('unknown routes return JSON 404', async () => {
  const res = await api().get('/api/v1/nope');
  assert.equal(res.status, 404);
  assert.ok(res.body.error.message);
});
