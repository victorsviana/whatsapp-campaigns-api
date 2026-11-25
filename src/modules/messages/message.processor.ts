import { type MessagingProvider, ProviderError } from '../../integrations/messaging/messaging-provider';
import { renderTemplate } from '../campaigns/template';
import { type ClaimedMessage, MAX_ATTEMPTS_EXCEEDED, type MessagesRepository } from './messages.repository';
import type { RetryPolicy } from './retry-policy';

const FAILURE_REASON_MAX_LENGTH = 100;

export type ProcessResult = 'sent' | 'failed' | 'retry';

export type ProcessOutcome = {
  messageId: string;
  result: ProcessResult;
  applied: boolean;
};

export type MessageProcessorDependencies = {
  provider: MessagingProvider;
  repository: MessagesRepository;
  retryPolicy: RetryPolicy;
};

export type MessageProcessor = {
  process(message: ClaimedMessage): Promise<ProcessOutcome>;
};

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const reason = error instanceof Error && error.message !== '' ? error.message : 'unknown_error';
  return new ProviderError('transient', reason, { cause: error });
}

export function createMessageProcessor(dependencies: MessageProcessorDependencies): MessageProcessor {
  const { provider, repository, retryPolicy } = dependencies;

  async function handleFailure(message: ClaimedMessage, error: ProviderError): Promise<ProcessOutcome> {
    if (error.kind === 'permanent') {
      const failureReason = error.reason.slice(0, FAILURE_REASON_MAX_LENGTH);
      const applied = await repository.markFailed(message.id, failureReason);
      return { messageId: message.id, result: 'failed', applied };
    }

    const decision = retryPolicy.decide(message.attempts);
    if (decision.retry) {
      const applied = await repository.scheduleRetry(message.id, decision.delayMs, error.reason);
      return { messageId: message.id, result: 'retry', applied };
    }

    const applied = await repository.markFailed(message.id, MAX_ATTEMPTS_EXCEEDED, error.reason);
    return { messageId: message.id, result: 'failed', applied };
  }

  return {
    async process(message) {
      const body = renderTemplate(message.template, message.variables);

      let providerMessageId: string;
      try {
        ({ providerMessageId } = await provider.sendMessage({ to: message.phone, body }));
      } catch (error) {
        return handleFailure(message, asProviderError(error));
      }

      const applied = await repository.markSent(message.id, providerMessageId);
      return { messageId: message.id, result: 'sent', applied };
    },
  };
}
