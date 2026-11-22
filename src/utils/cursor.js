import { badRequest } from './errors.js';

// Keyset ("cursor") pagination. The cursor holds the sort value and id of the
// last row a client saw, and the next page is "rows after that one" in sort
// order. Unlike OFFSET, this stays fast on page 10,000, and rows inserted
// meanwhile don't shift pages or show up twice.

const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'dueDate']);

export const encodeCursor = (sort, value, id) =>
  Buffer.from(JSON.stringify({ s: sort, v: value instanceof Date ? value.toISOString() : value, id })).toString(
    'base64url',
  );

export const decodeCursor = (cursor, sort) => {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Invalid cursor');
  }
  if (!parsed || typeof parsed.id !== 'string' || !('v' in parsed)) throw badRequest('Invalid cursor');
  if (parsed.s !== sort) throw badRequest('This cursor belongs to a different sort order; start again without it');
  return parsed;
};

// Prisma `where` for rows strictly after the cursor. `column` is the column
// actually sorted on; `id` ascending is always the tiebreaker. A nullable
// column sorts nulls last in both directions.
export const afterCursor = ({ column, direction, nullable }, { v, id }) => {
  const value = v !== null && DATE_FIELDS.has(column) ? new Date(v) : v;
  if (value === null) {
    return { [column]: null, id: { gt: id } };
  }
  const beyond = direction === 'asc' ? { gt: value } : { lt: value };
  const or = [{ [column]: beyond }, { [column]: value, id: { gt: id } }];
  if (nullable) or.push({ [column]: null });
  return { OR: or };
};
