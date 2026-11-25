import type { ProviderEventResult } from '../../database/schema';
import type { WebhooksRepository } from './webhooks.repository';
import type { ProviderEventInput } from './webhooks.schemas';

export type WebhookResult = ProviderEventResult | 'duplicate';

export type WebhooksService = ReturnType<typeof createWebhooksService>;

export function createWebhooksService(repository: WebhooksRepository) {
  return {
    async receiveEvent(input: ProviderEventInput): Promise<WebhookResult> {
      const inserted = await repository.insertEvent({
        eventId: input.event_id,
        providerMessageId: input.provider_message_id,
        status: input.status,
      });
      if (!inserted) {
        return 'duplicate';
      }
      return 'pending';
    },
  };
}
