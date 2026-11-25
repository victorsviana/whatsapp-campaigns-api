import { describe, expect, it } from 'vitest';
import { createRetryPolicy } from '../../../src/modules/messages/retry-policy';

const defaults = { maxAttempts: 5, baseMs: 1000, maxMs: 60_000 };

describe('backoffMs', () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [7, 60_000],
    [10, 60_000],
  ])('SND-17: com jitter desligado, attempts %i espera %i ms', (attempts, expected) => {
    const policy = createRetryPolicy({ ...defaults, random: () => 1 });

    expect(policy.backoffMs(attempts)).toBe(expected);
  });

  it('SND-17: não estoura com attempts muito alto', () => {
    const policy = createRetryPolicy({ ...defaults, random: () => 1 });

    expect(policy.backoffMs(5000)).toBe(60_000);
  });

  it.each([
    [0, 2000],
    [0.5, 3000],
    [0.999, 3998],
  ])('SND-18: com random %f, attempts 3 espera %i ms', (random, expected) => {
    const policy = createRetryPolicy({ ...defaults, random: () => random });

    expect(policy.backoffMs(3)).toBe(expected);
  });

  it('SND-18: com Math.random, attempts 3 fica entre 2000 e 4000 ms', () => {
    const policy = createRetryPolicy(defaults);

    for (let i = 0; i < 1000; i += 1) {
      const delay = policy.backoffMs(3);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  it('recusa attempts menor que 1', () => {
    const policy = createRetryPolicy(defaults);

    expect(() => policy.backoffMs(0)).toThrow(RangeError);
  });
});

describe('decide', () => {
  const policy = createRetryPolicy({ ...defaults, random: () => 1 });

  it.each([
    [1, 1000],
    [4, 8000],
  ])('R11.1: attempts %i de 5 tenta de novo em %i ms', (attempts, delayMs) => {
    expect(policy.decide(attempts)).toEqual({ retry: true, delayMs });
  });

  it.each([5, 6])('R11.1: attempts %i de 5 desiste', (attempts) => {
    expect(policy.decide(attempts)).toEqual({ retry: false });
  });

  it('R11.1: com maxAttempts 1 não há nova tentativa', () => {
    const singleAttempt = createRetryPolicy({ ...defaults, maxAttempts: 1 });

    expect(singleAttempt.decide(1)).toEqual({ retry: false });
  });
});
