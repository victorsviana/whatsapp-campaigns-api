import { describe, expect, it, vi } from 'vitest';
import type { MessageProcessor, ProcessOutcome } from '../../../src/modules/messages/message.processor';
import type { ClaimedMessage } from '../../../src/modules/messages/messages.repository';
import { createDispatchWorker, type DispatchWorkerOptions } from '../../../src/workers/dispatch.worker';

function claimed(id: string): ClaimedMessage {
  return { id, campaignId: 'c1', phone: '+5511987654321', variables: {}, attempts: 1, template: 'Oi' };
}

function sent(message: ClaimedMessage): ProcessOutcome {
  return { messageId: message.id, result: 'sent', applied: true };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condição não atingida a tempo');
    }
    await wait(5);
  }
}

function setup(overrides: Partial<DispatchWorkerOptions> = {}) {
  const repository = {
    recoverStuck: vi.fn(async () => 0),
    claimBatch: vi.fn(async (): Promise<ClaimedMessage[]> => []),
  };
  const processor = { process: vi.fn(async (message: ClaimedMessage) => sent(message)) } satisfies MessageProcessor;
  const logger = { info: vi.fn(), error: vi.fn() };
  const worker = createDispatchWorker({
    repository,
    processor,
    logger,
    batchSize: 50,
    concurrency: 10,
    pollIntervalMs: 10,
    sendingTimeoutMs: 60_000,
    maxAttempts: 5,
    ...overrides,
  });
  return { worker, repository, processor, logger };
}

describe('dispatchWorker.runOnce', () => {
  it('R12/R6: recupera as presas antes de reservar o lote e processa tudo que reservou', async () => {
    const { worker, repository, processor } = setup({ batchSize: 3, sendingTimeoutMs: 1234, maxAttempts: 7 });
    const order: string[] = [];
    repository.recoverStuck.mockImplementation(async () => {
      order.push('recover');
      return 0;
    });
    repository.claimBatch.mockImplementation(async () => {
      order.push('claim');
      return [claimed('m1'), claimed('m2'), claimed('m3')];
    });

    const count = await worker.runOnce();

    expect(count).toBe(3);
    expect(order).toEqual(['recover', 'claim']);
    expect(repository.recoverStuck).toHaveBeenCalledWith(1234, 7);
    expect(repository.claimBatch).toHaveBeenCalledWith(3);
    expect(processor.process.mock.calls.map(([message]) => message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('R9: nunca passa de WORKER_CONCURRENCY chamadas ao mesmo tempo', async () => {
    const { worker, repository, processor } = setup({ concurrency: 3 });
    repository.claimBatch.mockResolvedValue(Array.from({ length: 8 }, (_, index) => claimed(`m${index}`)));
    let inFlight = 0;
    let peak = 0;
    processor.process.mockImplementation(async (message) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(5);
      inFlight -= 1;
      return sent(message);
    });

    await worker.runOnce();

    expect(processor.process).toHaveBeenCalledTimes(8);
    expect(peak).toBe(3);
  });

  it('uma mensagem que lança erro não impede as outras do lote', async () => {
    const { worker, repository, processor, logger } = setup({ concurrency: 1 });
    repository.claimBatch.mockResolvedValue([claimed('m1'), claimed('m2'), claimed('m3')]);
    processor.process.mockImplementation(async (message) => {
      if (message.id === 'm2') {
        throw new Error('db down');
      }
      return sent(message);
    });

    await expect(worker.runOnce()).resolves.toBe(3);

    expect(processor.process).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchWorker.start/stop', () => {
  it('dorme quando não há trabalho em vez de girar sem parar', async () => {
    const { worker, repository } = setup({ pollIntervalMs: 50 });

    const loop = worker.start();
    await wait(130);
    await worker.stop();
    await loop;

    expect(repository.claimBatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(repository.claimBatch.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('volta a reservar logo em seguida quando o lote veio com mensagens', async () => {
    const { worker, repository } = setup({ pollIntervalMs: 10_000 });
    repository.claimBatch.mockResolvedValueOnce([claimed('m1')]).mockResolvedValueOnce([claimed('m2')]);

    const loop = worker.start();
    await waitUntil(() => repository.claimBatch.mock.calls.length >= 3);
    await worker.stop();
    await loop;
  });

  it('erro no ciclo é registrado e o loop continua', async () => {
    const { worker, repository, logger } = setup();
    repository.claimBatch.mockRejectedValueOnce(new Error('connection refused'));

    const loop = worker.start();
    await waitUntil(() => repository.claimBatch.mock.calls.length >= 2);
    await worker.stop();
    await loop;

    expect(logger.error).toHaveBeenCalled();
  });

  it('SND-24: ao parar, não reserva mais nada, espera as chamadas em andamento e só então termina', async () => {
    const { worker, repository, processor } = setup({ pollIntervalMs: 10_000 });
    const inFlight = deferred();
    repository.claimBatch.mockResolvedValueOnce([claimed('m1')]);
    processor.process.mockImplementation(async (message) => {
      await inFlight.promise;
      return sent(message);
    });

    const loop = worker.start();
    await waitUntil(() => processor.process.mock.calls.length === 1);

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await wait(30);
    expect(stopped).toBe(false);

    inFlight.resolve();
    await stopping;
    await loop;

    expect(stopped).toBe(true);
    expect(processor.process).toHaveReturnedTimes(1);
    expect(repository.claimBatch).toHaveBeenCalledTimes(1);
  });

  it('SND-24: stop acorda o worker que estava dormindo, sem esperar o intervalo inteiro', async () => {
    const { worker, repository } = setup({ pollIntervalMs: 10_000 });

    const loop = worker.start();
    await waitUntil(() => repository.claimBatch.mock.calls.length === 1);
    const startedAt = Date.now();
    await worker.stop();
    await loop;

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(repository.claimBatch).toHaveBeenCalledTimes(1);
  });

  it('stop pode ser chamado mais de uma vez', async () => {
    const { worker } = setup();

    const loop = worker.start();
    await Promise.all([worker.stop(), worker.stop()]);
    await loop;
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
