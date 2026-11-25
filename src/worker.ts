import { closeDatabase, db } from './database/client';
import { createFakeProviderAdapter } from './integrations/messaging/fake-provider.adapter';
import { createCampaignsRepository } from './modules/campaigns/campaigns.repository';
import { createMessageProcessor } from './modules/messages/message.processor';
import { createMessagesRepository } from './modules/messages/messages.repository';
import { createRetryPolicy } from './modules/messages/retry-policy';
import { env } from './shared/config/env';
import { createDispatchWorker } from './workers/dispatch.worker';

const repository = createMessagesRepository(db);

const processor = createMessageProcessor({
  provider: createFakeProviderAdapter({ timeoutMs: env.PROVIDER_TIMEOUT_MS }),
  repository,
  retryPolicy: createRetryPolicy({
    maxAttempts: env.MAX_ATTEMPTS,
    baseMs: env.RETRY_BASE_MS,
    maxMs: env.RETRY_MAX_MS,
  }),
});

const worker = createDispatchWorker({
  repository,
  campaignsRepository: createCampaignsRepository(db),
  processor,
  batchSize: env.WORKER_BATCH_SIZE,
  concurrency: env.WORKER_CONCURRENCY,
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  sendingTimeoutMs: env.SENDING_TIMEOUT_MS,
  maxAttempts: env.MAX_ATTEMPTS,
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} recebido, terminando os envios em andamento`);
  try {
    await worker.stop();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(
  `Worker de envio iniciado (lote ${env.WORKER_BATCH_SIZE}, concorrência ${env.WORKER_CONCURRENCY})`,
);

worker.start().catch(async (error: unknown) => {
  console.error('Worker de envio encerrado por erro inesperado', error);
  await closeDatabase();
  process.exit(1);
});
