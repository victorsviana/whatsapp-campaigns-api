import type { ProviderEventResult } from '../../database/schema';
import { applyEvent } from './apply-events';
import type { WebhooksRepository } from './webhooks.repository';
import type { ProviderEventInput } from './webhooks.schemas';

export type WebhookResult = ProviderEventResult | 'duplicate';

export type WebhooksService = ReturnType<typeof createWebhooksService>;

export function createWebhooksService(repository: WebhooksRepository) {
  return {
    receiveEvent(input: ProviderEventInput): Promise<WebhookResult> {
      return repository.transaction(async (tx) => {
        await tx.lockProviderMessage(input.provider_message_id);

        const inserted = await tx.insertEvent({
          eventId: input.event_id,
          providerMessageId: input.provider_message_id,
          status: input.status,
        });
        if (!inserted) {
          return 'duplicate';
        }

        const message = await tx.findMessageForUpdate(input.provider_message_id);
        if (!message) {
          return 'pending';
        }

        return applyEvent(tx, message, { eventId: input.event_id, status: input.status });
      });
    },
  };
}
