import type { ProviderEventResult } from '../../database/schema';
import { canTransition } from '../messages/message-status';
import type { WebhooksRepository } from './webhooks.repository';
import type { ProviderEventInput } from './webhooks.schemas';

export type WebhookResult = ProviderEventResult | 'duplicate';

export type WebhooksService = ReturnType<typeof createWebhooksService>;

export function createWebhooksService(repository: WebhooksRepository) {
  return {
    receiveEvent(input: ProviderEventInput): Promise<WebhookResult> {
      return repository.transaction(async (tx) => {
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

        const applied = canTransition(message.status, input.status) && (await tx.applyEventStatus(message.id, input.status));
        const result = applied ? 'applied' : 'ignored';
        await tx.markEventProcessed(input.event_id, result);
        return result;
      });
    },
  };
}
