import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireManager, requireMembership } from '../services/access.js';
import { notify } from '../services/notifications.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { publicUserSelect } from '../utils/serialize.js';

const router = Router();
router.use(authenticate);

const teamBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).nullable().optional(),
});
const teamParams = z.object({ teamId: z.string().min(1) });
const memberParams = teamParams.extend({ userId: z.string().min(1) });

const memberInclude = {
  members: { include: { user: { select: publicUserSelect } }, orderBy: { joinedAt: 'asc' } },
};

router.post('/', validate({ body: teamBody }), async (req, res) => {
  const team = await prisma.team.create({
    data: {
      ...req.body,
      ownerId: req.user.id,
      members: { create: { userId: req.user.id, role: 'OWNER' } },
    },
    include: memberInclude,
  });
  res.status(201).json(team);
});

router.get('/', async (req, res) => {
  const teams = await prisma.team.findMany({
    where: { members: { some: { userId: req.user.id } } },
    include: { _count: { select: { members: true, tasks: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(teams);
});

router.get('/:teamId', validate({ params: teamParams }), async (req, res) => {
  await requireMembership(req.params.teamId, req.user.id);
  const team = await prisma.team.findUnique({ where: { id: req.params.teamId }, include: memberInclude });
  res.json(team);
});

router.patch(
  '/:teamId',
  validate({ params: teamParams, body: teamBody.partial() }),
  async (req, res) => {
    await requireManager(req.params.teamId, req.user.id);
    const team = await prisma.team.update({ where: { id: req.params.teamId }, data: req.body });
    res.json(team);
  },
);

router.delete('/:teamId', validate({ params: teamParams }), async (req, res) => {
  const membership = await requireMembership(req.params.teamId, req.user.id);
  if (membership.role !== 'OWNER') throw forbidden('Only the team owner can delete the team');
  await prisma.team.delete({ where: { id: req.params.teamId } });
  res.status(204).end();
});

// ---- Invitations ----

const inviteBody = z.object({ email: z.string().trim().toLowerCase().email() });

router.post(
  '/:teamId/invitations',
  validate({ params: teamParams, body: inviteBody }),
  async (req, res) => {
    const { teamId } = req.params;
    const { email } = req.body;
    await requireManager(teamId, req.user.id);

    const invitee = await prisma.user.findUnique({ where: { email } });
    if (invitee) {
      const already = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: invitee.id } },
      });
      if (already) throw conflict('That user is already a member of this team');
    }
    const pending = await prisma.invitation.findFirst({ where: { teamId, email, status: 'PENDING' } });
    if (pending) throw conflict('That email already has a pending invitation');

    const invitation = await prisma.invitation.create({
      data: { teamId, email, invitedById: req.user.id },
      include: { team: { select: { id: true, name: true } } },
    });
    if (invitee) {
      await notify({
        userIds: [invitee.id],
        actorId: req.user.id,
        type: 'TEAM_INVITATION',
        message: `${req.user.name} invited you to join ${invitation.team.name}`,
        data: { invitationId: invitation.id, teamId },
      });
    }
    res.status(201).json(invitation);
  },
);

router.get('/:teamId/invitations', validate({ params: teamParams }), async (req, res) => {
  await requireManager(req.params.teamId, req.user.id);
  const invitations = await prisma.invitation.findMany({
    where: { teamId: req.params.teamId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invitations);
});

// ---- Members ----

const roleBody = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

router.patch(
  '/:teamId/members/:userId',
  validate({ params: memberParams, body: roleBody }),
  async (req, res) => {
    const { teamId, userId } = req.params;
    const me = await requireMembership(teamId, req.user.id);
    if (me.role !== 'OWNER') throw forbidden('Only the team owner can change roles');
    const target = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (!target) throw notFound('Member');
    if (target.role === 'OWNER') throw badRequest('The owner role cannot be changed');
    const updated = await prisma.teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role: req.body.role },
    });
    res.json(updated);
  },
);

// Removes a member. Members may remove themselves (leave); managers may remove
// others, but nobody can remove the owner.
router.delete('/:teamId/members/:userId', validate({ params: memberParams }), async (req, res) => {
  const { teamId, userId } = req.params;
  const me = await requireMembership(teamId, req.user.id);
  const target = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
  if (!target) throw notFound('Member');
  if (target.role === 'OWNER') throw badRequest('The owner cannot leave or be removed; delete the team instead');

  const self = userId === req.user.id;
  if (!self) {
    if (!['OWNER', 'ADMIN'].includes(me.role)) throw forbidden('Only team owners and admins can remove members');
    if (me.role === 'ADMIN' && target.role === 'ADMIN') throw forbidden('Admins cannot remove other admins');
  }

  await prisma.$transaction([
    prisma.teamMember.delete({ where: { teamId_userId: { teamId, userId } } }),
    // Their open team tasks go back to the pool instead of pointing at an outsider.
    prisma.task.updateMany({ where: { teamId, assigneeId: userId }, data: { assigneeId: null } }),
  ]);
  res.status(204).end();
});

export default router;
