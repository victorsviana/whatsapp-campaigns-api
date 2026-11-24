import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError, type ErrorDetail } from '../errors/app-error';

type RequestSchemas = {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
};

type RequestPart = keyof RequestSchemas;

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const parsed: Partial<Record<RequestPart, unknown>> = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({ path: [part, ...issue.path].join('.'), message: issue.message });
        }
      }
    }

    if (details.length > 0) {
      throw new AppError(400, 'validation_error', 'Invalid request', details);
    }

    if ('body' in parsed) req.body = parsed.body;
    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    if ('query' in parsed) {
      Object.defineProperty(req, 'query', { value: parsed.query, writable: true, enumerable: true });
    }

    next();
  };
}
