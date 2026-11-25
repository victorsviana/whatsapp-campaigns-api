import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns, type NewMessage, messages } from '../../../src/database/schema';

describe('GET /campaigns/:id', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  function getReport(id: string) {
    return request(app).get(`/campaigns/${id}`);
  }

  it('RPT-01: campanha inexistente responde 404 campaign_not_found', async () => {
    const response = await getReport(randomUUID());

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('campaign_not_found');
  });

  it('id que não é uuid responde 400 validation_error', async () => {
    const response = await getReport('abc');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });

  it('RPT-02: campanha recém-criada traz os dados e todos os contadores zerados', async () => {
    const created = await request(app).post('/campaigns').send({ name: 'Relatório', template: 'Oi {{nome}}' });

    const response = await getReport(created.body.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: created.body.id,
      name: 'Relatório',
      template: 'Oi {{nome}}',
      variables: ['nome'],
      status: 'draft',
      created_at: created.body.created_at,
      started_at: null,
      completed_at: null,
      contacts: { accepted: 0, rejected: 0 },
      messages: {
        by_status: { pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
        funnel: { sent: 0, delivered: 0, read: 0, failed: 0 },
        retrying: 0,
        failures_by_reason: {},
      },
    });
  });

  it('RPT-03: as 10 mensagens do exemplo da spec, contadas a partir do banco', async () => {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Exemplo', template: 'Oi', variables: [], status: 'running', startedAt: new Date() })
      .returning({ id: campaigns.id });
    const id = campaign!.id;
    const message = (index: number, values: Partial<NewMessage>): NewMessage => ({
      campaignId: id,
      phone: `+55119876543${String(index).padStart(2, '0')}`,
      variables: {},
      ...values,
    });
    const accepted = () => ({ providerMessageId: `pm_${randomUUID()}`, attempts: 1 });
    await db.insert(messages).values([
      message(0, { status: 'pending', attempts: 0 }),
      message(1, { status: 'pending', attempts: 2, lastError: 'provider_unavailable' }),
      message(2, { status: 'sent', ...accepted() }),
      message(3, { status: 'sent', ...accepted() }),
      message(4, { status: 'sent', ...accepted() }),
      message(5, { status: 'delivered', ...accepted() }),
      message(6, { status: 'delivered', ...accepted() }),
      message(7, { status: 'delivered', ...accepted() }),
      message(8, { status: 'read', ...accepted() }),
      message(9, { status: 'failed', attempts: 1, failureReason: 'invalid_number' }),
    ]);

    const response = await getReport(id);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('running');
    expect(response.body.started_at).toEqual(expect.any(String));
    expect(response.body.contacts).toEqual({ accepted: 10, rejected: 0 });
    expect(response.body.messages).toEqual({
      by_status: { pending: 2, sending: 0, sent: 3, delivered: 3, read: 1, failed: 1 },
      funnel: { sent: 7, delivered: 4, read: 1, failed: 1 },
      retrying: 1,
      failures_by_reason: { invalid_number: 1 },
    });
  });

  it('RPT-08: dois lotes com 3 e 2 rejeitados e 5 aceitos no total', async () => {
    const created = await request(app).post('/campaigns').send({ name: 'Lotes', template: 'Oi {{nome}}' });
    const id = created.body.id;
    await request(app)
      .post(`/campaigns/${id}/contacts`)
      .send({
        contacts: [
          { phone: '11987650001', variables: { nome: 'A' } },
          { phone: '11987650002', variables: { nome: 'B' } },
          { phone: '11987650003', variables: { nome: 'C' } },
          { phone: 'abc', variables: { nome: 'X' } },
          { phone: '11987650001', variables: { nome: 'A de novo' } },
          { phone: '11987650004', variables: {} },
        ],
      });
    await request(app)
      .post(`/campaigns/${id}/contacts`)
      .send({
        contacts: [
          { phone: '11987650005', variables: { nome: 'D' } },
          { phone: '11987650006', variables: { nome: 'E' } },
          { phone: '11987650001', variables: { nome: 'A outra vez' } },
          { variables: { nome: 'sem telefone' } },
        ],
      });

    const response = await getReport(id);

    expect(response.body.contacts).toEqual({ accepted: 5, rejected: 5 });
  });
});
