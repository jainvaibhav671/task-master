import { prisma } from '../db.js';
import { forbidden, notFound } from '../utils/errors.js';

export const ROLES = ['OWNER', 'ADMIN', 'MEMBER'];
export const isManager = (membership) => ['OWNER', 'ADMIN'].includes(membership?.role);

export const getMembership = (teamId, userId) =>
  prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });

// Throws 404 when the team does not exist or the user is not in it, so team
// ids cannot be probed by outsiders.
export const requireMembership = async (teamId, userId) => {
  const membership = await getMembership(teamId, userId);
  if (!membership) throw notFound('Team');
  return membership;
};

export const requireManager = async (teamId, userId) => {
  const membership = await requireMembership(teamId, userId);
  if (!isManager(membership)) throw forbidden('Only team owners and admins can do that');
  return membership;
};

// Prisma filter for every task a user is allowed to see.
export const visibleTasksWhere = (userId) => ({
  OR: [
    { creatorId: userId },
    { assigneeId: userId },
    { team: { members: { some: { userId } } } },
  ],
});

// Loads a task the user can see, plus their team membership (if any).
export const loadTaskForUser = async (taskId, userId) => {
  const task = await prisma.task.findFirst({
    where: { id: taskId, ...visibleTasksWhere(userId) },
  });
  if (!task) throw notFound('Task');
  const membership = task.teamId ? await getMembership(task.teamId, userId) : null;
  return { task, membership };
};

export const canDeleteTask = (task, userId, membership) =>
  task.creatorId === userId || isManager(membership);
