import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { notify } from '../services/notifications.js';
import { conflict, notFound } from '../utils/errors.js';

// Invitations addressed to the signed-in user.
const router = Router();
router.use(authenticate);

const params = z.object({ invitationId: z.string().min(1) });

router.get('/', async (req, res) => {
  const invitations = await prisma.invitation.findMany({
    where: { email: req.user.email, status: 'PENDING' },
    include: {
      team: { select: { id: true, name: true, description: true } },
      invitedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invitations);
});

const loadPending = async (req) => {
  const invitation = await prisma.invitation.findFirst({
    where: { id: req.params.invitationId, email: req.user.email },
    include: { team: { select: { id: true, name: true } } },
  });
  if (!invitation) throw notFound('Invitation');
  if (invitation.status !== 'PENDING') throw conflict(`Invitation was already ${invitation.status.toLowerCase()}`);
  return invitation;
};

router.post('/:invitationId/accept', validate({ params }), async (req, res) => {
  const invitation = await loadPending(req);
  const [, member] = await prisma.$transaction([
    prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED' } }),
    prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: invitation.teamId, userId: req.user.id } },
      create: { teamId: invitation.teamId, userId: req.user.id, role: 'MEMBER' },
      update: {},
    }),
  ]);
  await notify({
    userIds: [invitation.invitedById],
    actorId: req.user.id,
    type: 'TEAM_INVITATION',
    message: `${req.user.name} joined ${invitation.team.name}`,
    data: { teamId: invitation.teamId },
  });
  res.json(member);
});

router.post('/:invitationId/decline', validate({ params }), async (req, res) => {
  const invitation = await loadPending(req);
  await prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'DECLINED' } });
  res.status(204).end();
});

export default router;
