import { AppError } from '../errors/AppError.js';

/**
 * Middleware factory for request validation using Zod schemas.
 * Validates body, params, and query as specified in schemaMap.
 * Unknown fields are rejected (VALIDATION_ERROR, 400).
 *
 * @param {{ body?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const targets = ['body', 'params', 'query'];
    const issues = [];

    for (const target of targets) {
      let schema = schemas[target];
      if (!schema) continue;

      // Automatically enforce strict schema to reject unknown keys if it is a ZodObject
      if (typeof schema.strict === 'function') {
        schema = schema.strict();
      }

      const result = schema.safeParse(req[target] || {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            target,
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          });
        }
      } else {
        // Assign parsed & transformed data back to request
        req[target] = result.data;
      }
    }

    if (issues.length > 0) {
      return next(
        new AppError('VALIDATION_ERROR', 400, 'Validation failed', { issues }),
      );
    }

    next();
  };
}
