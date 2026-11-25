import type { MessageStatus, ProviderEventStatus } from '../../database/schema';
import { canTransition } from '../messages/message-status';
import type { MessageForEvent, WebhooksRepository } from './webhooks.repository';

export type ApplyResult = 'applied' | 'ignored';

export async function applyEvent(
  repository: WebhooksRepository,
  message: MessageForEvent,
  event: { eventId: string; status: ProviderEventStatus },
): Promise<ApplyResult> {
  const applied = canTransition(message.status, event.status) && (await repository.applyEventStatus(message.id, event.status));
  const result = applied ? 'applied' : 'ignored';
  await repository.markEventProcessed(event.eventId, result);
  return result;
}

export async function applyPendingEvents(
  repository: WebhooksRepository,
  providerMessageId: string,
  message: MessageForEvent,
): Promise<MessageStatus> {
  let status = message.status;
  for (const event of await repository.findPendingEvents(providerMessageId)) {
    const result = await applyEvent(repository, { id: message.id, status }, event);
    if (result === 'applied') {
      status = event.status;
    }
  }
  return status;
}
