import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { providerEvents } from '../../../src/database/schema';

describe('POST /webhooks/provider', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  function newEvent(overrides: Record<string, unknown> = {}) {
    return {
      event_id: `evt_${randomUUID()}`,
      provider_message_id: `pm_${randomUUID()}`,
      status: 'delivered',
      ...overrides,
    };
  }

  function send(body: unknown) {
    return request(app).post('/webhooks/provider').send(body as object);
  }

  async function eventsOf(providerMessageId: string) {
    return db.select().from(providerEvents).where(eq(providerEvents.providerMessageId, providerMessageId));
  }

  it.each([
    ['sem event_id', { event_id: undefined }, 'body.event_id'],
    ['com event_id vazio', { event_id: '' }, 'body.event_id'],
    ['com event_id só de espaços', { event_id: '   ' }, 'body.event_id'],
    ['com event_id numérico', { event_id: 123 }, 'body.event_id'],
    ['com event_id maior que 255', { event_id: 'e'.repeat(256) }, 'body.event_id'],
    ['sem provider_message_id', { provider_message_id: undefined }, 'body.provider_message_id'],
    ['com provider_message_id vazio', { provider_message_id: '' }, 'body.provider_message_id'],
    ['sem status', { status: undefined }, 'body.status'],
  ])('WHK-01: payload %s responde 400 validation_error e não grava nada', async (_case, overrides, path) => {
    const providerMessageId = `pm_${randomUUID()}`;
    const response = await send(newEvent({ provider_message_id: providerMessageId, ...overrides }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toContainEqual(expect.objectContaining({ path }));
    expect(await eventsOf(providerMessageId)).toHaveLength(0);
  });

  it.each(['sent', 'DELIVERED', 'abc', 'pending'])(
    'WHK-02: status %s fora da lista responde 400 validation_error e não grava nada',
    async (status) => {
      const event = newEvent({ status });

      const response = await send(event);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('validation_error');
      expect(response.body.error.details).toContainEqual(expect.objectContaining({ path: 'body.status' }));
      expect(await eventsOf(event.provider_message_id)).toHaveLength(0);
    },
  );

  it('WHK-15: evento de mensagem desconhecida responde 200 pending e fica gravado sem processed_at', async () => {
    const event = newEvent({ status: 'read' });

    const response = await send(event);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ event_id: event.event_id, result: 'pending' });
    const [stored] = await eventsOf(event.provider_message_id);
    expect(stored).toMatchObject({
      eventId: event.event_id,
      providerMessageId: event.provider_message_id,
      status: 'read',
      result: 'pending',
      processedAt: null,
    });
  });

  it('R1: campos extras são ignorados', async () => {
    const event = newEvent({ timestamp: '2026-11-24T12:00:00Z', extra: { a: 1 } });

    const response = await send(event);

    expect(response.status).toBe(200);
    expect(await eventsOf(event.provider_message_id)).toHaveLength(1);
  });

  it('WHK-11: o mesmo evento chegando de novo responde 200 duplicate e não grava outra linha', async () => {
    const event = newEvent();
    await send(event);

    const response = await send(event);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ event_id: event.event_id, result: 'duplicate' });
    expect(await eventsOf(event.provider_message_id)).toHaveLength(1);
  });

  it('WHK-12: event_id repetido com outro status é duplicate e o primeiro conteúdo vale', async () => {
    const event = newEvent({ status: 'delivered' });
    await send(event);

    const response = await send({ ...event, status: 'read' });

    expect(response.body.result).toBe('duplicate');
    const stored = await eventsOf(event.provider_message_id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('delivered');
  });

  it('WHK-13: o mesmo evento enviado várias vezes em paralelo é gravado uma vez só', async () => {
    const event = newEvent();

    const responses = await Promise.all(Array.from({ length: 8 }, () => send(event)));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    const results = responses.map((response) => response.body.result);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(7);
    expect(results.filter((result) => result !== 'duplicate')).toHaveLength(1);
    expect(await eventsOf(event.provider_message_id)).toHaveLength(1);
  });
});
