import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, type ErrorDetail } from './app-error';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
  };
};

type BodyParserError = Error & { type: string; status: number };

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && 'type' in err && 'status' in err;
}

function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }

  if (isBodyParserError(err) && err.type === 'entity.parse.failed') {
    return { status: 400, body: { error: { code: 'invalid_json', message: 'Request body is not valid JSON' } } };
  }

  if (isBodyParserError(err) && err.type === 'entity.too.large') {
    return { status: 413, body: { error: { code: 'payload_too_large', message: 'Request body is too large' } } };
  }

  console.error(err);
  return { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'route_not_found', `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const { status, body } = toErrorResponse(err);
  res.status(status).json(body);
};
