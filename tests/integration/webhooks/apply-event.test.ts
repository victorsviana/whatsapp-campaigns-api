import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import {
  type CampaignStatus,
  campaigns,
  type MessageStatus,
  messages,
  type ProviderEventStatus,
  providerEvents,
} from '../../../src/database/schema';
import { createWebhooksRepository, type WebhooksRepository } from '../../../src/modules/webhooks/webhooks.repository';
import { createWebhooksService } from '../../../src/modules/webhooks/webhooks.service';

describe('POST /webhooks/provider aplicando o evento na mensagem', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  async function createSentMessage(
    status: MessageStatus,
    campaignStatus: CampaignStatus = 'running',
  ): Promise<{ id: string; providerMessageId: string }> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Webhooks', template: 'Oi', variables: [], status: campaignStatus })
      .returning({ id: campaigns.id });
    const providerMessageId = `pm_${randomUUID()}`;
    const [message] = await db
      .insert(messages)
      .values({
        campaignId: campaign!.id,
        phone: '+5511987654321',
        variables: {},
        status,
        attempts: 1,
        providerMessageId,
        sentAt: new Date(),
        failureReason: status === 'failed' ? 'invalid_number' : null,
      })
      .returning({ id: messages.id });
    return { id: message!.id, providerMessageId };
  }

  function sendEvent(providerMessageId: string, status: ProviderEventStatus, eventId = `evt_${randomUUID()}`) {
    return request(app)
      .post('/webhooks/provider')
      .send({ event_id: eventId, provider_message_id: providerMessageId, status });
  }

  async function findMessage(id: string) {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message!;
  }

  async function findEvent(eventId: string) {
    const [event] = await db.select().from(providerEvents).where(eq(providerEvents.eventId, eventId));
    return event;
  }

  it.each<[string, MessageStatus, ProviderEventStatus, 'applied' | 'ignored', MessageStatus]>([
    ['WHK-03', 'sent', 'delivered', 'applied', 'delivered'],
    ['WHK-04', 'delivered', 'read', 'applied', 'read'],
    ['WHK-05', 'sent', 'read', 'applied', 'read'],
    ['WHK-06', 'read', 'delivered', 'ignored', 'read'],
    ['WHK-07', 'sent', 'failed', 'applied', 'failed'],
    ['WHK-08', 'delivered', 'failed', 'ignored', 'delivered'],
    ['WHK-09', 'failed', 'delivered', 'ignored', 'failed'],
    ['WHK-09', 'failed', 'read', 'ignored', 'failed'],
    ['WHK-10', 'delivered', 'delivered', 'ignored', 'delivered'],
    ['R6', 'read', 'failed', 'ignored', 'read'],
  ])('%s: mensagem %s com evento %s → %s, mensagem fica %s', async (_id, current, event, result, finalStatus) => {
    const message = await createSentMessage(current);

    const response = await sendEvent(message.providerMessageId, event);

    expect(response.status).toBe(200);
    expect(response.body.result).toBe(result);
    expect((await findMessage(message.id)).status).toBe(finalStatus);
  });

  it('WHK-07: falha via webhook grava failure_reason = provider_reported_failure', async () => {
    const message = await createSentMessage('sent');

    await sendEvent(message.providerMessageId, 'failed');

    expect(await findMessage(message.id)).toMatchObject({
      status: 'failed',
      failureReason: 'provider_reported_failure',
    });
  });

  it('WHK-09: evento ignorado não mexe no failure_reason da mensagem que já falhou', async () => {
    const message = await createSentMessage('failed');

    await sendEvent(message.providerMessageId, 'read');

    expect((await findMessage(message.id)).failureReason).toBe('invalid_number');
  });

  it('WHK-12: event_id repetido com outro status não muda a mensagem', async () => {
    const message = await createSentMessage('sent');
    const eventId = `evt_${randomUUID()}`;
    await sendEvent(message.providerMessageId, 'delivered', eventId);

    const response = await sendEvent(message.providerMessageId, 'read', eventId);

    expect(response.body.result).toBe('duplicate');
    expect((await findMessage(message.id)).status).toBe('delivered');
  });

  it('WHK-13: o mesmo evento em paralelo é aplicado uma única vez', async () => {
    const message = await createSentMessage('sent');
    const eventId = `evt_${randomUUID()}`;

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => sendEvent(message.providerMessageId, 'delivered', eventId)),
    );

    const results = responses.map((response) => response.body.result).sort();
    expect(results).toEqual(['applied', ...Array(7).fill('duplicate')]);
    expect((await findMessage(message.id)).status).toBe('delivered');
  });

  it('WHK-14: delivered e read em paralelo, em qualquer ordem, terminam em read', async () => {
    for (let round = 0; round < 10; round += 1) {
      const message = await createSentMessage('sent');
      const events: ProviderEventStatus[] = round % 2 === 0 ? ['delivered', 'read'] : ['read', 'delivered'];

      await Promise.all(events.map((status) => sendEvent(message.providerMessageId, status)));

      expect((await findMessage(message.id)).status).toBe('read');
    }
  });

  it('WHK-18: evento de mensagem de campanha completed ainda é aplicado', async () => {
    const message = await createSentMessage('sent', 'completed');

    const response = await sendEvent(message.providerMessageId, 'delivered');

    expect(response.body.result).toBe('applied');
    expect((await findMessage(message.id)).status).toBe('delivered');
  });

  it.each<[MessageStatus, ProviderEventStatus, 'applied' | 'ignored']>([
    ['sent', 'delivered', 'applied'],
    ['read', 'delivered', 'ignored'],
  ])('WHK-19: evento processado (mensagem %s, evento %s) grava result %s e processed_at', async (current, event, result) => {
    const message = await createSentMessage(current);
    const eventId = `evt_${randomUUID()}`;
    const before = Date.now();

    await sendEvent(message.providerMessageId, event, eventId);

    const stored = await findEvent(eventId);
    expect(stored!.result).toBe(result);
    expect(stored!.processedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('R14: se algo falha no meio, nem o evento nem a mensagem ficam gravados', async () => {
    const message = await createSentMessage('sent');
    const eventId = `evt_${randomUUID()}`;
    const real = createWebhooksRepository(db);
    const failing: WebhooksRepository = {
      ...real,
      transaction: (work) =>
        real.transaction((tx) =>
          work({
            ...tx,
            markEventProcessed: async () => {
              throw new Error('falha simulada');
            },
          }),
        ),
    };
    const service = createWebhooksService(failing);

    await expect(
      service.receiveEvent({ event_id: eventId, provider_message_id: message.providerMessageId, status: 'delivered' }),
    ).rejects.toThrow('falha simulada');

    expect(await findEvent(eventId)).toBeUndefined();
    expect((await findMessage(message.id)).status).toBe('sent');
  });
});
