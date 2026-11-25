import { MESSAGE_STATUSES, type MessageStatus, type ProviderEventStatus } from '../../database/schema';

const DELIVERY_RANK: Partial<Record<MessageStatus, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

export function canTransition(current: MessageStatus, event: ProviderEventStatus): boolean {
  if (event === 'failed') {
    return current === 'sent';
  }
  const currentRank = DELIVERY_RANK[current];
  const eventRank = DELIVERY_RANK[event];
  return currentRank !== undefined && eventRank !== undefined && eventRank > currentRank;
}

export function statusesThatCanBecome(event: ProviderEventStatus): MessageStatus[] {
  return MESSAGE_STATUSES.filter((current) => canTransition(current, event));
}
