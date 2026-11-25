import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { closeDatabase, db } from '../../src/database/client';
import { createFakeProviderAdapter } from '../../src/integrations/messaging/fake-provider.adapter';
import type { SendMessageInput } from '../../src/integrations/messaging/messaging-provider';
import { createCampaignsRepository } from '../../src/modules/campaigns/campaigns.repository';
import { createMessageProcessor } from '../../src/modules/messages/message.processor';
import { createMessagesRepository } from '../../src/modules/messages/messages.repository';
import { createRetryPolicy } from '../../src/modules/messages/retry-policy';
import { createDispatchWorker } from '../../src/workers/dispatch.worker';

const ANA = '+5511977771001';
const BRUNO = '+5511977771002';
const CARLA = '+5511977770000';
const DAVI = '+5511977771004';
const MAX_ATTEMPTS = 3;

function providerError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('fluxo ponta a ponta de uma campanha', () => {
  const app = createApp();
  const sentBodies = new Map<string, string>();
  const calls = new Map<string, number>();

  async function scriptedSend({ to, body }: SendMessageInput) {
    const attempt = (calls.get(to) ?? 0) + 1;
    calls.set(to, attempt);
    if (to.endsWith('0000')) {
      throw providerError(400, 'invalid_number');
    }
    if (to === DAVI || (to === BRUNO && attempt < MAX_ATTEMPTS)) {
      throw providerError(503, 'provider_unavailable');
    }
    sentBodies.set(to, body);
    return { providerMessageId: `pm_${randomUUID()}` };
  }

  const messagesRepository = createMessagesRepository(db);
  const worker = createDispatchWorker({
    repository: messagesRepository,
    campaignsRepository: createCampaignsRepository(db),
    processor: createMessageProcessor({
      provider: createFakeProviderAdapter({ timeoutMs: 1000, send: scriptedSend }),
      repository: messagesRepository,
      retryPolicy: createRetryPolicy({ maxAttempts: MAX_ATTEMPTS, baseMs: 10, maxMs: 20 }),
    }),
    batchSize: 10,
    concurrency: 4,
    pollIntervalMs: 10,
    sendingTimeoutMs: 30_000,
    maxAttempts: MAX_ATTEMPTS,
    logger: { info() {}, error() {} },
  });

  afterAll(async () => {
    await worker.stop();
    await closeDatabase();
  });

  const getReport = (id: string) => request(app).get(`/campaigns/${id}`);

  async function waitForStatus(id: string, status: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await getReport(id);
      if (response.body.status === status) {
        return response.body;
      }
      if (Date.now() > deadline) {
        throw new Error(`campanha ${id} não chegou em ${status}: ${JSON.stringify(response.body)}`);
      }
      await delay(25);
    }
  }

  async function listMessages(id: string) {
    const response = await request(app).get(`/campaigns/${id}/messages`);
    expect(response.status).toBe(200);
    return new Map<string, Record<string, unknown>>(
      response.body.items.map((item: Record<string, unknown>) => [item.phone as string, item]),
    );
  }

  function sendEvent(providerMessageId: string, status: string, eventId = `evt_${randomUUID()}`) {
    return request(app)
      .post('/webhooks/provider')
      .send({ event_id: eventId, provider_message_id: providerMessageId, status });
  }

  it('CMP-01/CMP-08/CMP-09/CMP-12/CMP-14/CMP-16/CMP-19/SND-01/SND-11/SND-12/SND-14/SND-16/SND-22/WHK-03/WHK-04/WHK-05/WHK-06/WHK-11/WHK-18/RPT-05/RPT-07/RPT-09: cria, recebe contatos, inicia, envia pelo worker, aplica webhooks e reporta', async () => {
    const created = await request(app)
      .post('/campaigns')
      .send({ name: 'Black Friday', template: 'Olá {{nome}}, seu cupom é {{cupom}}' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', variables: ['nome', 'cupom'] });
    const id: string = created.body.id;

    const contacts = await request(app)
      .post(`/campaigns/${id}/contacts`)
      .send({
        contacts: [
          { phone: '11977771001', variables: { nome: 'Ana', cupom: 'A1' } },
          { phone: '(11) 97777-1002', variables: { nome: 'Bruno', cupom: 'B2' } },
          { phone: '5511977770000', variables: { nome: 'Carla', cupom: 'C3' } },
          { phone: '11977771004', variables: { nome: 'Davi', cupom: 'D4' } },
          { phone: '123', variables: { nome: 'Inválido', cupom: 'X' } },
          { phone: '+55 11 97777-1001', variables: { nome: 'Ana de novo', cupom: 'A9' } },
          { phone: '11977771007', variables: { nome: 'Sem cupom' } },
        ],
      });
    expect(contacts.status).toBe(200);
    expect(contacts.body.accepted).toBe(4);
    expect(contacts.body.rejected).toEqual([
      expect.objectContaining({ index: 4, reason: 'invalid_phone' }),
      expect.objectContaining({ index: 5, reason: 'duplicate_phone' }),
      expect.objectContaining({ index: 6, reason: 'missing_variables', missing: ['cupom'] }),
    ]);

    const started = await request(app).post(`/campaigns/${id}/start`);
    expect(started.status).toBe(202);
    expect(started.body.status).toBe('running');

    void worker.start();
    const completed = await waitForStatus(id, 'completed');
    await worker.stop();

    expect(completed.started_at).not.toBeNull();
    expect(completed.completed_at).not.toBeNull();
    expect(completed.contacts).toEqual({ accepted: 4, rejected: 3 });
    expect(completed.messages.by_status).toMatchObject({ pending: 0, sending: 0, sent: 2, failed: 2 });
    expect(completed.messages.retrying).toBe(0);
    expect(completed.messages.failures_by_reason).toEqual({ invalid_number: 1, max_attempts_exceeded: 1 });

    expect(sentBodies.get(ANA)).toBe('Olá Ana, seu cupom é A1');
    expect(sentBodies.get(BRUNO)).toBe('Olá Bruno, seu cupom é B2');

    const afterSend = await listMessages(id);
    expect(afterSend.get(ANA)).toMatchObject({ status: 'sent', attempts: 1, failure_reason: null });
    expect(afterSend.get(BRUNO)).toMatchObject({
      status: 'sent',
      attempts: MAX_ATTEMPTS,
      last_error: 'provider_unavailable',
    });
    expect(afterSend.get(CARLA)).toMatchObject({
      status: 'failed',
      attempts: 1,
      failure_reason: 'invalid_number',
      provider_message_id: null,
    });
    expect(afterSend.get(DAVI)).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      failure_reason: 'max_attempts_exceeded',
      last_error: 'provider_unavailable',
    });

    const anaPm = afterSend.get(ANA)!.provider_message_id as string;
    const brunoPm = afterSend.get(BRUNO)!.provider_message_id as string;
    const anaDelivered = `evt_${randomUUID()}`;
    expect((await sendEvent(anaPm, 'delivered', anaDelivered)).body.result).toBe('applied');
    expect((await sendEvent(anaPm, 'delivered', anaDelivered)).body.result).toBe('duplicate');
    expect((await sendEvent(anaPm, 'read')).body.result).toBe('applied');
    expect((await sendEvent(brunoPm, 'read')).body.result).toBe('applied');
    expect((await sendEvent(brunoPm, 'delivered')).body.result).toBe('ignored');
    expect((await sendEvent(brunoPm, 'failed')).body.result).toBe('ignored');

    const final = (await getReport(id)).body;
    expect(final.status).toBe('completed');
    expect(final.completed_at).toBe(completed.completed_at);
    expect(final.messages.by_status).toMatchObject({ sent: 0, delivered: 0, read: 2, failed: 2 });
    expect(final.messages.funnel).toEqual({ sent: 2, delivered: 2, read: 2, failed: 2 });
    expect(final.messages.failures_by_reason).toEqual({ invalid_number: 1, max_attempts_exceeded: 1 });

    const failedOnly = await request(app).get(`/campaigns/${id}/messages?status=failed`);
    expect(failedOnly.body.total).toBe(2);
    expect(failedOnly.body.items.map((item: { phone: string }) => item.phone).sort()).toEqual([CARLA, DAVI].sort());
  });
});
