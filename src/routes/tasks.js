import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  canDeleteTask,
  getMembership,
  loadTaskForUser,
  requireMembership,
  visibleTasksWhere,
} from '../services/access.js';
import { notify } from '../services/notifications.js';
import { badRequest, forbidden } from '../utils/errors.js';
import { afterCursor, decodeCursor, encodeCursor } from '../utils/cursor.js';
import { publicUserSelect } from '../utils/serialize.js';
import commentsRouter from './comments.js';
import attachmentsRouter, { removeStoredFile } from './attachments.js';

const router = Router();
router.use(authenticate);

export const STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
const SORTABLE = ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title', 'status'];

const taskInclude = {
  creator: { select: publicUserSelect },
  assignee: { select: publicUserSelect },
  team: { select: { id: true, name: true } },
  _count: { select: { comments: true, attachments: true } },
};

const id = z.string().min(1);

const fields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).nullable(),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  dueDate: z.coerce.date().nullable(),
  assigneeId: id.nullable(),
};

const createSchema = z.object({
  ...fields,
  description: fields.description.optional(),
  status: fields.status.default('OPEN'),
  priority: fields.priority.default('MEDIUM'),
  dueDate: fields.dueDate.optional(),
  assigneeId: fields.assigneeId.optional(),
  teamId: id.nullable().optional(),
});

// No defaults here: a field left out of a PATCH must stay unchanged.
// The team is fixed after creation.
const updateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const csvEnum = (values) =>
  z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1));

const listQuery = z.object({
  status: csvEnum(STATUSES).optional(),
  priority: csvEnum(PRIORITIES).optional(),
  assignee: z.string().optional(), // "me", "unassigned" or a user id
  createdBy: z.string().optional(), // "me" or a user id
  teamId: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z
    .string()
    .regex(new RegExp(`^-?(${SORTABLE.join('|')})$`), `sort must be one of ${SORTABLE.join(', ')} (prefix - for descending)`)
    .default('-createdAt'),
  // Either page through with a cursor (recommended for large lists) or with
  // page numbers. Page numbers also return the total count.
  cursor: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const taskParams = z.object({ taskId: id });

// An assignee must belong to the task's team. Personal tasks can only be
// assigned to their creator.
const checkAssignee = async (assigneeId, teamId, creatorId) => {
  if (!assigneeId) return;
  if (teamId) {
    if (!(await getMembership(teamId, assigneeId))) {
      throw badRequest('Assignee must be a member of the task\'s team');
    }
  } else if (assigneeId !== creatorId) {
    throw badRequest('Personal tasks can only be assigned to yourself; create the task in a team to assign others');
  }
};

const rankOf = (priority) => (priority ? { priorityRank: PRIORITIES.indexOf(priority) + 1 } : {});

const completionFields = (status, previous) => {
  if (!status || status === previous) return {};
  return { completedAt: status === 'COMPLETED' ? new Date() : null };
};

router.post('/', validate({ body: createSchema }), async (req, res) => {
  const { teamId, assigneeId, ...rest } = req.body;
  if (teamId) await requireMembership(teamId, req.user.id);
  await checkAssignee(assigneeId, teamId, req.user.id);

  const task = await prisma.task.create({
    data: {
      ...rest,
      teamId: teamId ?? null,
      assigneeId: assigneeId ?? null,
      creatorId: req.user.id,
      ...rankOf(rest.priority),
      ...(rest.status === 'COMPLETED' ? { completedAt: new Date() } : {}),
    },
    include: taskInclude,
  });

  await notify({
    userIds: [task.assigneeId],
    actorId: req.user.id,
    type: 'TASK_ASSIGNED',
    message: `${req.user.name} assigned you "${task.title}"`,
    data: { taskId: task.id },
  });
  res.status(201).json(task);
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const q = req.validatedQuery;
  const me = req.user.id;
  const and = [visibleTasksWhere(me)];

  if (q.status) and.push({ status: { in: q.status } });
  if (q.priority) and.push({ priority: { in: q.priority } });
  if (q.assignee === 'me') and.push({ assigneeId: me });
  else if (q.assignee === 'unassigned') and.push({ assigneeId: null });
  else if (q.assignee) and.push({ assigneeId: q.assignee });
  if (q.createdBy) and.push({ creatorId: q.createdBy === 'me' ? me : q.createdBy });
  if (q.teamId) and.push({ teamId: q.teamId });
  if (q.q) {
    const term = { contains: q.q, mode: 'insensitive' };
    and.push({ OR: [{ title: term }, { description: term }] });
  }
  if (q.dueBefore) and.push({ dueDate: { lte: q.dueBefore } });
  if (q.dueAfter) and.push({ dueDate: { gte: q.dueAfter } });
  if (q.overdue === true) and.push({ dueDate: { lt: new Date() }, status: { not: 'COMPLETED' } });

  const desc = q.sort.startsWith('-');
  const field = desc ? q.sort.slice(1) : q.sort;
  const direction = desc ? 'desc' : 'asc';
  const column = field === 'priority' ? 'priorityRank' : field;
  // Tasks without a due date sort last either way.
  const primary =
    field === 'dueDate' ? { dueDate: { sort: direction, nulls: 'last' } } : { [column]: direction };
  const orderBy = [primary, { id: 'asc' }];

  const byCursor = Boolean(q.cursor);
  if (byCursor) {
    and.push(afterCursor({ column, direction, nullable: field === 'dueDate' }, decodeCursor(q.cursor, q.sort)));
  }

  const where = { AND: and };
  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy,
      ...(byCursor ? {} : { skip: (q.page - 1) * q.limit }),
      take: q.limit + 1, // one extra row tells us whether there is a next page
      include: taskInclude,
    }),
    byCursor ? null : prisma.task.count({ where }),
  ]);

  const hasMore = rows.length > q.limit;
  const items = hasMore ? rows.slice(0, q.limit) : rows;
  const last = items.at(-1);
  const sortValue = (t) => (field === 'priority' ? PRIORITIES.indexOf(t.priority) + 1 : t[field]);
  const nextCursor = hasMore ? encodeCursor(q.sort, sortValue(last), last.id) : null;

  if (byCursor) {
    return res.json({ data: items, pagination: { limit: q.limit, nextCursor } });
  }
  res.json({
    data: items,
    pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit), nextCursor },
  });
});

router.get('/:taskId', validate({ params: taskParams }), async (req, res) => {
  await loadTaskForUser(req.params.taskId, req.user.id);
  const task = await prisma.task.findUnique({ where: { id: req.params.taskId }, include: taskInclude });
  res.json(task);
});

router.patch('/:taskId', validate({ params: taskParams, body: updateSchema }), async (req, res) => {
  const { task } = await loadTaskForUser(req.params.taskId, req.user.id);
  const body = req.body;

  if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId) {
    await checkAssignee(body.assigneeId, task.teamId, task.creatorId);
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { ...body, ...rankOf(body.priority), ...completionFields(body.status, task.status) },
    include: taskInclude,
  });

  const reassigned = body.assigneeId !== undefined && body.assigneeId !== task.assigneeId;
  if (reassigned && updated.assigneeId) {
    await notify({
      userIds: [updated.assigneeId],
      actorId: req.user.id,
      type: 'TASK_ASSIGNED',
      message: `${req.user.name} assigned you "${updated.title}"`,
      data: { taskId: updated.id },
    });
  }
  await notify({
    userIds: [updated.creatorId, reassigned ? null : updated.assigneeId],
    actorId: req.user.id,
    type: 'TASK_UPDATED',
    message: `${req.user.name} updated "${updated.title}"`,
    data: { taskId: updated.id, changes: Object.keys(body) },
  });

  res.json(updated);
});

router.delete('/:taskId', validate({ params: taskParams }), async (req, res) => {
  const { task, membership } = await loadTaskForUser(req.params.taskId, req.user.id);
  if (!canDeleteTask(task, req.user.id, membership)) {
    throw forbidden('Only the task creator or a team admin can delete this task');
  }
  const files = await prisma.attachment.findMany({ where: { taskId: task.id }, select: { storageKey: true } });
  await prisma.task.delete({ where: { id: task.id } });
  await Promise.all(files.map((f) => removeStoredFile(f.storageKey)));
  res.status(204).end();
});

router.use('/:taskId/comments', commentsRouter);
router.use('/:taskId/attachments', attachmentsRouter);

export default router;
