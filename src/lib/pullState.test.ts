import { describe, expect, it } from 'vitest';
import { blocking, reasonText, STATE_LABEL } from './pullState';

describe('pull state text', () => {
  it('names each state as the spec does', () => {
    expect(STATE_LABEL).toEqual({
      agent_followup: 'Ready for agent followup',
      human_review: 'Requires human review',
      waiting: 'Waiting for checks',
      ready: 'Ready',
    });
  });

  it('says each reason in a few words', () => {
    expect(
      reasonText({ kind: 'check_failed', run_number: 7, check: 'test' })
    ).toBe('the "test" check failed (run #7)');
    expect(reasonText({ kind: 'flags_pending', count: 2 })).toBe(
      '2 review flags await approval'
    );
    expect(
      reasonText({ kind: 'must_account_for', pr: 28, landed: false })
    ).toBe('must account for #28');
    expect(reasonText({ kind: 'stacked_on', pr: 28 })).toBe('stacked on #28');
    expect(reasonText({ kind: 'something_new' })).toBe('something new');
  });

  it('omits a missing number instead of printing NaN', () => {
    expect(reasonText({ kind: 'check_failed', check: null })).toBe(
      'a check failed'
    );
    expect(reasonText({ kind: 'flags_pending' })).toBe(
      'review flags await approval'
    );
    expect(reasonText({ kind: 'changes_requested' })).toBe(
      'changes requested on review flags'
    );
  });

  it('tells informational reasons apart', () => {
    expect(blocking({ kind: 'stacked_on', pr: 1 })).toBe(false);
    expect(blocking({ kind: 'must_account_for', pr: 1, landed: false })).toBe(
      false
    );
    expect(blocking({ kind: 'check_failed', run_number: 1, check: null })).toBe(
      true
    );
  });
});
