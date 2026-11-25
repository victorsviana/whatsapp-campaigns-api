export type SendMessageInput = {
  to: string;
  body: string;
};

export type SendMessageResult = {
  providerMessageId: string;
};

export type ProviderErrorKind = 'permanent' | 'transient';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(reason, options);
    this.name = 'ProviderError';
  }
}

export interface MessagingProvider {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
}
