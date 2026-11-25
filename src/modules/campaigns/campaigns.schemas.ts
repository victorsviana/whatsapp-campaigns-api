import { z } from 'zod';
import { MESSAGE_STATUSES } from '../../database/schema';

export const CAMPAIGN_NAME_MAX_LENGTH = 200;
export const TEMPLATE_MAX_LENGTH = 4096;

export const createCampaignBodySchema = z.object({
  name: z.string().trim().min(1).max(CAMPAIGN_NAME_MAX_LENGTH),
  template: z
    .string()
    .max(TEMPLATE_MAX_LENGTH)
    .refine((template) => template.trim().length > 0, { message: 'Template must not be empty' }),
});

export type CreateCampaignInput = z.infer<typeof createCampaignBodySchema>;

export const CONTACTS_PER_REQUEST_MAX = 10_000;

export const campaignIdParamsSchema = z.object({
  id: z.uuid(),
});

export const addContactsBodySchema = z.object({
  contacts: z.array(z.record(z.string(), z.unknown())).min(1).max(CONTACTS_PER_REQUEST_MAX),
});

export type AddContactsInput = z.infer<typeof addContactsBodySchema>;

export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 500;

export const listMessagesQuerySchema = z.object({
  status: z.enum(MESSAGE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX).default(MESSAGES_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
