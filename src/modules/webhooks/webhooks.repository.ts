import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../../database/client';
import {
  type MessageStatus,
  messages,
  type NewProviderEvent,
  type ProviderEventResult,
  type ProviderEventStatus,
  providerEvents,
} from '../../database/schema';
import { statusesThatCanBecome } from '../messages/message-status';

export const PROVIDER_REPORTED_FAILURE = 'provider_reported_failure';

export type MessageForEvent = {
  id: string;
  status: MessageStatus;
};

export type PendingEvent = {
  eventId: string;
  status: ProviderEventStatus;
};

export interface WebhooksRepository {
  transaction<T>(work: (repository: WebhooksRepository) => Promise<T>): Promise<T>;
  lockProviderMessage(providerMessageId: string): Promise<void>;
  insertEvent(event: NewProviderEvent): Promise<boolean>;
  findPendingEvents(providerMessageId: string): Promise<PendingEvent[]>;
  findMessageForUpdate(providerMessageId: string): Promise<MessageForEvent | undefined>;
  applyEventStatus(messageId: string, status: ProviderEventStatus): Promise<boolean>;
  markEventProcessed(eventId: string, result: Exclude<ProviderEventResult, 'pending'>): Promise<void>;
}

export function createWebhooksRepository(db: DatabaseExecutor): WebhooksRepository {
  return {
    transaction<T>(work: (repository: WebhooksRepository) => Promise<T>): Promise<T> {
      return db.transaction((tx) => work(createWebhooksRepository(tx)));
    },

    async lockProviderMessage(providerMessageId: string): Promise<void> {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerMessageId}, 0))`);
    },

    async findPendingEvents(providerMessageId: string): Promise<PendingEvent[]> {
      return db
        .select({ eventId: providerEvents.eventId, status: providerEvents.status })
        .from(providerEvents)
        .where(and(eq(providerEvents.providerMessageId, providerMessageId), eq(providerEvents.result, 'pending')))
        .orderBy(providerEvents.receivedAt, providerEvents.eventId);
    },

    async insertEvent(event: NewProviderEvent): Promise<boolean> {
      const inserted = await db
        .insert(providerEvents)
        .values(event)
        .onConflictDoNothing({ target: providerEvents.eventId })
        .returning({ eventId: providerEvents.eventId });
      return inserted.length > 0;
    },

    async findMessageForUpdate(providerMessageId: string): Promise<MessageForEvent | undefined> {
      const [message] = await db
        .select({ id: messages.id, status: messages.status })
        .from(messages)
        .where(eq(messages.providerMessageId, providerMessageId))
        .for('update');
      return message;
    },

    async applyEventStatus(messageId: string, status: ProviderEventStatus): Promise<boolean> {
      const updated = await db
        .update(messages)
        .set({ status, ...(status === 'failed' ? { failureReason: PROVIDER_REPORTED_FAILURE } : {}) })
        .where(and(eq(messages.id, messageId), inArray(messages.status, statusesThatCanBecome(status))))
        .returning({ id: messages.id });
      return updated.length > 0;
    },

    async markEventProcessed(eventId: string, result: Exclude<ProviderEventResult, 'pending'>): Promise<void> {
      await db
        .update(providerEvents)
        .set({ result, processedAt: sql`now()` })
        .where(eq(providerEvents.eventId, eventId));
    },
  };
}
