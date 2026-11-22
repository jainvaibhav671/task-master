import { PrismaClient } from '@prisma/client';

// priorityRank exists only so the database can sort by priority; keep it out of responses.
export const prisma = new PrismaClient({ omit: { task: { priorityRank: true } } });
