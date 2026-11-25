import type { MessageProcessor } from '../modules/messages/message.processor';
import type { ClaimedMessage, MessagesRepository } from '../modules/messages/messages.repository';

export type WorkerLogger = Pick<Console, 'info' | 'error'>;

export type DispatchWorkerOptions = {
  repository: Pick<MessagesRepository, 'recoverStuck' | 'claimBatch'>;
  processor: MessageProcessor;
  batchSize: number;
  concurrency: number;
  pollIntervalMs: number;
  sendingTimeoutMs: number;
  maxAttempts: number;
  logger?: WorkerLogger;
};

export type DispatchWorker = {
  runOnce(): Promise<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  }

  const lanes = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: lanes }, lane));
}

export function createDispatchWorker(options: DispatchWorkerOptions): DispatchWorker {
  const { repository, processor, logger = console } = options;

  let stopping = false;
  let loop: Promise<void> | undefined;
  let wakeUp: (() => void) | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wakeUp = undefined;
        resolve();
      }
      wakeUp = done;
    });
  }

  async function processSafely(message: ClaimedMessage): Promise<void> {
    try {
      await processor.process(message);
    } catch (error) {
      logger.error(`Falha ao processar a mensagem ${message.id}`, error);
    }
  }

  async function runOnce(): Promise<number> {
    const recovered = await repository.recoverStuck(options.sendingTimeoutMs, options.maxAttempts);
    if (recovered > 0) {
      logger.info(`${recovered} mensagem(ns) presa(s) em sending recuperada(s)`);
    }
    if (stopping) {
      return 0;
    }

    const batch = await repository.claimBatch(options.batchSize);
    await runWithConcurrency(batch, options.concurrency, processSafely);
    return batch.length;
  }

  async function run(): Promise<void> {
    while (!stopping) {
      let claimed = 0;
      try {
        claimed = await runOnce();
      } catch (error) {
        logger.error('Erro no ciclo do worker de envio', error);
      }
      if (claimed === 0 && !stopping) {
        await sleep(options.pollIntervalMs);
      }
    }
  }

  return {
    runOnce,

    start() {
      loop ??= run();
      return loop;
    },

    async stop() {
      stopping = true;
      wakeUp?.();
      await loop;
    },
  };
}
