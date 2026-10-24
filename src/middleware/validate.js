import { ApiError } from '../utils/ApiError.js';

/*
  Runs a Zod schema against the request.
  The schema must have the shape:  z.object({ body?, query?, params? })

  Usage:
    router.post('/login', validate(loginSchema), handler)

  After success, req.body is replaced with the cleaned and trimmed data.
  Unknown body fields are removed if the schema uses z.object (the default).
  req.query and req.params are checked but not replaced, because Express 5
  makes them read-only. Read cleaned values from req.validated instead.
*/
export const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse({
    body: req.body ?? {},
    query: req.query ?? {},
    params: req.params ?? {},
  });

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.slice(1).join('.') || issue.path.join('.'),
      message: issue.message,
    }));
    return next(new ApiError(400, 'Validation failed', details));
  }

  const { body, query, params } = result.data;
  if (body !== undefined) req.body = body;
  req.validated = { body, query, params };
  next();
};