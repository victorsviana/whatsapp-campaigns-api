import type { Database } from '../../database/client';
import { type Campaign, campaigns, type NewCampaign } from '../../database/schema';

export type CampaignsRepository = ReturnType<typeof createCampaignsRepository>;

export function createCampaignsRepository(db: Database) {
  return {
    async create(data: NewCampaign): Promise<Campaign> {
      const [campaign] = await db.insert(campaigns).values(data).returning();
      if (!campaign) {
        throw new Error('Insert into campaigns returned no row');
      }
      return campaign;
    },
  };
}
