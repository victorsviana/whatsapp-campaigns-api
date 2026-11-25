import { Router } from 'express';
import { validate } from '../../shared/middlewares/validate';
import { type ProviderEventInput, providerEventBodySchema } from './webhooks.schemas';
import type { WebhooksService } from './webhooks.service';

export function createWebhooksRouter(service: WebhooksService): Router {
  const router = Router();

  router.post('/provider', validate({ body: providerEventBodySchema }), async (req, res) => {
    const event = req.body as ProviderEventInput;
    const result = await service.receiveEvent(event);
    res.status(200).json({ event_id: event.event_id, result });
  });

  return router;
}
