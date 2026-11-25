import { Router } from 'express';
import type { Campaign, Message } from '../../database/schema';
import { validate } from '../../shared/middlewares/validate';
import {
  type AddContactsInput,
  addContactsBodySchema,
  campaignIdParamsSchema,
  type CreateCampaignInput,
  createCampaignBodySchema,
  type ListMessagesQuery,
  listMessagesQuerySchema,
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

function toMessageResponse(message: Message) {
  return {
    id: message.id,
    phone: message.phone,
    variables: message.variables,
    status: message.status,
    attempts: message.attempts,
    failure_reason: message.failureReason,
    last_error: message.lastError,
    provider_message_id: message.providerMessageId,
    sent_at: message.sentAt?.toISOString() ?? null,
    updated_at: message.updatedAt.toISOString(),
  };
}

export function createCampaignsRouter(service: CampaignsService): Router {
  const router = Router();

  router.post('/', validate({ body: createCampaignBodySchema }), async (req, res) => {
    const campaign = await service.createCampaign(req.body as CreateCampaignInput);
    res.status(201).json(toCampaignResponse(campaign));
  });

  router.get('/:id', validate({ params: campaignIdParamsSchema }), async (req, res) => {
    const report = await service.getReport(req.params.id as string);
    res.status(200).json({
      ...toCampaignResponse(report.campaign),
      started_at: report.campaign.startedAt?.toISOString() ?? null,
      completed_at: report.campaign.completedAt?.toISOString() ?? null,
      contacts: { accepted: report.acceptedContacts, rejected: report.campaign.rejectedContacts },
      messages: report.messages,
    });
  });

  router.get(
    '/:id/messages',
    validate({ params: campaignIdParamsSchema, query: listMessagesQuerySchema }),
    async (req, res) => {
      const query = req.query as unknown as ListMessagesQuery;
      const page = await service.listMessages(req.params.id as string, query);
      res.status(200).json({
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        items: page.items.map(toMessageResponse),
      });
    },
  );

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
