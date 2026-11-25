import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns } from '../../../src/database/schema';

describe('POST /campaigns/:id/start', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(): Promise<string> {
    const response = await request(app).post('/campaigns').send({ name: 'Campanha', template: 'Oi {{nome}}' });
    expect(response.status).toBe(201);
    return response.body.id;
  }

  async function createCampaignWithContacts(): Promise<string> {
    const campaignId = await createCampaign();
    const response = await request(app)
      .post(`/campaigns/${campaignId}/contacts`)
      .send({ contacts: [{ phone: '11987654321', variables: { nome: 'Ana' } }] });
    expect(response.body.accepted).toBe(1);
    return campaignId;
  }

  function start(campaignId: string) {
    return request(app).post(`/campaigns/${campaignId}/start`);
  }

  async function findCampaign(campaignId: string) {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    return campaign;
  }

  it('SND-01: campanha draft com mensagens vira running com started_at', async () => {
    const campaignId = await createCampaignWithContacts();
    const before = Date.now();

    const response = await start(campaignId);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ id: campaignId, status: 'running', started_at: expect.any(String) });
    expect(Date.parse(response.body.started_at)).toBeGreaterThanOrEqual(before - 1000);

    const stored = await findCampaign(campaignId);
    expect(stored?.status).toBe('running');
    expect(stored?.startedAt?.toISOString()).toBe(response.body.started_at);
  });

  it('SND-02: chamar start de novo em campanha running responde 202 e mantém started_at', async () => {
    const campaignId = await createCampaignWithContacts();
    const first = await start(campaignId);

    const second = await start(campaignId);

    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
  });

  it('SND-02: campanha completed responde 202 com o estado atual sem mudar nada', async () => {
    const campaignId = await createCampaignWithContacts();
    const startedAt = new Date('2026-11-24T12:05:00.000Z');
    await db
      .update(campaigns)
      .set({ status: 'completed', startedAt, completedAt: new Date('2026-11-24T12:10:00.000Z') })
      .where(eq(campaigns.id, campaignId));

    const response = await start(campaignId);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ id: campaignId, status: 'completed', started_at: startedAt.toISOString() });
    expect((await findCampaign(campaignId))?.status).toBe('completed');
  });

  it('SND-03: chamadas simultâneas respondem 202 e a campanha muda de estado uma vez só', async () => {
    const campaignId = await createCampaignWithContacts();

    const responses = await Promise.all(Array.from({ length: 5 }, () => start(campaignId)));

    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202]);
    const startedAts = new Set(responses.map((response) => response.body.started_at));
    expect(startedAts.size).toBe(1);
    expect((await findCampaign(campaignId))?.startedAt?.toISOString()).toBe([...startedAts][0]);
  });

  it('SND-04: campanha draft sem mensagens responde 409 campaign_has_no_contacts', async () => {
    const campaignId = await createCampaign();

    const response = await start(campaignId);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'campaign_has_no_contacts', message: 'Campaign has no contacts to send' },
    });
    expect(await findCampaign(campaignId)).toMatchObject({ status: 'draft', startedAt: null });
  });

  it('SND-04: lote todo rejeitado não conta como contato', async () => {
    const campaignId = await createCampaign();
    await request(app).post(`/campaigns/${campaignId}/contacts`).send({ contacts: [{ phone: '123' }] });

    const response = await start(campaignId);

    expect(response.status).toBe(409);
  });

  it('SND-05: campanha inexistente responde 404 campaign_not_found', async () => {
    const response = await start(randomUUID());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'campaign_not_found', message: 'Campaign not found' } });
  });

  it('id que não é uuid responde 400 validation_error', async () => {
    const response = await start('nao-e-uuid');

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].path).toBe('params.id');
  });

  it('R12 da spec 01: depois do start não aceita mais contatos', async () => {
    const campaignId = await createCampaignWithContacts();
    await start(campaignId);

    const response = await request(app)
      .post(`/campaigns/${campaignId}/contacts`)
      .send({ contacts: [{ phone: '11987650001', variables: { nome: 'Bia' } }] });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('campaign_not_draft');
  });
});
