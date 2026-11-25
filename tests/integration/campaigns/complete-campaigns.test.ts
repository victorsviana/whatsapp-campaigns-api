import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../../src/database/client';
import { type CampaignStatus, campaigns, type MessageStatus, messages } from '../../../src/database/schema';
import { createCampaignsRepository } from '../../../src/modules/campaigns/campaigns.repository';

const FUTURE = new Date('2999-01-01T00:00:00.000Z');

describe('campaignsRepository.completeFinished', () => {
  const repository = createCampaignsRepository(db);

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(status: CampaignStatus, messageStatuses: MessageStatus[]): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Fechamento', template: 'Oi', variables: [], status })
      .returning({ id: campaigns.id });
    if (messageStatuses.length > 0) {
      await db.insert(messages).values(
        messageStatuses.map((status, index) => ({
          campaignId: campaign!.id,
          phone: `+55119876543${String(index).padStart(2, '0')}`,
          variables: {},
          status,
          nextAttemptAt: FUTURE,
        })),
      );
    }
    return campaign!.id;
  }

  async function findCampaign(id: string) {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    return campaign!;
  }

  it('SND-22: campanha running com todas as mensagens finalizadas vira completed com completed_at', async () => {
    const id = await createCampaign('running', ['sent', 'delivered', 'read', 'failed']);
    const before = Date.now();

    const completed = await repository.completeFinished();

    expect(completed).toContain(id);
    const stored = await findCampaign(id);
    expect(stored.status).toBe('completed');
    expect(stored.completedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it.each<MessageStatus>(['pending', 'sending'])(
    'SND-23: campanha running com uma mensagem %s continua running',
    async (openStatus) => {
      const id = await createCampaign('running', ['sent', 'failed', openStatus]);

      const completed = await repository.completeFinished();

      expect(completed).not.toContain(id);
      expect(await findCampaign(id)).toMatchObject({ status: 'running', completedAt: null });
    },
  );

  it('R13: só fecha campanhas running (draft com mensagens finalizadas fica como está)', async () => {
    const id = await createCampaign('draft', ['sent']);

    const completed = await repository.completeFinished();

    expect(completed).not.toContain(id);
    expect(await findCampaign(id)).toMatchObject({ status: 'draft', completedAt: null });
  });

  it('R13: campanha já completed não tem completed_at sobrescrito', async () => {
    const id = await createCampaign('running', ['sent']);
    await repository.completeFinished();
    const firstCompletedAt = (await findCampaign(id)).completedAt;

    const completed = await repository.completeFinished();

    expect(completed).not.toContain(id);
    expect((await findCampaign(id)).completedAt).toEqual(firstCompletedAt);
  });
});
