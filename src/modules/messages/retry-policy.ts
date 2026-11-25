export type RetryPolicyOptions = {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  random?: () => number;
};

export type RetryDecision = { retry: true; delayMs: number } | { retry: false };

export type RetryPolicy = {
  backoffMs(attempts: number): number;
  decide(attempts: number): RetryDecision;
};

const MIN_JITTER_FACTOR = 0.5;

export function createRetryPolicy(options: RetryPolicyOptions): RetryPolicy {
  const random = options.random ?? Math.random;

  function backoffMs(attempts: number): number {
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError(`attempts must be a positive integer, received ${attempts}`);
    }
    const exponential = Math.min(options.maxMs, options.baseMs * 2 ** (attempts - 1));
    const jitterFactor = MIN_JITTER_FACTOR + (1 - MIN_JITTER_FACTOR) * random();
    return Math.round(exponential * jitterFactor);
  }

  function decide(attempts: number): RetryDecision {
    if (attempts >= options.maxAttempts) {
      return { retry: false };
    }
    return { retry: true, delayMs: backoffMs(attempts) };
  }

  return { backoffMs, decide };
}
