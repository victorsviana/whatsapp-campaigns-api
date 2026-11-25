import { Router } from 'express';
import type { Campaign } from '../../database/schema';
import { validate } from '../../shared/middlewares/validate';
import {
  type AddContactsInput,
  addContactsBodySchema,
  campaignIdParamsSchema,
  type CreateCampaignInput,
  createCampaignBodySchema,
} from './campaigns.schemas';
import type { CampaignsService } from './campaigns.service';

function toCampaignResponse(campaign: Campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    template: campaign.template,
    variables: campaign.variables,
    status: campaign.status,
    created_at: campaign.createdAt.toISOString(),
  };
}

export function createCampaignsRouter(service: CampaignsService): Router {
  const router = Router();

  router.post('/', validate({ body: createCampaignBodySchema }), async (req, res) => {
    const campaign = await service.createCampaign(req.body as CreateCampaignInput);
    res.status(201).json(toCampaignResponse(campaign));
  });

  router.post(
    '/:id/contacts',
    validate({ params: campaignIdParamsSchema, body: addContactsBodySchema }),
    async (req, res) => {
      const { contacts } = req.body as AddContactsInput;
      const result = await service.addContacts(req.params.id as string, contacts);
      res.status(200).json(result);
    },
  );

  router.post('/:id/start', validate({ params: campaignIdParamsSchema }), async (req, res) => {
    const campaign = await service.startCampaign(req.params.id as string);
    res.status(202).json({
      id: campaign.id,
      status: campaign.status,
      started_at: campaign.startedAt?.toISOString() ?? null,
    });
  });

  return router;
}
