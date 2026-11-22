import { badRequest } from '../utils/errors.js';

const format = (error) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

// Validates and replaces req.body / req.query / req.params with parsed values.
// Express 5 makes req.query a getter, so parsed query goes on req.validatedQuery.
export const validate = (schemas) => (req, _res, next) => {
  for (const key of ['params', 'query', 'body']) {
    if (!schemas[key]) continue;
    const result = schemas[key].safeParse(req[key] ?? {});
    if (!result.success) {
      return next(badRequest('Validation failed', format(result.error)));
    }
    if (key === 'query') req.validatedQuery = result.data;
    else req[key] = result.data;
  }
  next();
};
