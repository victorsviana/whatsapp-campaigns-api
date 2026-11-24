import express, { type Express } from 'express';
import { env } from './shared/config/env';
import { errorHandler, notFoundHandler } from './shared/errors/error-handler';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
