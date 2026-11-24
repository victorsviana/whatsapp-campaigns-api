import { Router } from 'express';
import type { Campaign } from '../../database/schema';
import { validate } from '../../shared/middlewares/validate';
import { type CreateCampaignInput, createCampaignBodySchema } from './campaigns.schemas';
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

  return router;
}
