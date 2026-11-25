import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../../src/database/client';
import { type CampaignStatus, campaigns, type NewMessage, messages } from '../../../src/database/schema';
import { createMessagesRepository } from '../../../src/modules/messages/messages.repository';

const OLD = new Date('1999-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');

describe('messagesRepository.claimBatch', () => {
  const repository = createMessagesRepository(db);

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(status: CampaignStatus, template = 'Olá {{nome}}'): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Fila', template, variables: ['nome'], status })
      .returning({ id: campaigns.id });
    return campaign!.id;
  }

  async function insertMessages(
    campaignId: string,
    count: number,
    overrides: Partial<NewMessage> = {},
  ): Promise<string[]> {
    const rows = Array.from({ length: count }, (_, index) => ({
      campaignId,
      phone: `+55119${String(index).padStart(8, '0')}`,
      variables: { nome: `Contato ${index}` },
      nextAttemptAt: OLD,
      ...overrides,
    }));
    const inserted = await db.insert(messages).values(rows).returning({ id: messages.id });
    return inserted.map((row) => row.id);
  }

  async function findMessages(ids: string[]) {
    return db.select().from(messages).where(inArray(messages.id, ids));
  }

  async function claimOwn(campaignId: string, limit = 1000) {
    const claimed = await repository.claimBatch(limit);
    return claimed.filter((message) => message.campaignId === campaignId);
  }

  it('SND-09: marca como sending, grava locked_at, soma 1 em attempts e devolve o necessário para enviar', async () => {
    const campaignId = await createCampaign('running', 'Oi {{nome}}');
    const [id] = await insertMessages(campaignId, 1, { attempts: 2, phone: '+5511987654321' });
    const before = Date.now();

    const claimed = await claimOwn(campaignId);

    expect(claimed).toEqual([
      {
        id,
        campaignId,
        phone: '+5511987654321',
        variables: { nome: 'Contato 0' },
        attempts: 3,
        template: 'Oi {{nome}}',
      },
    ]);
    const [stored] = await findMessages([id!]);
    expect(stored).toMatchObject({ status: 'sending', attempts: 3 });
    expect(stored!.lockedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored!.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('SND-09: mensagem reservada não é reservada de novo', async () => {
    const campaignId = await createCampaign('running');
    await insertMessages(campaignId, 3);

    const first = await claimOwn(campaignId);
    const second = await claimOwn(campaignId);

    expect(first).toHaveLength(3);
    expect(second).toEqual([]);
  });

  it('SND-06: mensagens de campanha draft ou completed não são reservadas', async () => {
    const draftId = await createCampaign('draft');
    const completedId = await createCampaign('completed');
    const ids = [...(await insertMessages(draftId, 2)), ...(await insertMessages(completedId, 2))];

    const claimed = await repository.claimBatch(1000);

    expect(claimed.filter((message) => ids.includes(message.id))).toEqual([]);
    expect((await findMessages(ids)).map((message) => message.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('SND-07: mensagem com next_attempt_at no futuro não é reservada', async () => {
    const campaignId = await createCampaign('running');
    await insertMessages(campaignId, 2, { nextAttemptAt: FUTURE });

    expect(await claimOwn(campaignId)).toEqual([]);
  });

  it('só reserva mensagens pending', async () => {
    const campaignId = await createCampaign('running');
    await insertMessages(campaignId, 1, { status: 'sent' });
    await db.insert(messages).values({
      campaignId,
      phone: '+5511900000099',
      variables: {},
      status: 'failed',
      nextAttemptAt: OLD,
    });

    expect(await claimOwn(campaignId)).toEqual([]);
  });

  it('R7: reserva por next_attempt_at e depois por ordem de criação, respeitando o limite', async () => {
    const campaignId = await createCampaign('running');
    const [late] = await insertMessages(campaignId, 1, {
      phone: '+5511911111111',
      nextAttemptAt: new Date('1998-01-03T00:00:00.000Z'),
    });
    const [firstCreated, secondCreated] = await insertMessages(campaignId, 2, {
      nextAttemptAt: new Date('1998-01-02T00:00:00.000Z'),
    });
    const [early] = await insertMessages(campaignId, 1, {
      phone: '+5511922222222',
      nextAttemptAt: new Date('1998-01-01T00:00:00.000Z'),
    });

    const firstBatch = await repository.claimBatch(3);
    const secondBatch = await repository.claimBatch(1);

    expect(firstBatch.map((message) => message.id)).toEqual([early, firstCreated, secondCreated]);
    expect(secondBatch.map((message) => message.id)).toEqual([late]);
  });

  it('SND-08: reservas simultâneas nunca pegam a mesma mensagem', async () => {
    const campaignId = await createCampaign('running');
    const ids = await insertMessages(campaignId, 200);

    const batches = await Promise.all(Array.from({ length: 4 }, () => repository.claimBatch(50)));

    const claimedIds = batches.flat().map((message) => message.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
    const stored = await db.select({ attempts: messages.attempts }).from(messages).where(eq(messages.campaignId, campaignId));
    expect(stored.every((message) => message.attempts === 1)).toBe(true);
  });

  it('devolve lista vazia quando não há nada pronto', async () => {
    const campaignId = await createCampaign('running');

    expect(await claimOwn(campaignId)).toEqual([]);
  });
});
