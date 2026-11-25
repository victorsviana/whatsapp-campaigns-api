import { z } from 'zod';
import { PROVIDER_EVENT_STATUSES } from '../../database/schema';

export const PROVIDER_ID_MAX_LENGTH = 255;

const providerId = z
  .string()
  .max(PROVIDER_ID_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, { message: 'Must not be empty' });

export const providerEventBodySchema = z.object({
  event_id: providerId,
  provider_message_id: providerId,
  status: z.enum(PROVIDER_EVENT_STATUSES),
});

export type ProviderEventInput = z.infer<typeof providerEventBodySchema>;
