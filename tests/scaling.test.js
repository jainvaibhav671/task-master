import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { api, createTeam, registerUser } from './helpers.js';
import { config } from '../src/config.js';
import { createS3Driver } from '../src/storage/s3.js';

// Reads an SSE stream until `until(buffer)` is true, then closes it.
const readSse = (url, headers, until, onOpen = () => {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
      let buf = '';
      let opened = false;
      res.on('data', (chunk) => {
        buf += chunk;
        if (!opened && buf.includes('event: connected')) {
          opened = true;
          Promise.resolve(onOpen()).catch(reject);
        }
        if (until(buf)) {
          req.destroy();
          resolve(buf);
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => {
      req.destroy();
      reject(new Error('timed out waiting for SSE event'));
    }, 10_000);
  });

const startInstance = (port) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(port), INSTANCE_ID: 'second', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => d.toString().includes('listening') && resolve(child));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => reject(new Error(`second instance exited with ${code}`)));
  });

test('cursor pagination walks every task exactly once, in order', async () => {
  const u = await registerUser('Pager');
  // Repeated and missing due dates exercise ties and nulls-last.
  for (let i = 0; i < 23; i++) {
    const dueDate = i % 4 === 0 ? null : `2030-01-${String((i % 5) + 1).padStart(2, '0')}`;
    await api().post('/api/v1/tasks').set(u.auth).send({ title: `T${i}`, dueDate, priority: ['LOW', 'MEDIUM', 'HIGH'][i % 3] });
  }

  for (const sort of ['dueDate', '-dueDate', '-priority', 'title', '-createdAt']) {
    const all = await api().get(`/api/v1/tasks?sort=${sort}&limit=100`).set(u.auth);
    const expected = all.body.data.map((t) => t.id);
    assert.equal(expected.length, 23);

    const seen = [];
    let cursor = null;
    let first = true;
    while (first || cursor) {
      const qs = `sort=${sort}&limit=5${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await api().get(`/api/v1/tasks?${qs}`).set(u.auth);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      seen.push(...page.body.data.map((t) => t.id));
      cursor = page.body.pagination.nextCursor;
      first = false;
    }
    assert.deepEqual(seen, expected, `cursor order matches for sort=${sort}`);
  }

  const first = await api().get('/api/v1/tasks?sort=title&limit=5').set(u.auth);
  const mismatch = await api().get(`/api/v1/tasks?sort=dueDate&cursor=${first.body.pagination.nextCursor}`).set(u.auth);
  assert.equal(mismatch.status, 400);
  assert.equal((await api().get('/api/v1/tasks?cursor=garbage').set(u.auth)).status, 400);
});

test('search is case-insensitive on Postgres', async () => {
  const u = await registerUser('Search');
  await api().post('/api/v1/tasks').set(u.auth).send({ title: 'Quarterly REPORT', description: 'numbers' });
  const res = await api().get('/api/v1/tasks?q=report').set(u.auth);
  assert.equal(res.body.data.length, 1);
});

test('a notification raised on one instance reaches a stream on another', { skip: !config.redisUrl && 'needs REDIS_URL' }, async () => {
  const owner = await registerUser('Owner');
  const member = await registerUser('Member');
  const team = await createTeam(owner, [member]);

  const port = 40000 + Math.floor(Math.random() * 10000);
  const second = await startInstance(port);
  try {
    // The stream is held by the second process; the assignment is made
    // through this process. Only Redis connects them.
    const frames = await readSse(
      `http://localhost:${port}/api/v1/notifications/stream`,
      { Authorization: `Bearer ${member.token}` },
      (buf) => buf.includes('event: notification'),
      () => api().post('/api/v1/tasks').set(owner.auth).send({ title: 'Cross-instance', teamId: team.id, assigneeId: member.id }),
    );
    assert.match(frames, /Cross-instance/);
    assert.match(frames, /^id: /m);
  } finally {
    second.kill('SIGTERM');
  }
});

test('a reconnecting stream replays what it missed via Last-Event-ID', async () => {
  const owner = await registerUser('Owner');
  const member = await registerUser('Member');
  const team = await createTeam(owner, [member]);
  const mk = (title) => api().post('/api/v1/tasks').set(owner.auth).send({ title, teamId: team.id, assigneeId: member.id });

  await mk('Seen');
  const seen = (await api().get('/api/v1/notifications').set(member.auth)).body.data[0];
  await mk('Missed 1');
  await mk('Missed 2');

  const server = http.createServer((await import('./helpers.js')).app).listen(0);
  try {
    const frames = await readSse(
      `http://localhost:${server.address().port}/api/v1/notifications/stream`,
      { Authorization: `Bearer ${member.token}`, 'Last-Event-ID': seen.id },
      (buf) => buf.includes('Missed 2'),
    );
    assert.ok(frames.indexOf('Missed 1') < frames.indexOf('Missed 2'));
    assert.ok(!frames.includes('"Seen"'));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('notifications page with a cursor', async () => {
  const owner = await registerUser('Owner');
  const member = await registerUser('Member');
  const team = await createTeam(owner, [member]);
  for (let i = 0; i < 5; i++) {
    await api().post('/api/v1/tasks').set(owner.auth).send({ title: `N${i}`, teamId: team.id, assigneeId: member.id });
  }
  const p1 = await api().get('/api/v1/notifications?limit=3').set(member.auth);
  assert.equal(p1.body.data.length, 3);
  const p2 = await api().get(`/api/v1/notifications?limit=3&cursor=${p1.body.pagination.nextCursor}`).set(member.auth);
  // The member has 6: the team invitation plus 5 assignments.
  assert.equal(p2.body.data.length, 3);
  assert.equal(p2.body.pagination.nextCursor, null);
  const paged = [...p1.body.data, ...p2.body.data].map((n) => n.id);
  const all = (await api().get('/api/v1/notifications?limit=100').set(member.auth)).body.data.map((n) => n.id);
  assert.deepEqual(paged, all);
});

test('uploads over the size limit are rejected and not kept', async () => {
  const u = await registerUser('Big');
  const task = (await api().post('/api/v1/tasks').set(u.auth).send({ title: 'big' })).body;
  const big = Buffer.alloc(config.storage.maxUploadBytes + 1024, 1);
  const res = await api().post(`/api/v1/tasks/${task.id}/attachments`).set(u.auth).attach('file', big, 'big.bin');
  assert.equal(res.status, 413);
  const list = await api().get(`/api/v1/tasks/${task.id}/attachments`).set(u.auth);
  assert.equal(list.body.length, 0);
});

test('S3 driver stores, signs and deletes objects', { skip: !process.env.TEST_S3_ENDPOINT && 'needs TEST_S3_ENDPOINT' }, async () => {
  process.env.S3_CREATE_BUCKET = 'true';
  const driver = createS3Driver({
    bucket: 'task-attachments-test',
    region: 'us-east-1',
    endpoint: process.env.TEST_S3_ENDPOINT,
    publicEndpoint: process.env.TEST_S3_ENDPOINT,
    forcePathStyle: true,
    downloadUrlTtl: 60,
  });
  const { Readable } = await import('node:stream');
  const key = `attachments/test-${Date.now()}`;
  const size = await driver.write(key, Readable.from([Buffer.from('hello '), Buffer.from('s3')]), 'text/plain');
  assert.equal(size, 8);

  let location;
  const fakeRes = { redirect: (status, url) => { assert.equal(status, 302); location = url; } };
  await driver.sendDownload(fakeRes, { storageKey: key, originalName: 'hi there.txt', mimeType: 'text/plain' });
  const fetched = await fetch(location);
  assert.equal(await fetched.text(), 'hello s3');
  assert.match(fetched.headers.get('content-disposition'), /hi%20there\.txt/);

  await driver.remove(key);
  assert.equal((await fetch(location)).status, 404);
});

test('readiness reports each dependency', async () => {
  const res = await api().get('/ready');
  assert.equal(res.status, 200);
  assert.equal(res.body.checks.database, 'ok');
  assert.equal(res.body.checks.redis, config.redisUrl ? 'ok' : 'disabled');
  assert.ok(res.headers['x-request-id']);
});

test('a failing dependency makes /ready report 503 instead of crashing', async () => {
  const { storage } = await import('../src/storage/index.js');
  const original = storage.ready;
  storage.ready = async () => {
    throw new Error('bucket missing');
  };
  try {
    const res = await api().get('/ready');
    assert.equal(res.status, 503);
    assert.equal(res.body.checks.storage, 'failing');
    assert.equal(res.body.checks.database, 'ok');
  } finally {
    storage.ready = original;
  }
});
