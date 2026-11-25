import { describe, expect, it, vi } from 'vitest';
import { createFakeProviderAdapter } from '../../../src/integrations/messaging/fake-provider.adapter';
import { ProviderError } from '../../../src/integrations/messaging/messaging-provider';

function providerError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function captureError(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

const input = { to: '+5511987654321', body: 'Olá Ana' };

describe('createFakeProviderAdapter', () => {
  it('SND-11: repassa to e body e devolve o providerMessageId', async () => {
    const send = vi.fn().mockResolvedValue({ providerMessageId: 'pm_123' });
    const provider = createFakeProviderAdapter({ timeoutMs: 1000, send });

    await expect(provider.sendMessage(input)).resolves.toEqual({ providerMessageId: 'pm_123' });
    expect(send).toHaveBeenCalledWith({ to: '+5511987654321', body: 'Olá Ana' });
  });

  it.each([
    [400, 'invalid_number'],
    [404, 'not_found'],
    [499, 'client_closed'],
  ])('SND-19: erro %i é definitivo com o motivo do provedor', async (status, message) => {
    const send = vi.fn().mockRejectedValue(providerError(status, message));
    const provider = createFakeProviderAdapter({ timeoutMs: 1000, send });

    const error = await captureError(provider.sendMessage(input));

    expect(error.kind).toBe('permanent');
    expect(error.reason).toBe(message);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it.each([
    [500, 'internal_error'],
    [503, 'provider_unavailable'],
  ])('SND-19: erro %i é transitório com o motivo do provedor', async (status, message) => {
    const send = vi.fn().mockRejectedValue(providerError(status, message));
    const provider = createFakeProviderAdapter({ timeoutMs: 1000, send });

    const error = await captureError(provider.sendMessage(input));

    expect(error.kind).toBe('transient');
    expect(error.reason).toBe(message);
  });

  it('SND-15: erro sem status é transitório', async () => {
    const send = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const provider = createFakeProviderAdapter({ timeoutMs: 1000, send });

    const error = await captureError(provider.sendMessage(input));

    expect(error.kind).toBe('transient');
    expect(error.reason).toBe('socket hang up');
  });

  it('SND-15: valor lançado que não é Error é transitório com motivo genérico', async () => {
    const send = vi.fn().mockRejectedValue('falhou');
    const provider = createFakeProviderAdapter({ timeoutMs: 1000, send });

    const error = await captureError(provider.sendMessage(input));

    expect(error.kind).toBe('transient');
    expect(error.reason).toBe('unknown_error');
  });

  it('status fora de 4xx e 5xx é transitório', async () => {
    const send = vi.fn().mockRejectedValue(providerError(302, 'redirect'));
    const provider = createFakeProviderAdapter({ timeoutMs: 1000, send });

    const error = await captureError(provider.sendMessage(input));

    expect(error.kind).toBe('transient');
  });

  it('SND-15: chamada que passa do timeout é transitória com motivo provider_timeout', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => new Promise<never>(() => {}));
      const provider = createFakeProviderAdapter({ timeoutMs: 10_000, send });

      const result = captureError(provider.sendMessage(input));
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await result;

      expect(error.kind).toBe('transient');
      expect(error.reason).toBe('provider_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('não deixa o timer pendurado quando o provedor responde a tempo', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn().mockResolvedValue({ providerMessageId: 'pm_1' });
      const provider = createFakeProviderAdapter({ timeoutMs: 10_000, send });

      await provider.sendMessage(input);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('com o fakeProvider.js de verdade', () => {
    const provider = createFakeProviderAdapter({ timeoutMs: 5000 });

    it('SND-12: telefone terminado em 0000 é definitivo com invalid_number', async () => {
      const error = await captureError(provider.sendMessage({ to: '+5511987650000', body: 'Oi' }));

      expect(error.kind).toBe('permanent');
      expect(error.reason).toBe('invalid_number');
    });

    it('body vazio é definitivo com invalid_payload', async () => {
      const error = await captureError(provider.sendMessage({ to: '+5511987654321', body: '' }));

      expect(error.kind).toBe('permanent');
      expect(error.reason).toBe('invalid_payload');
    });
  });
});
