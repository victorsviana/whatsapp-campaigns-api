import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseExecutor } from '../../database/client';
import { type Campaign, campaigns, messages, type NewCampaign } from '../../database/schema';
import type { AcceptedContact } from './contact-validator';

export interface CampaignsRepository {
  transaction<T>(work: (repository: CampaignsRepository) => Promise<T>): Promise<T>;
  create(data: NewCampaign): Promise<Campaign>;
  findByIdForUpdate(id: string): Promise<Campaign | undefined>;
  findExistingPhones(campaignId: string, phones: string[]): Promise<Set<string>>;
  insertContacts(campaignId: string, contacts: AcceptedContact[]): Promise<void>;
  incrementRejectedContacts(campaignId: string, amount: number): Promise<void>;
  hasMessages(campaignId: string): Promise<boolean>;
  markRunning(campaignId: string): Promise<Campaign | undefined>;
}

export function createCampaignsRepository(db: DatabaseExecutor): CampaignsRepository {
  return {
    transaction<T>(work: (repository: CampaignsRepository) => Promise<T>): Promise<T> {
      return db.transaction((tx) => work(createCampaignsRepository(tx)));
    },

    async create(data: NewCampaign): Promise<Campaign> {
      const [campaign] = await db.insert(campaigns).values(data).returning();
      if (!campaign) {
        throw new Error('Insert into campaigns returned no row');
      }
      return campaign;
    },

    async findByIdForUpdate(id: string): Promise<Campaign | undefined> {
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).for('update');
      return campaign;
    },

    async findExistingPhones(campaignId: string, phones: string[]): Promise<Set<string>> {
      if (phones.length === 0) {
        return new Set();
      }
      const rows = await db
        .select({ phone: messages.phone })
        .from(messages)
        .where(and(eq(messages.campaignId, campaignId), inArray(messages.phone, phones)));
      return new Set(rows.map((row) => row.phone));
    },

    async insertContacts(campaignId: string, contacts: AcceptedContact[]): Promise<void> {
      if (contacts.length === 0) {
        return;
      }
      await db
        .insert(messages)
        .values(contacts.map((contact) => ({ campaignId, phone: contact.phone, variables: contact.variables })));
    },

    async incrementRejectedContacts(campaignId: string, amount: number): Promise<void> {
      if (amount === 0) {
        return;
      }
      await db
        .update(campaigns)
        .set({ rejectedContacts: sql`${campaigns.rejectedContacts} + ${amount}` })
        .where(eq(campaigns.id, campaignId));
    },

    async hasMessages(campaignId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.campaignId, campaignId))
        .limit(1);
      return row !== undefined;
    },

    async markRunning(campaignId: string): Promise<Campaign | undefined> {
      const [campaign] = await db
        .update(campaigns)
        .set({ status: 'running', startedAt: sql`now()` })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'draft')))
        .returning();
      return campaign;
    },
  };
}
