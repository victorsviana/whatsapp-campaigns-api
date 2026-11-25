import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns, type NewMessage, messages } from '../../../src/database/schema';

describe('GET /campaigns/:id/messages', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Lista', template: 'Oi {{nome}}', variables: ['nome'], status: 'running' })
      .returning({ id: campaigns.id });
    return campaign!.id;
  }

  function phone(index: number): string {
    return `+5511987${String(index).padStart(6, '0')}`;
  }

  async function insertMessages(campaignId: string, rows: Partial<NewMessage>[]): Promise<void> {
    await db
      .insert(messages)
      .values(rows.map((row, index) => ({ campaignId, phone: phone(index), variables: { nome: `C${index}` }, ...row })));
  }

  function list(campaignId: string, query = '') {
    return request(app).get(`/campaigns/${campaignId}/messages${query}`);
  }

  it('lista com limit 50 e offset 0 por padrão, com todos os campos de cada mensagem', async () => {
    const id = await createCampaign();
    await insertMessages(id, [
      {
        status: 'sent',
        attempts: 2,
        providerMessageId: `pm_${randomUUID()}`,
        sentAt: new Date('2026-11-24T12:00:00.000Z'),
        lastError: 'provider_unavailable',
      },
    ]);

    const response = await list(id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      total: 1,
      limit: 50,
      offset: 0,
      items: [
        {
          id: expect.any(String),
          phone: phone(0),
          variables: { nome: 'C0' },
          status: 'sent',
          attempts: 2,
          failure_reason: null,
          last_error: 'provider_unavailable',
          provider_message_id: expect.stringMatching(/^pm_/),
          sent_at: '2026-11-24T12:00:00.000Z',
          updated_at: expect.any(String),
        },
      ],
    });
  });

  it('RPT-09: ?status=failed traz só as falhas, cada uma com o failure_reason', async () => {
    const id = await createCampaign();
    await insertMessages(id, [
      { status: 'sent', providerMessageId: `pm_${randomUUID()}` },
      { status: 'failed', failureReason: 'invalid_number' },
      { status: 'pending' },
      { status: 'failed', failureReason: 'max_attempts_exceeded', lastError: 'provider_unavailable' },
    ]);

    const response = await list(id, '?status=failed');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items).toEqual([
      expect.objectContaining({ phone: phone(1), status: 'failed', failure_reason: 'invalid_number', last_error: null }),
      expect.objectContaining({
        phone: phone(3),
        status: 'failed',
        failure_reason: 'max_attempts_exceeded',
        last_error: 'provider_unavailable',
      }),
    ]);
  });

  it.each(['xyz', 'FAILED', ''])('RPT-10: ?status=%s responde 400 validation_error', async (status) => {
    const id = await createCampaign();

    const response = await list(id, `?status=${status}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toContainEqual(expect.objectContaining({ path: 'query.status' }));
  });

  it('RPT-11: 120 mensagens com limit 50 e offset 100 trazem 20 itens na ordem de cadastro', async () => {
    const id = await createCampaign();
    await insertMessages(id, Array.from({ length: 120 }, () => ({})));

    const response = await list(id, '?limit=50&offset=100');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 120, limit: 50, offset: 100 });
    expect(response.body.items.map((item: { phone: string }) => item.phone)).toEqual(
      Array.from({ length: 20 }, (_, index) => phone(100 + index)),
    );
  });

  it('RPT-11: as páginas não se repetem nem pulam mensagens', async () => {
    const id = await createCampaign();
    await insertMessages(id, Array.from({ length: 7 }, () => ({})));

    const pages = await Promise.all([0, 3, 6].map((offset) => list(id, `?limit=3&offset=${offset}`)));

    const phones = pages.flatMap((page) => page.body.items.map((item: { phone: string }) => item.phone));
    expect(phones).toEqual(Array.from({ length: 7 }, (_, index) => phone(index)));
  });

  it('offset além do fim devolve lista vazia com o total', async () => {
    const id = await createCampaign();
    await insertMessages(id, [{}, {}]);

    const response = await list(id, '?offset=10');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ total: 2, limit: 50, offset: 10, items: [] });
  });

  it.each([
    ['?limit=0', 'query.limit'],
    ['?limit=501', 'query.limit'],
    ['?limit=abc', 'query.limit'],
    ['?limit=1.5', 'query.limit'],
    ['?offset=-1', 'query.offset'],
  ])('RPT-12: %s responde 400 validation_error', async (query, path) => {
    const id = await createCampaign();

    const response = await list(id, query);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toContainEqual(expect.objectContaining({ path }));
  });

  it('RPT-12: limit 500 é aceito', async () => {
    const id = await createCampaign();

    const response = await list(id, '?limit=500');

    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(500);
  });

  it('RPT-13: campanha inexistente responde 404 campaign_not_found', async () => {
    const response = await list(randomUUID());

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('campaign_not_found');
  });
});
