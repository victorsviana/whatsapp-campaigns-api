import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import {
  type MessageStatus,
  campaigns,
  messages,
  type ProviderEventStatus,
  providerEvents,
} from '../../../src/database/schema';
import { createMessageProcessor } from '../../../src/modules/messages/message.processor';
import { createMessagesRepository } from '../../../src/modules/messages/messages.repository';
import { createRetryPolicy } from '../../../src/modules/messages/retry-policy';

const OLD = new Date('1997-01-01T00:00:00.000Z');

describe('cenários combinados de webhooks', () => {
  const app = createApp();
  const messagesRepository = createMessagesRepository(db);

  afterAll(async () => {
    await closeDatabase();
  });

  async function createMessage(status: MessageStatus, providerMessageId: string | null = null): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Cenários', template: 'Olá {{nome}}', variables: ['nome'], status: 'running' })
      .returning({ id: campaigns.id });
    const [message] = await db
      .insert(messages)
      .values({
        campaignId: campaign!.id,
        phone: '+5511987654321',
        variables: { nome: 'Ana' },
        status,
        attempts: status === 'pending' ? 0 : 1,
        providerMessageId,
        lockedAt: status === 'sending' ? new Date() : null,
        nextAttemptAt: OLD,
      })
      .returning({ id: messages.id });
    return message!.id;
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

  async function eventResults(providerMessageId: string) {
    const rows = await db
      .select({ status: providerEvents.status, result: providerEvents.result })
      .from(providerEvents)
      .where(eq(providerEvents.providerMessageId, providerMessageId));
    return Object.fromEntries(rows.map((row) => [row.status, row.result]));
  }

  it('WHK-11: evento pendente repetido é duplicate e é aplicado uma vez só quando a mensagem aparece', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    expect((await sendEvent(providerMessageId, 'delivered', eventId)).body.result).toBe('pending');
    expect((await sendEvent(providerMessageId, 'delivered', eventId)).body.result).toBe('duplicate');
    const messageId = await createMessage('sending');

    await messagesRepository.markSent(messageId, providerMessageId);

    expect((await findMessage(messageId)).status).toBe('delivered');
    const rows = await db.select().from(providerEvents).where(eq(providerEvents.eventId, eventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe('applied');
  });

  it('R10: eventos pendentes de outro provider_message_id não são aplicados', async () => {
    const otherProviderMessageId = `pm_${randomUUID()}`;
    await sendEvent(otherProviderMessageId, 'read');
    const messageId = await createMessage('sending');

    await messagesRepository.markSent(messageId, `pm_${randomUUID()}`);

    expect((await findMessage(messageId)).status).toBe('sent');
    expect(await eventResults(otherProviderMessageId)).toEqual({ read: 'pending' });
  });

  it('WHK-14: delivered, read e failed em paralelo nunca regridem e os resultados batem com o status final', async () => {
    const finals = new Set<MessageStatus>();
    for (let round = 0; round < 15; round += 1) {
      const providerMessageId = `pm_${randomUUID()}`;
      const messageId = await createMessage('sent', providerMessageId);
      const orders: ProviderEventStatus[][] = [
        ['delivered', 'read', 'failed'],
        ['failed', 'read', 'delivered'],
        ['read', 'failed', 'delivered'],
      ];
      const order = orders[round % orders.length]!;

      const responses = await Promise.all(order.map((status) => sendEvent(providerMessageId, status)));

      expect(responses.every((response) => response.status === 200)).toBe(true);
      const message = await findMessage(messageId);
      const results = await eventResults(providerMessageId);
      finals.add(message.status);
      if (message.status === 'failed') {
        expect(message.failureReason).toBe('provider_reported_failure');
        expect(results).toEqual({ failed: 'applied', delivered: 'ignored', read: 'ignored' });
      } else {
        expect(message.status).toBe('read');
        expect(message.failureReason).toBeNull();
        expect(results.read).toBe('applied');
        expect(results.failed).toBe('ignored');
      }
    }
    expect([...finals].every((status) => status === 'read' || status === 'failed')).toBe(true);
  });

  it('WHK-16: fluxo completo pelo worker, com o webhook chegando antes da resposta do provedor', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const messageId = await createMessage('pending');
    const processor = createMessageProcessor({
      repository: messagesRepository,
      retryPolicy: createRetryPolicy({ maxAttempts: 5, baseMs: 1000, maxMs: 1000 }),
      provider: {
        async sendMessage() {
          const response = await sendEvent(providerMessageId, 'read');
          expect(response.body.result).toBe('pending');
          return { providerMessageId };
        },
      },
    });

    const claimed = (await messagesRepository.claimBatch(1000)).find((message) => message.id === messageId);
    expect(claimed).toBeDefined();
    const outcome = await processor.process(claimed!);

    expect(outcome).toEqual({ messageId, result: 'sent', applied: true });
    expect(await findMessage(messageId)).toMatchObject({ status: 'read', providerMessageId });
    expect(await eventResults(providerMessageId)).toEqual({ read: 'applied' });
  });
});
