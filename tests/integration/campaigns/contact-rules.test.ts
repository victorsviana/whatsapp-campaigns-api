import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { messages } from '../../../src/database/schema';

describe('POST /campaigns/:id/contacts: regras de telefone e variáveis contra o Postgres', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(template: string): Promise<string> {
    const response = await request(app).post('/campaigns').send({ name: 'Campanha', template });
    expect(response.status).toBe(201);
    return response.body.id;
  }

  function addContacts(campaignId: string, contacts: unknown[]) {
    return request(app).post(`/campaigns/${campaignId}/contacts`).send({ contacts });
  }

  function storedMessages(campaignId: string) {
    return db
      .select({ phone: messages.phone, variables: messages.variables })
      .from(messages)
      .where(eq(messages.campaignId, campaignId))
      .orderBy(asc(messages.seq));
  }

  it.each([
    ['CMP-08', '(11) 98765-4321', '+5511987654321'],
    ['CMP-09', '+55 11 98765-4321', '+5511987654321'],
    ['CMP-10', '011 98765-4321', '+5511987654321'],
    ['CMP-11', '1133334444', '+551133334444'],
  ])('%s: "%s" é gravado como %s', async (_id, phone, expected) => {
    const campaignId = await createCampaign('Aviso fixo');

    const response = await addContacts(campaignId, [{ phone }]);

    expect(response.body).toEqual({ accepted: 1, rejected: [] });
    expect(await storedMessages(campaignId)).toEqual([{ phone: expected, variables: {} }]);
  });

  it('CMP-12: telefones inválidos são rejeitados como invalid_phone com o valor como veio', async () => {
    const campaignId = await createCampaign('Aviso fixo');
    const phones = ['123', 'abc', '11887654321', '0198765432', '+1 415 555 0100'];

    const response = await addContacts(
      campaignId,
      phones.map((phone) => ({ phone })),
    );

    expect(response.body).toEqual({
      accepted: 0,
      rejected: phones.map((phone, index) => ({ index, phone, reason: 'invalid_phone' })),
    });
    expect(await storedMessages(campaignId)).toEqual([]);
  });

  it('CMP-13: phone ausente, null ou só espaços é missing_phone', async () => {
    const campaignId = await createCampaign('Aviso fixo');

    const response = await addContacts(campaignId, [{}, { phone: null }, { phone: '   ' }]);

    expect(response.body).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, phone: null, reason: 'missing_phone' },
        { index: 1, phone: null, reason: 'missing_phone' },
        { index: 2, phone: '   ', reason: 'missing_phone' },
      ],
    });
  });

  it('CMP-14: pedido ausente, vazio, null ou objeto é missing_variables', async () => {
    const campaignId = await createCampaign('Olá {{nome}}, pedido {{pedido}}');

    const response = await addContacts(campaignId, [
      { phone: '11987650001', variables: { nome: 'Ana' } },
      { phone: '11987650002', variables: { nome: 'Bia', pedido: '' } },
      { phone: '11987650003', variables: { nome: 'Caio', pedido: null } },
      { phone: '11987650004', variables: { nome: 'Duda', pedido: {} } },
    ]);

    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected).toEqual(
      [0, 1, 2, 3].map((index) => ({
        index,
        phone: `1198765000${index + 1}`,
        reason: 'missing_variables',
        missing: ['pedido'],
      })),
    );
  });

  it('CMP-15: variável extra é aceita e não é gravada', async () => {
    const campaignId = await createCampaign('Olá {{nome}}');

    const response = await addContacts(campaignId, [
      { phone: '11987654321', variables: { nome: 'Ana', cidade: 'São Paulo' } },
    ]);

    expect(response.body).toEqual({ accepted: 1, rejected: [] });
    expect(await storedMessages(campaignId)).toEqual([{ phone: '+5511987654321', variables: { nome: 'Ana' } }]);
  });

  it('CMP-16: mesmo telefone em formatos diferentes no lote grava só o primeiro', async () => {
    const campaignId = await createCampaign('Olá {{nome}}');

    const response = await addContacts(campaignId, [
      { phone: '(11) 98765-4321', variables: { nome: 'Ana' } },
      { phone: '+55 11 98765-4321', variables: { nome: 'Ana 2' } },
      { phone: '011987654321', variables: { nome: 'Ana 3' } },
    ]);

    expect(response.body).toEqual({
      accepted: 1,
      rejected: [
        { index: 1, phone: '+55 11 98765-4321', reason: 'duplicate_phone' },
        { index: 2, phone: '011987654321', reason: 'duplicate_phone' },
      ],
    });
    expect(await storedMessages(campaignId)).toEqual([{ phone: '+5511987654321', variables: { nome: 'Ana' } }]);
  });
});
