import { describe, expect, it } from 'vitest';
import type { MessageStatus, ProviderEventStatus } from '../../../src/database/schema';
import { canTransition, statusesThatCanBecome } from '../../../src/modules/messages/message-status';

describe('canTransition', () => {
  it.each<[string, MessageStatus, ProviderEventStatus, boolean]>([
    ['WHK-03', 'sent', 'delivered', true],
    ['WHK-05', 'sent', 'read', true],
    ['WHK-07', 'sent', 'failed', true],
    ['WHK-10', 'delivered', 'delivered', false],
    ['WHK-04', 'delivered', 'read', true],
    ['WHK-08', 'delivered', 'failed', false],
    ['WHK-06', 'read', 'delivered', false],
    ['R6', 'read', 'read', false],
    ['R6', 'read', 'failed', false],
    ['WHK-09', 'failed', 'delivered', false],
    ['WHK-09', 'failed', 'read', false],
    ['R6', 'failed', 'failed', false],
  ])('%s: de %s com evento %s → %s', (_id, current, event, expected) => {
    expect(canTransition(current, event)).toBe(expected);
  });

  it.each<[MessageStatus, ProviderEventStatus]>([
    ['pending', 'delivered'],
    ['pending', 'read'],
    ['pending', 'failed'],
    ['sending', 'delivered'],
    ['sending', 'read'],
    ['sending', 'failed'],
  ])('R9: mensagem ainda não enviada (%s) não aceita evento %s', (current, event) => {
    expect(canTransition(current, event)).toBe(false);
  });
});

describe('statusesThatCanBecome', () => {
  it.each<[ProviderEventStatus, MessageStatus[]]>([
    ['delivered', ['sent']],
    ['read', ['sent', 'delivered']],
    ['failed', ['sent']],
  ])('R7: evento %s só se aplica a mensagens em %j', (event, expected) => {
    expect(statusesThatCanBecome(event)).toEqual(expected);
  });
});
