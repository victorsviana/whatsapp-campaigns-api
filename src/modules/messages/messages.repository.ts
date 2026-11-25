import { sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../../database/client';

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
  };
}
