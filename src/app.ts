import express, { type Express } from 'express';
import { env } from './shared/config/env';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}
