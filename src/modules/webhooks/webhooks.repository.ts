import type { DatabaseExecutor } from '../../database/client';
import { type NewProviderEvent, providerEvents } from '../../database/schema';

export interface WebhooksRepository {
  insertEvent(event: NewProviderEvent): Promise<boolean>;
}

export function createWebhooksRepository(db: DatabaseExecutor): WebhooksRepository {
  return {
    async insertEvent(event: NewProviderEvent): Promise<boolean> {
      const inserted = await db
        .insert(providerEvents)
        .values(event)
        .onConflictDoNothing({ target: providerEvents.eventId })
        .returning({ eventId: providerEvents.eventId });
      return inserted.length > 0;
    },
  };
}
