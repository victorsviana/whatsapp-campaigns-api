import { MESSAGE_STATUSES, type MessageStatus } from '../../database/schema';

export type StatusCount = {
  status: MessageStatus;
  total: number;
  withProviderId: number;
  retrying: number;
};

export type FailureReasonCount = {
  reason: string | null;
  total: number;
};

export type MessagesSummary = {
  by_status: Record<MessageStatus, number>;
  funnel: { sent: number; delivered: number; read: number; failed: number };
  retrying: number;
  failures_by_reason: Record<string, number>;
};

const UNKNOWN_REASON = 'unknown';

export function buildMessagesSummary(statusCounts: StatusCount[], failureCounts: FailureReasonCount[]): MessagesSummary {
  const byStatus = Object.fromEntries(MESSAGE_STATUSES.map((status) => [status, 0])) as Record<MessageStatus, number>;
  let sent = 0;
  let retrying = 0;

  for (const row of statusCounts) {
    byStatus[row.status] += row.total;
    sent += row.withProviderId;
    if (row.status === 'pending') {
      retrying += row.retrying;
    }
  }

  const failuresByReason: Record<string, number> = {};
  for (const row of failureCounts) {
    const reason = row.reason ?? UNKNOWN_REASON;
    failuresByReason[reason] = (failuresByReason[reason] ?? 0) + row.total;
  }

  return {
    by_status: byStatus,
    funnel: {
      sent,
      delivered: byStatus.delivered + byStatus.read,
      read: byStatus.read,
      failed: byStatus.failed,
    },
    retrying,
    failures_by_reason: failuresByReason,
  };
}
