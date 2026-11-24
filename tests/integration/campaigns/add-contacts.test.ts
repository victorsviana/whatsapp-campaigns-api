import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { type CampaignStatus, campaigns, messages } from '../../../src/database/schema';

describe('POST /campaigns/:id/contacts', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(template = 'Olá {{nome}}, pedido {{pedido}}'): Promise<string> {
    const response = await request(app).post('/campaigns').send({ name: 'Campanha', template });
    expect(response.status).toBe(201);
    return response.body.id;
  }

  function addContacts(campaignId: string, contacts: unknown) {
    return request(app).post(`/campaigns/${campaignId}/contacts`).send({ contacts });
  }

  function storedMessages(campaignId: string) {
    return db
      .select({ phone: messages.phone, variables: messages.variables, status: messages.status })
      .from(messages)
      .where(eq(messages.campaignId, campaignId))
      .orderBy(asc(messages.seq));
  }

  async function rejectedCount(campaignId: string): Promise<number> {
    const [campaign] = await db
      .select({ rejectedContacts: campaigns.rejectedContacts })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    return campaign?.rejectedContacts ?? -1;
  }

  async function setStatus(campaignId: string, status: CampaignStatus): Promise<void> {
    await db.update(campaigns).set({ status }).where(eq(campaigns.id, campaignId));
  }

  it('CMP-19: grava os válidos como mensagens pending e lista os inválidos com index e motivo', async () => {
    const campaignId = await createCampaign();

    const response = await addContacts(campaignId, [
      { phone: '(11) 98765-4321', variables: { nome: 'Ana', pedido: 'A-100' } },
      { phone: '11 98765-4321', variables: { nome: 'Ana', pedido: 'A-100' } },
      { phone: '123', variables: { nome: 'Bia', pedido: 'B-200' } },
      { phone: '21987650000', variables: { nome: 'Caio' } },
      { variables: { nome: 'Duda', pedido: 'D-400' } },
      { phone: '1133334444', variables: { nome: 'Edu', pedido: 1234, extra: 'x' } },
    ]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: 2,
      rejected: [
        { index: 1, phone: '11 98765-4321', reason: 'duplicate_phone' },
        { index: 2, phone: '123', reason: 'invalid_phone' },
        { index: 3, phone: '21987650000', reason: 'missing_variables', missing: ['pedido'] },
        { index: 4, phone: null, reason: 'missing_phone' },
      ],
    });
    expect(await storedMessages(campaignId)).toEqual([
      { phone: '+5511987654321', variables: { nome: 'Ana', pedido: 'A-100' }, status: 'pending' },
      { phone: '+551133334444', variables: { nome: 'Edu', pedido: '1234' }, status: 'pending' },
    ]);
    expect(await rejectedCount(campaignId)).toBe(4);
  });

  it('CMP-20: lote todo inválido responde 200 com accepted 0', async () => {
    const campaignId = await createCampaign();

    const response = await addContacts(campaignId, [{ phone: '123' }, { phone: null }]);

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected).toHaveLength(2);
    expect(await storedMessages(campaignId)).toEqual([]);
  });

  it('CMP-17: telefone aceito em lote anterior é duplicate_phone', async () => {
    const campaignId = await createCampaign();
    await addContacts(campaignId, [{ phone: '11987654321', variables: { nome: 'Ana', pedido: 'A-1' } }]);

    const response = await addContacts(campaignId, [
      { phone: '+55 (11) 98765-4321', variables: { nome: 'Ana', pedido: 'A-2' } },
      { phone: '11987650001', variables: { nome: 'Bia', pedido: 'B-1' } },
    ]);

    expect(response.body).toEqual({
      accepted: 1,
      rejected: [{ index: 0, phone: '+55 (11) 98765-4321', reason: 'duplicate_phone' }],
    });
    expect((await storedMessages(campaignId)).map((message) => message.phone)).toEqual([
      '+5511987654321',
      '+5511987650001',
    ]);
  });

  it('CMP-17: o mesmo telefone em outra campanha não é duplicado', async () => {
    const firstCampaignId = await createCampaign();
    const secondCampaignId = await createCampaign();
    const contact = { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A-1' } };
    await addContacts(firstCampaignId, [contact]);

    const response = await addContacts(secondCampaignId, [contact]);

    expect(response.body).toEqual({ accepted: 1, rejected: [] });
  });

  it('CMP-18: linha rejeitada por variável não bloqueia a próxima com o mesmo telefone', async () => {
    const campaignId = await createCampaign();

    const response = await addContacts(campaignId, [
      { phone: '11987654321', variables: { nome: 'Ana' } },
      { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A-1' } },
    ]);

    expect(response.body).toEqual({
      accepted: 1,
      rejected: [{ index: 0, phone: '11987654321', reason: 'missing_variables', missing: ['pedido'] }],
    });
  });

  it('CMP-24: o contador de rejeitados soma os lotes', async () => {
    const campaignId = await createCampaign();

    await addContacts(campaignId, [{ phone: '123' }, { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A' } }]);
    await addContacts(campaignId, [{ phone: 'abc' }, { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A' } }]);

    expect(await rejectedCount(campaignId)).toBe(3);
  });

  it('lotes simultâneos com o mesmo telefone aceitam só um', async () => {
    const campaignId = await createCampaign();
    const contact = { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A-1' } };

    const responses = await Promise.all([
      addContacts(campaignId, [contact]),
      addContacts(campaignId, [contact]),
      addContacts(campaignId, [contact]),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.reduce((total, response) => total + response.body.accepted, 0)).toBe(1);
    expect(await storedMessages(campaignId)).toHaveLength(1);
    expect(await rejectedCount(campaignId)).toBe(2);
  });

  it('CMP-21: campanha inexistente responde 404 campaign_not_found', async () => {
    const response = await addContacts(randomUUID(), [{ phone: '11987654321' }]);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'campaign_not_found', message: 'Campaign not found' },
    });
  });

  it('id que não é uuid responde 400 validation_error', async () => {
    const response = await addContacts('nao-e-uuid', [{ phone: '11987654321' }]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details[0].path).toBe('params.id');
  });

  it.each(['running', 'completed'] as const)(
    'CMP-22: campanha %s responde 409 campaign_not_draft e não grava nada',
    async (status) => {
      const campaignId = await createCampaign();
      await setStatus(campaignId, status);

      const response = await addContacts(campaignId, [
        { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A-1' } },
        { phone: '123' },
      ]);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: { code: 'campaign_not_draft', message: 'Contacts can only be added to draft campaigns' },
      });
      expect(await storedMessages(campaignId)).toEqual([]);
      expect(await rejectedCount(campaignId)).toBe(0);
    },
  );

  it.each([
    ['vazio', []],
    ['ausente', undefined],
    ['que não é lista', { phone: '11987654321' }],
    ['com mais de 10.000 itens', Array.from({ length: 10_001 }, () => ({ phone: '123' }))],
  ])('CMP-23: contacts %s responde 400 validation_error e nada é gravado', async (_case, contacts) => {
    const campaignId = await createCampaign();

    const response = await addContacts(campaignId, contacts);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(await storedMessages(campaignId)).toEqual([]);
    expect(await rejectedCount(campaignId)).toBe(0);
  });

  it('item de contacts que não é objeto responde 400 validation_error com o índice', async () => {
    const campaignId = await createCampaign();

    const response = await addContacts(campaignId, [{ phone: '11987654321' }, 'texto', null]);

    expect(response.status).toBe(400);
    expect(response.body.error.details.map((detail: { path: string }) => detail.path)).toEqual([
      'body.contacts.1',
      'body.contacts.2',
    ]);
  });

  it('R14: aceita um lote com exatamente 10.000 contatos', async () => {
    const campaignId = await createCampaign('Aviso fixo');
    const contacts = Array.from({ length: 10_000 }, (_, index) => ({
      phone: `1198${String(index).padStart(7, '0')}`,
    }));

    const response = await addContacts(campaignId, contacts);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: 10_000, rejected: [] });
    expect(await storedMessages(campaignId)).toHaveLength(10_000);
  });
});
