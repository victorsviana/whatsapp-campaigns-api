import { sendMessage as fakeSendMessage } from './fakeProvider';
import {
  type MessagingProvider,
  ProviderError,
  type SendMessageInput,
  type SendMessageResult,
} from './messaging-provider';

type SendFunction = (input: SendMessageInput) => Promise<SendMessageResult>;

export type FakeProviderAdapterOptions = {
  timeoutMs: number;
  send?: SendFunction;
};

const TIMEOUT_REASON = 'provider_timeout';
const UNKNOWN_REASON = 'unknown_error';

function readStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return undefined;
}

function readReason(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : UNKNOWN_REASON;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const status = readStatus(error);
  const kind = status !== undefined && status >= 400 && status < 500 ? 'permanent' : 'transient';
  return new ProviderError(kind, readReason(error), { cause: error });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProviderError('transient', TIMEOUT_REASON)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createFakeProviderAdapter(options: FakeProviderAdapterOptions): MessagingProvider {
  const send: SendFunction = options.send ?? fakeSendMessage;

  return {
    async sendMessage(input) {
      try {
        return await withTimeout(send({ to: input.to, body: input.body }), options.timeoutMs);
      } catch (error) {
        throw toProviderError(error);
      }
    },
  };
}
