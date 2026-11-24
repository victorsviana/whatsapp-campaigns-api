import { z } from 'zod';

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
