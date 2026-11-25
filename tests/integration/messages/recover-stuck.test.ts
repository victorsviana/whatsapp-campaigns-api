import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns, type NewMessage, messages } from '../../../src/database/schema';
import { createMessagesRepository } from '../../../src/modules/messages/messages.repository';

const STUCK_SINCE = new Date('1999-03-01T00:00:00.000Z');
const SENDING_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;

describe('messagesRepository.recoverStuck', () => {
  const repository = createMessagesRepository(db);

  afterAll(async () => {
    await closeDatabase();
  });

  async function insertSending(overrides: Partial<NewMessage>): Promise<string> {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Recuperação', template: 'Olá {{nome}}', variables: ['nome'], status: 'running' })
      .returning({ id: campaigns.id });
    const [message] = await db
      .insert(messages)
      .values({
        campaignId: campaign!.id,
        phone: '+5511987654321',
        variables: { nome: 'Ana' },
        status: 'sending',
        lockedAt: STUCK_SINCE,
        nextAttemptAt: STUCK_SINCE,
        ...overrides,
      })
      .returning({ id: messages.id });
    return message!.id;
  }

  async function findMessage(id: string) {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message!;
  }

  it('SND-20: mensagem presa antes do limite volta para pending, pronta na hora', async () => {
    const id = await insertSending({ attempts: 2, lastError: 'provider_unavailable' });
    const before = Date.now();

    const recovered = await repository.recoverStuck(SENDING_TIMEOUT_MS, MAX_ATTEMPTS);

    expect(recovered).toBeGreaterThanOrEqual(1);
    const stored = await findMessage(id);
    expect(stored).toMatchObject({
      status: 'pending',
      attempts: 2,
      lockedAt: null,
      failureReason: null,
      lastError: 'provider_unavailable',
    });
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('SND-21: mensagem presa na última tentativa vira failed com max_attempts_exceeded', async () => {
    const id = await insertSending({ attempts: MAX_ATTEMPTS, lastError: 'provider_unavailable' });

    await repository.recoverStuck(SENDING_TIMEOUT_MS, MAX_ATTEMPTS);

    expect(await findMessage(id)).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lockedAt: null,
      failureReason: 'max_attempts_exceeded',
      lastError: 'provider_unavailable',
    });
  });

  it('R12: mensagem em sending dentro do prazo não é tocada', async () => {
    const lockedAt = new Date();
    const id = await insertSending({ attempts: 1, lockedAt });

    await repository.recoverStuck(SENDING_TIMEOUT_MS, MAX_ATTEMPTS);

    const stored = await findMessage(id);
    expect(stored).toMatchObject({ status: 'sending', attempts: 1 });
    expect(stored.lockedAt!.getTime()).toBe(lockedAt.getTime());
  });
});
