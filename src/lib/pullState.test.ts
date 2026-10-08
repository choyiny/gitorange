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
    expect(
      reasonText({
        kind: 'agent_flagged',
        agent: 'secagent',
        flags: [
          { id: 'f', title: 'Token' },
          { id: 'g', title: 'Logging' },
        ],
      })
    ).toBe('@secagent flagged 2 findings for a person');
    expect(reasonText({ kind: 'needs_approval' })).toBe(
      'no agent reviewed it: a person approves it'
    );
    expect(
      reasonText({
        kind: 'agent_changes_requested',
        agent: 'secagent',
        changes: [{ id: 'c', title: 'Rotate it', detail: null }],
      })
    ).toBe('@secagent requested 1 change');
    expect(reasonText({ kind: 'agent_reviewing', agent: null })).toBe(
      'agents are reviewing'
    );
    expect(
      reasonText({
        kind: 'agent_review_failed',
        agent: 'dataagent',
        error: 'x',
      })
    ).toBe("@dataagent's review failed");
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
    expect(reasonText({ kind: 'changes_requested' })).toBe(
      'changes requested on review flags'
    );
  });

  it('tells informational reasons apart', () => {
    expect(blocking({ kind: 'stacked_on', pr: 1 })).toBe(false);
    expect(blocking({ kind: 'must_account_for', pr: 1, landed: false })).toBe(
      true
    );
    expect(blocking({ kind: 'check_failed', run_number: 1, check: null })).toBe(
      true
    );
  });

  it('says rebase onto and rebase conflict', () => {
    expect(
      reasonText({
        kind: 'rebase_onto',
        pr: 28,
        branch: 'setup-checks',
        why: 'x',
      })
    ).toBe('GitOrange is rebasing it onto #28 (setup-checks)');
    expect(
      reasonText({
        kind: 'rebase_conflict',
        commit: 'abc1234def',
        files: ['x.ts', 'y.ts'],
        error: null,
      })
    ).toBe('commit abc1234 conflicts in x.ts, y.ts');
    expect(
      reasonText({
        kind: 'rebase_conflict',
        commit: null,
        files: [],
        error: 'Too many commits.',
      })
    ).toBe('Too many commits.');
  });
});
