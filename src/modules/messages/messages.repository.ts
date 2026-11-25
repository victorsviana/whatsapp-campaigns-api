import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../../database/client';
import { messages } from '../../database/schema';
import { applyPendingEvents } from '../webhooks/apply-events';
import { createWebhooksRepository } from '../webhooks/webhooks.repository';

export const MAX_ATTEMPTS_EXCEEDED = 'max_attempts_exceeded';

export type ClaimedMessage = {
  id: string;
  campaignId: string;
  phone: string;
  variables: Record<string, string>;
  attempts: number;
  template: string;
};

type ClaimedMessageRow = {
  id: string;
  campaign_id: string;
  phone: string;
  variables: Record<string, string>;
  attempts: number;
  template: string;
  next_attempt_at: Date;
  seq: string | number;
};

export interface MessagesRepository {
  claimBatch(limit: number): Promise<ClaimedMessage[]>;
  markSent(id: string, providerMessageId: string): Promise<boolean>;
  markFailed(id: string, failureReason: string, lastError?: string): Promise<boolean>;
  scheduleRetry(id: string, delayMs: number, lastError: string): Promise<boolean>;
  recoverStuck(sendingTimeoutMs: number, maxAttempts: number): Promise<number>;
}

function isSending(id: string) {
  return and(eq(messages.id, id), eq(messages.status, 'sending'));
}

function compareClaimOrder(a: ClaimedMessageRow, b: ClaimedMessageRow): number {
  const byTime = new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime();
  return byTime !== 0 ? byTime : Number(a.seq) - Number(b.seq);
}

export function createMessagesRepository(db: DatabaseExecutor): MessagesRepository {
  return {
    async claimBatch(limit: number): Promise<ClaimedMessage[]> {
      const result = await db.execute<ClaimedMessageRow>(sql`
        WITH ready AS (
          SELECT m.id
          FROM messages m
          JOIN campaigns c ON c.id = m.campaign_id
          WHERE m.status = 'pending'
            AND m.next_attempt_at <= now()
            AND c.status = 'running'
          ORDER BY m.next_attempt_at, m.seq
          LIMIT ${limit}
          FOR UPDATE OF m SKIP LOCKED
        )
        UPDATE messages m
        SET status = 'sending',
            locked_at = now(),
            attempts = m.attempts + 1,
            updated_at = now()
        FROM ready, campaigns c
        WHERE m.id = ready.id
          AND c.id = m.campaign_id
        RETURNING m.id, m.campaign_id, m.phone, m.variables, m.attempts, c.template, m.next_attempt_at, m.seq
      `);

      return [...result.rows].sort(compareClaimOrder).map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        phone: row.phone,
        variables: row.variables,
        attempts: row.attempts,
        template: row.template,
      }));
    },

    markSent(id: string, providerMessageId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const webhooks = createWebhooksRepository(tx);
        await webhooks.lockProviderMessage(providerMessageId);

        const updated = await tx
          .update(messages)
          .set({ status: 'sent', providerMessageId, sentAt: sql`now()`, lockedAt: null })
          .where(isSending(id))
          .returning({ id: messages.id });
        if (updated.length === 0) {
          return false;
        }

        await applyPendingEvents(webhooks, providerMessageId, { id, status: 'sent' });
        return true;
      });
    },

    async markFailed(id: string, failureReason: string, lastError?: string): Promise<boolean> {
      const updated = await db
        .update(messages)
        .set({ status: 'failed', failureReason, lockedAt: null, ...(lastError === undefined ? {} : { lastError }) })
        .where(isSending(id))
        .returning({ id: messages.id });
      return updated.length > 0;
    },

    async scheduleRetry(id: string, delayMs: number, lastError: string): Promise<boolean> {
      const updated = await db
        .update(messages)
        .set({
          status: 'pending',
          nextAttemptAt: sql`now() + ${delayMs} * interval '1 millisecond'`,
          lastError,
          lockedAt: null,
        })
        .where(isSending(id))
        .returning({ id: messages.id });
      return updated.length > 0;
    },

    async recoverStuck(sendingTimeoutMs: number, maxAttempts: number): Promise<number> {
      const result = await db.execute(sql`
        UPDATE messages
        SET status = (CASE WHEN attempts >= ${maxAttempts} THEN 'failed' ELSE 'pending' END)::message_status,
            failure_reason = CASE WHEN attempts >= ${maxAttempts} THEN ${MAX_ATTEMPTS_EXCEEDED} ELSE failure_reason END,
            next_attempt_at = CASE WHEN attempts >= ${maxAttempts} THEN next_attempt_at ELSE now() END,
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'sending'
          AND locked_at < now() - ${sendingTimeoutMs} * interval '1 millisecond'
      `);
      return result.rowCount ?? 0;
    },
  };
}
