import { describe, expect, it } from 'vitest';
import {
  buildMessagesSummary,
  type FailureReasonCount,
  type StatusCount,
} from '../../../src/modules/campaigns/campaign-report';

function statusCount(overrides: Partial<StatusCount> & Pick<StatusCount, 'status' | 'total'>): StatusCount {
  return { withProviderId: 0, retrying: 0, ...overrides };
}

describe('buildMessagesSummary', () => {
  it('RPT-02: sem mensagens, todos os contadores zerados e todos os estados presentes', () => {
    expect(buildMessagesSummary([], [])).toEqual({
      by_status: { pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
      funnel: { sent: 0, delivered: 0, read: 0, failed: 0 },
      retrying: 0,
      failures_by_reason: {},
    });
  });

  it('RPT-03: as 10 mensagens do exemplo da spec', () => {
    const summary = buildMessagesSummary(
      [
        statusCount({ status: 'pending', total: 2 }),
        statusCount({ status: 'sent', total: 3, withProviderId: 3 }),
        statusCount({ status: 'delivered', total: 3, withProviderId: 3 }),
        statusCount({ status: 'read', total: 1, withProviderId: 1 }),
        statusCount({ status: 'failed', total: 1 }),
      ],
      [{ reason: 'invalid_number', total: 1 }],
    );

    expect(summary.by_status).toEqual({ pending: 2, sending: 0, sent: 3, delivered: 3, read: 1, failed: 1 });
    expect(summary.funnel).toEqual({ sent: 7, delivered: 4, read: 1, failed: 1 });
  });

  it('RPT-04: falha via webhook conta em funnel.sent e em funnel.failed', () => {
    const summary = buildMessagesSummary([statusCount({ status: 'failed', total: 1, withProviderId: 1 })], []);

    expect(summary.funnel).toEqual({ sent: 1, delivered: 0, read: 0, failed: 1 });
  });

  it('RPT-05: falha que nunca foi aceita conta em funnel.failed e não em funnel.sent', () => {
    const summary = buildMessagesSummary([statusCount({ status: 'failed', total: 1, withProviderId: 0 })], []);

    expect(summary.funnel).toEqual({ sent: 0, delivered: 0, read: 0, failed: 1 });
  });

  it('RPT-06: retrying conta só as pending que já tiveram tentativa', () => {
    const summary = buildMessagesSummary(
      [statusCount({ status: 'pending', total: 2, retrying: 1 }), statusCount({ status: 'sending', total: 3, retrying: 3 })],
      [],
    );

    expect(summary.retrying).toBe(1);
  });

  it('RPT-07: failures_by_reason com só os motivos que ocorreram', () => {
    const failures: FailureReasonCount[] = [
      { reason: 'invalid_number', total: 2 },
      { reason: 'max_attempts_exceeded', total: 1 },
    ];

    expect(buildMessagesSummary([], failures).failures_by_reason).toEqual({
      invalid_number: 2,
      max_attempts_exceeded: 1,
    });
  });
});
