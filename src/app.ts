import express, { type Express } from 'express';
import { db } from './database/client';
import { createCampaignsRepository } from './modules/campaigns/campaigns.repository';
import { createCampaignsRouter } from './modules/campaigns/campaigns.routes';
import { createCampaignsService } from './modules/campaigns/campaigns.service';
import { env } from './shared/config/env';
import { errorHandler, notFoundHandler } from './shared/errors/error-handler';

export function createApp(): Express {
  const app = express();

  const campaignsService = createCampaignsService(createCampaignsRepository(db));

  app.disable('x-powered-by');
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/campaigns', createCampaignsRouter(campaignsService));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
