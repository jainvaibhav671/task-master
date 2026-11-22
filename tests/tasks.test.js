import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, createTeam, registerUser } from './helpers.js';

test('task CRUD, completion, filtering, search and sorting', async () => {
  const u = await registerUser('Tasker');
  const mk = (body) => api().post('/api/v1/tasks').set(u.auth).send(body);

  const a = await mk({ title: 'Write report', description: 'Quarterly numbers', dueDate: '2030-01-10', priority: 'HIGH' });
  assert.equal(a.status, 201);
  assert.equal(a.body.status, 'OPEN');
  await mk({ title: 'Fix login bug', priority: 'LOW', dueDate: '2030-01-05' });
  await mk({ title: 'Plan offsite', description: 'Book the REPORT room', priority: 'MEDIUM' });

  const done = await api().patch(`/api/v1/tasks/${a.body.id}`).set(u.auth).send({ status: 'COMPLETED' });
  assert.equal(done.status, 200);
  assert.ok(done.body.completedAt);

  const completed = await api().get('/api/v1/tasks?status=completed').set(u.auth);
  assert.deepEqual(completed.body.data.map((t) => t.title), ['Write report']);

  const open = await api().get('/api/v1/tasks?status=OPEN,IN_PROGRESS').set(u.auth);
  assert.equal(open.body.pagination.total, 2);

  const search = await api().get('/api/v1/tasks?q=report').set(u.auth);
  assert.equal(search.body.data.length, 2, 'matches title and description, case-insensitively');

  const byPriority = await api().get('/api/v1/tasks?sort=-priority').set(u.auth);
  assert.deepEqual(byPriority.body.data.map((t) => t.priority), ['HIGH', 'MEDIUM', 'LOW']);

  const byDue = await api().get('/api/v1/tasks?sort=dueDate').set(u.auth);
  assert.deepEqual(byDue.body.data.map((t) => t.title), ['Fix login bug', 'Write report', 'Plan offsite']);

  const paged = await api().get('/api/v1/tasks?limit=2&page=2').set(u.auth);
  assert.equal(paged.body.data.length, 1);
  assert.equal(paged.body.pagination.totalPages, 2);

  const badSort = await api().get('/api/v1/tasks?sort=password').set(u.auth);
  assert.equal(badSort.status, 400);

  const reopen = await api().patch(`/api/v1/tasks/${a.body.id}`).set(u.auth).send({ status: 'OPEN' });
  assert.equal(reopen.body.completedAt, null);

  assert.equal((await api().delete(`/api/v1/tasks/${a.body.id}`).set(u.auth)).status, 204);
  assert.equal((await api().get(`/api/v1/tasks/${a.body.id}`).set(u.auth)).status, 404);
});

test('team assignment rules and visibility', async () => {
  const owner = await registerUser('Owner');
  const member = await registerUser('Member');
  const outsider = await registerUser('Outsider');
  const team = await createTeam(owner, [member]);

  const task = await api()
    .post('/api/v1/tasks')
    .set(owner.auth)
    .send({ title: 'Team task', teamId: team.id, assigneeId: member.id });
  assert.equal(task.status, 201);
  assert.equal(task.body.assignee.id, member.id);

  const mine = await api().get('/api/v1/tasks?assignee=me').set(member.auth);
  assert.deepEqual(mine.body.data.map((t) => t.id), [task.body.id]);

  // Outsiders can neither see the task nor be assigned to it.
  assert.equal((await api().get(`/api/v1/tasks/${task.body.id}`).set(outsider.auth)).status, 404);
  const badAssign = await api().patch(`/api/v1/tasks/${task.body.id}`).set(owner.auth).send({ assigneeId: outsider.id });
  assert.equal(badAssign.status, 400);
  const notMember = await api().post('/api/v1/tasks').set(outsider.auth).send({ title: 'x', teamId: team.id });
  assert.equal(notMember.status, 404);

  // Personal tasks cannot be assigned to someone else.
  const personal = await api().post('/api/v1/tasks').set(owner.auth).send({ title: 'p', assigneeId: member.id });
  assert.equal(personal.status, 400);

  // A plain member can update but not delete a task someone else created.
  const upd = await api().patch(`/api/v1/tasks/${task.body.id}`).set(member.auth).send({ status: 'IN_PROGRESS' });
  assert.equal(upd.status, 200);
  assert.equal((await api().delete(`/api/v1/tasks/${task.body.id}`).set(member.auth)).status, 403);

  // Removing a member unassigns their tasks in that team.
  assert.equal((await api().delete(`/api/v1/teams/${team.id}/members/${member.id}`).set(owner.auth)).status, 204);
  const after = await api().get(`/api/v1/tasks/${task.body.id}`).set(owner.auth);
  assert.equal(after.body.assignee, null);
});
