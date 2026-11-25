import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns, messages, type ProviderEventStatus, providerEvents } from '../../../src/database/schema';
import { createMessagesRepository } from '../../../src/modules/messages/messages.repository';
import { createWebhooksRepository, type WebhooksRepository } from '../../../src/modules/webhooks/webhooks.repository';
import { createWebhooksService } from '../../../src/modules/webhooks/webhooks.service';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('eventos que chegam antes da mensagem', () => {
  const app = createApp();
  const messagesRepository = createMessagesRepository(db);

  afterAll(async () => {
    await closeDatabase();
  });

  async function createSendingMessage(): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Pendentes', template: 'Oi', variables: [], status: 'running' })
      .returning({ id: campaigns.id });
    const [message] = await db
      .insert(messages)
      .values({
        campaignId: campaign!.id,
        phone: '+5511987654321',
        variables: {},
        status: 'sending',
        attempts: 1,
        lockedAt: new Date(),
      })
      .returning({ id: messages.id });
    return message!.id;
  }

  async function sendEvent(providerMessageId: string, status: ProviderEventStatus) {
    const eventId = `evt_${randomUUID()}`;
    const response = await request(app)
      .post('/webhooks/provider')
      .send({ event_id: eventId, provider_message_id: providerMessageId, status });
    expect(response.body.result).toBe('pending');
    return eventId;
  }

  async function findMessage(id: string) {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message!;
  }

  async function findEvent(eventId: string) {
    const [event] = await db.select().from(providerEvents).where(eq(providerEvents.eventId, eventId));
    return event!;
  }

  it('WHK-16: evento read pendente é aplicado quando o worker grava a mensagem como sent', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const eventId = await sendEvent(providerMessageId, 'read');
    const messageId = await createSendingMessage();

    const applied = await messagesRepository.markSent(messageId, providerMessageId);

    expect(applied).toBe(true);
    expect(await findMessage(messageId)).toMatchObject({ status: 'read', providerMessageId });
    const event = await findEvent(eventId);
    expect(event.result).toBe('applied');
    expect(event.processedAt).not.toBeNull();
  });

  it('WHK-17: pendentes read e delivered terminam em read, cada evento com seu resultado', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const readEvent = await sendEvent(providerMessageId, 'read');
    const deliveredEvent = await sendEvent(providerMessageId, 'delivered');
    const messageId = await createSendingMessage();

    await messagesRepository.markSent(messageId, providerMessageId);

    expect((await findMessage(messageId)).status).toBe('read');
    expect((await findEvent(readEvent)).result).toBe('applied');
    expect((await findEvent(deliveredEvent)).result).toBe('ignored');
  });

  it('WHK-17: pendentes delivered e depois read também terminam em read', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const deliveredEvent = await sendEvent(providerMessageId, 'delivered');
    const readEvent = await sendEvent(providerMessageId, 'read');
    const messageId = await createSendingMessage();

    await messagesRepository.markSent(messageId, providerMessageId);

    expect((await findMessage(messageId)).status).toBe('read');
    expect((await findEvent(deliveredEvent)).result).toBe('applied');
    expect((await findEvent(readEvent)).result).toBe('applied');
  });

  it('R10: failed pendente é aplicado com provider_reported_failure', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    await sendEvent(providerMessageId, 'failed');
    const messageId = await createSendingMessage();

    await messagesRepository.markSent(messageId, providerMessageId);

    expect(await findMessage(messageId)).toMatchObject({
      status: 'failed',
      failureReason: 'provider_reported_failure',
    });
  });

  it('R10: markSent sem eventos pendentes só grava sent', async () => {
    const messageId = await createSendingMessage();

    await messagesRepository.markSent(messageId, `pm_${randomUUID()}`);

    expect((await findMessage(messageId)).status).toBe('sent');
  });

  it('R11.3: markSent de mensagem que já saiu de sending não aplica os pendentes', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const eventId = await sendEvent(providerMessageId, 'read');
    const messageId = await createSendingMessage();
    await db.update(messages).set({ status: 'failed' }).where(eq(messages.id, messageId));

    const applied = await messagesRepository.markSent(messageId, providerMessageId);

    expect(applied).toBe(false);
    expect((await findEvent(eventId)).result).toBe('pending');
  });

  it('R9/R10: webhook e worker ao mesmo tempo não deixam o evento pendente para sempre', async () => {
    const providerMessageId = `pm_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const messageId = await createSendingMessage();

    let releaseWebhook!: () => void;
    const webhookHeld = new Promise<void>((resolve) => {
      releaseWebhook = resolve;
    });
    let signalLookedUp!: () => void;
    const lookedUp = new Promise<void>((resolve) => {
      signalLookedUp = resolve;
    });

    const real = createWebhooksRepository(db);
    const paused: WebhooksRepository = {
      ...real,
      transaction: (work) =>
        real.transaction((tx) =>
          work({
            ...tx,
            findMessageForUpdate: async (id) => {
              const message = await tx.findMessageForUpdate(id);
              signalLookedUp();
              await webhookHeld;
              return message;
            },
          }),
        ),
    };
    const webhook = createWebhooksService(paused).receiveEvent({
      event_id: eventId,
      provider_message_id: providerMessageId,
      status: 'read',
    });
    await lookedUp;

    let workerDone = false;
    const worker = messagesRepository.markSent(messageId, providerMessageId).then((result) => {
      workerDone = true;
      return result;
    });
    await wait(100);
    expect(workerDone).toBe(false);

    releaseWebhook();
    expect(await webhook).toBe('pending');
    expect(await worker).toBe(true);

    expect((await findMessage(messageId)).status).toBe('read');
    expect((await findEvent(eventId)).result).toBe('applied');
  });
});
