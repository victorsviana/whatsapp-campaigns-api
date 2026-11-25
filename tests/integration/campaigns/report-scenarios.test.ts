import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns, type NewMessage, messages } from '../../../src/database/schema';
import { createCampaignsRepository } from '../../../src/modules/campaigns/campaigns.repository';

describe('cenários combinados do relatório', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  async function createCampaign(rows: Partial<NewMessage>[]): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Cenários relatório', template: 'Oi', variables: [], status: 'running' })
      .returning({ id: campaigns.id });
    const id = campaign!.id;
    if (rows.length > 0) {
      await db.insert(messages).values(
        rows.map((row, index) => ({
          campaignId: id,
          phone: `+5511987${String(index).padStart(6, '0')}`,
          variables: {},
          ...row,
        })),
      );
    }
    return id;
  }

  const getReport = (id: string) => request(app).get(`/campaigns/${id}`);
  const list = (id: string, query = '') => request(app).get(`/campaigns/${id}/messages${query}`);

  it('RPT-04/RPT-05/RPT-07: falhas de origens diferentes contadas pelo SQL real', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const id = await createCampaign([
      { status: 'sent', attempts: 1, providerMessageId },
      { status: 'failed', attempts: 1, failureReason: 'invalid_number' },
      { status: 'failed', attempts: 1, failureReason: 'invalid_number' },
      { status: 'failed', attempts: 5, failureReason: 'max_attempts_exceeded', lastError: 'provider_unavailable' },
    ]);
    const webhook = await request(app)
      .post('/webhooks/provider')
      .send({ event_id: `evt_${randomUUID()}`, provider_message_id: providerMessageId, status: 'failed' });
    expect(webhook.body.result).toBe('applied');

    const { messages: summary } = (await getReport(id)).body;

    expect(summary.by_status).toMatchObject({ sent: 0, failed: 4 });
    expect(summary.funnel).toEqual({ sent: 1, delivered: 0, read: 0, failed: 4 });
    expect(summary.failures_by_reason).toEqual({
      invalid_number: 2,
      max_attempts_exceeded: 1,
      provider_reported_failure: 1,
    });
  });

  it('RPT-06: retrying ignora mensagens sending e failed mesmo com attempts > 0', async () => {
    const id = await createCampaign([
      { status: 'pending', attempts: 0 },
      { status: 'pending', attempts: 3 },
      { status: 'sending', attempts: 2, lockedAt: new Date() },
      { status: 'failed', attempts: 5, failureReason: 'max_attempts_exceeded' },
    ]);

    const { messages: summary } = (await getReport(id)).body;

    expect(summary.retrying).toBe(1);
    expect(summary.by_status).toMatchObject({ pending: 2, sending: 1, failed: 1 });
  });

  it('R7: relatório e lista não misturam mensagens de outra campanha', async () => {
    const first = await createCampaign([{ status: 'pending' }, { status: 'failed', failureReason: 'invalid_number' }]);
    const second = await createCampaign([{ status: 'read', providerMessageId: `pm_${randomUUID()}` }]);

    const firstReport = (await getReport(first)).body;
    const secondList = (await list(second)).body;

    expect(firstReport.contacts.accepted).toBe(2);
    expect(firstReport.messages.by_status).toMatchObject({ pending: 1, failed: 1, read: 0 });
    expect(secondList.total).toBe(1);
    expect(secondList.items).toEqual([expect.objectContaining({ status: 'read' })]);
  });

  it('RPT-09/RPT-11: filtro com paginação traz o total do filtro e a ordem de cadastro', async () => {
    const id = await createCampaign([
      { status: 'failed', failureReason: 'invalid_number' },
      { status: 'sent', providerMessageId: `pm_${randomUUID()}` },
      { status: 'failed', failureReason: 'max_attempts_exceeded' },
      { status: 'pending' },
      { status: 'failed', failureReason: 'provider_reported_failure', providerMessageId: `pm_${randomUUID()}` },
    ]);

    const response = await list(id, '?status=failed&limit=2&offset=1');

    expect(response.body).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(response.body.items.map((item: { failure_reason: string }) => item.failure_reason)).toEqual([
      'max_attempts_exceeded',
      'provider_reported_failure',
    ]);
  });

  it('SND-22: campanha concluída aparece como completed com completed_at no relatório', async () => {
    const id = await createCampaign([{ status: 'delivered', providerMessageId: `pm_${randomUUID()}` }]);
    await createCampaignsRepository(db).completeFinished();

    const report = (await getReport(id)).body;

    expect(report.status).toBe('completed');
    expect(new Date(report.completed_at).toISOString()).toBe(report.completed_at);
    expect(report.messages.funnel).toEqual({ sent: 1, delivered: 1, read: 0, failed: 0 });
  });
});
