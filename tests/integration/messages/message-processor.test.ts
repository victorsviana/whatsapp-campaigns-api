import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns, messages } from '../../../src/database/schema';
import {
  type MessagingProvider,
  ProviderError,
  type SendMessageInput,
} from '../../../src/integrations/messaging/messaging-provider';
import { createMessageProcessor } from '../../../src/modules/messages/message.processor';
import { type ClaimedMessage, createMessagesRepository } from '../../../src/modules/messages/messages.repository';
import { createRetryPolicy } from '../../../src/modules/messages/retry-policy';

const OLD = new Date('1999-06-01T00:00:00.000Z');

type SendBehavior = (input: SendMessageInput) => Promise<{ providerMessageId: string }>;

function stubProvider(behavior: SendBehavior) {
  const sendMessage = vi.fn(behavior);
  const provider: MessagingProvider = { sendMessage };
  return { provider, sendMessage };
}

const succeed: SendBehavior = async () => ({ providerMessageId: `pm_${crypto.randomUUID()}` });
const failWith = (error: unknown): SendBehavior => async () => {
  throw error;
};

describe('messageProcessor.process', () => {
  const repository = createMessagesRepository(db);
  const retryPolicy = createRetryPolicy({ maxAttempts: 5, baseMs: 60_000, maxMs: 60_000, random: () => 1 });

  afterAll(async () => {
    await closeDatabase();
  });

  async function claimOne(options: { template?: string; variables?: Record<string, string>; attempts?: number } = {}) {
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Envio', template: options.template ?? 'Olá {{nome}}', variables: ['nome'], status: 'running' })
      .returning({ id: campaigns.id });
    await db.insert(messages).values({
      campaignId: campaign!.id,
      phone: '+5511987654321',
      variables: options.variables ?? { nome: 'Ana' },
      attempts: options.attempts ?? 0,
      nextAttemptAt: OLD,
    });
    const claimed = await repository.claimBatch(1000);
    const message = claimed.find((item) => item.campaignId === campaign!.id);
    expect(message).toBeDefined();
    return message as ClaimedMessage;
  }

  async function findMessage(id: string) {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message!;
  }

  it('SND-10: sucesso grava sent, provider_message_id e sent_at', async () => {
    const message = await claimOne();
    const { provider } = stubProvider(async () => ({ providerMessageId: `pm_sucesso_${message.id}` }));
    const processor = createMessageProcessor({ provider, repository, retryPolicy });
    const before = Date.now();

    const outcome = await processor.process(message);

    expect(outcome).toEqual({ messageId: message.id, result: 'sent', applied: true });
    const stored = await findMessage(message.id);
    expect(stored).toMatchObject({
      status: 'sent',
      providerMessageId: `pm_sucesso_${message.id}`,
      attempts: 1,
      lockedAt: null,
      failureReason: null,
    });
    expect(stored.sentAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('SND-11: o provedor recebe o template renderizado e o telefone em E.164', async () => {
    const message = await claimOne({ template: 'Olá {{nome}}, pedido {{ pedido }}', variables: { nome: 'Ana', pedido: '1234' } });
    const { provider, sendMessage } = stubProvider(succeed);
    const processor = createMessageProcessor({ provider, repository, retryPolicy });

    await processor.process(message);

    expect(sendMessage).toHaveBeenCalledWith({ to: '+5511987654321', body: 'Olá Ana, pedido 1234' });
  });

  it('SND-12: erro definitivo grava failed com o motivo e não agenda nova tentativa', async () => {
    const message = await claimOne();
    const { provider } = stubProvider(failWith(new ProviderError('permanent', 'invalid_number')));
    const processor = createMessageProcessor({ provider, repository, retryPolicy });

    const outcome = await processor.process(message);

    expect(outcome).toEqual({ messageId: message.id, result: 'failed', applied: true });
    expect(await findMessage(message.id)).toMatchObject({
      status: 'failed',
      failureReason: 'invalid_number',
      lastError: null,
      attempts: 1,
      lockedAt: null,
      providerMessageId: null,
    });
  });

  it('SND-12: motivo maior que a coluna é cortado em 100 caracteres', async () => {
    const message = await claimOne();
    const { provider } = stubProvider(failWith(new ProviderError('permanent', 'x'.repeat(300))));
    const processor = createMessageProcessor({ provider, repository, retryPolicy });

    await processor.process(message);

    expect((await findMessage(message.id)).failureReason).toBe('x'.repeat(100));
  });

  it('SND-13: erro transitório antes do limite volta para pending com next_attempt_at no futuro', async () => {
    const message = await claimOne();
    const { provider } = stubProvider(failWith(new ProviderError('transient', 'provider_unavailable')));
    const processor = createMessageProcessor({ provider, repository, retryPolicy });
    const before = Date.now();

    const outcome = await processor.process(message);

    expect(outcome).toEqual({ messageId: message.id, result: 'retry', applied: true });
    const stored = await findMessage(message.id);
    expect(stored).toMatchObject({
      status: 'pending',
      lastError: 'provider_unavailable',
      failureReason: null,
      attempts: 1,
      lockedAt: null,
    });
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    expect(stored.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it('SND-14: erro transitório na última tentativa grava failed com max_attempts_exceeded', async () => {
    const message = await claimOne({ attempts: 4 });
    expect(message.attempts).toBe(5);
    const { provider } = stubProvider(failWith(new ProviderError('transient', 'provider_unavailable')));
    const processor = createMessageProcessor({ provider, repository, retryPolicy });

    const outcome = await processor.process(message);

    expect(outcome).toEqual({ messageId: message.id, result: 'failed', applied: true });
    expect(await findMessage(message.id)).toMatchObject({
      status: 'failed',
      failureReason: 'max_attempts_exceeded',
      lastError: 'provider_unavailable',
      attempts: 5,
    });
  });

  it.each([
    ['timeout', new ProviderError('transient', 'provider_timeout'), 'provider_timeout'],
    ['exceção que não é ProviderError', new Error('ECONNRESET'), 'ECONNRESET'],
    ['valor lançado que não é Error', 'boom', 'unknown_error'],
  ])('SND-15: %s é tratado como transitório', async (_case, error, lastError) => {
    const message = await claimOne();
    const { provider } = stubProvider(failWith(error));
    const processor = createMessageProcessor({ provider, repository, retryPolicy });

    const outcome = await processor.process(message);

    expect(outcome.result).toBe('retry');
    expect(await findMessage(message.id)).toMatchObject({ status: 'pending', lastError });
  });

  it('SND-16: falha com 503 duas vezes e depois aceita termina sent com attempts 3', async () => {
    const fastRetry = createRetryPolicy({ maxAttempts: 5, baseMs: 1, maxMs: 1, random: () => 1 });
    const { provider, sendMessage } = stubProvider(succeed);
    sendMessage
      .mockRejectedValueOnce(new ProviderError('transient', 'provider_unavailable'))
      .mockRejectedValueOnce(new ProviderError('transient', 'provider_unavailable'));
    const processor = createMessageProcessor({ provider, repository, retryPolicy: fastRetry });

    let message = await claimOne();
    const results: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      results.push((await processor.process(message)).result);
      if (round < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const claimed = await repository.claimBatch(1000);
        message = claimed.find((item) => item.id === message.id) as ClaimedMessage;
        expect(message).toBeDefined();
      }
    }

    expect(results).toEqual(['retry', 'retry', 'sent']);
    expect(await findMessage(message.id)).toMatchObject({ status: 'sent', attempts: 3, lastError: 'provider_unavailable' });
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('R11.3: não sobrescreve mensagem que já saiu de sending', async () => {
    const message = await claimOne();
    await db.update(messages).set({ status: 'failed', failureReason: 'max_attempts_exceeded' }).where(eq(messages.id, message.id));
    const { provider } = stubProvider(succeed);
    const processor = createMessageProcessor({ provider, repository, retryPolicy });

    const outcome = await processor.process(message);

    expect(outcome).toEqual({ messageId: message.id, result: 'sent', applied: false });
    expect(await findMessage(message.id)).toMatchObject({
      status: 'failed',
      failureReason: 'max_attempts_exceeded',
      providerMessageId: null,
    });
  });
});
