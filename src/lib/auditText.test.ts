import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './uiApi';
import {
  AUDIT_ACTIONS,
  actorName,
  agentLabel,
  auditCategory,
  auditDetail,
  auditLink,
  auditParts,
  auditText,
} from './auditText';

const person = {
  kind: 'person',
  login: 'mahmoud',
  name: 'Mahmoud H.',
} as const;

/** An event with sensible defaults, so each test says only what it is about. */
const ev = (over: Partial<AuditEvent>): AuditEvent => ({
  id: 'e1',
  at: Date.UTC(2026, 9, 8, 12, 0, 0),
  actor: person,
  via: null,
  action: 'merging.paused',
  target: '',
  data: {},
  repo: 'choyiny/gitorange',
  pull: null,
  ...over,
});

describe('the sentences in the brief', () => {
  it('mahmoud paused merging on choyiny/gitorange', () => {
    expect(auditText(ev({ action: 'merging.paused' }))).toBe(
      'mahmoud paused merging on choyiny/gitorange'
    );
  });

  it("GitOrange AI approved Speed's finding on #74 for cho", () => {
    expect(
      auditText(
        ev({
          actor: { kind: 'ai', login: 'cho', name: 'Cho' },
          via: 'GitOrange AI',
          action: 'finding.delegated',
          target: 'Token is logged',
          pull: 74,
          data: {
            finding: 'f1',
            kind: 'needs_person',
            agent: 'speedagent',
            decision: 'approve',
            reason: 'It only logs the first four characters.',
          },
        }),
        { scope: 'repo' }
      )
    ).toBe("GitOrange AI approved Speed's finding on #74 for cho");
  });

  it('System deleted branch stack-tree after #47 merged', () => {
    expect(
      auditText(
        ev({
          actor: { kind: 'system', login: null, name: null },
          action: 'branch.deleted',
          target: 'stack-tree',
          pull: 47,
          data: { sha: 'abc1234', merged: true },
        }),
        { scope: 'repo' }
      )
    ).toBe('System deleted branch stack-tree after #47 merged');
  });
});

describe('who did it', () => {
  it('names a person by username, falling back to their name', () => {
    expect(actorName({ kind: 'person', login: 'cho', name: 'Cho' })).toBe(
      'cho'
    );
    expect(actorName({ kind: 'person', login: null, name: 'Cho Yin' })).toBe(
      'Cho Yin'
    );
    expect(actorName({ kind: 'person', login: null, name: null })).toBe(
      'A former member'
    );
  });

  it('names GitOrange AI, the system and an agent', () => {
    expect(actorName({ kind: 'ai', login: 'cho', name: null })).toBe(
      'GitOrange AI'
    );
    expect(actorName({ kind: 'system', login: null, name: null })).toBe(
      'System'
    );
    expect(
      actorName({ kind: 'agent', login: 'securityagent', name: null })
    ).toBe('Security');
  });

  it('uses the real agent names when the page knows them', () => {
    expect(
      actorName(
        { kind: 'agent', login: 'a11y', name: null },
        { a11y: 'Accessibility' }
      )
    ).toBe('Accessibility');
  });

  it('turns a handle into the name people use', () => {
    expect(agentLabel('speedagent')).toBe('Speed');
    expect(agentLabel('dataagent')).toBe('Data');
    expect(agentLabel('reviewer')).toBe('reviewer');
    expect(agentLabel('speedagent', { speedagent: 'Speedy' })).toBe('Speedy');
  });
});

describe('repository and instance views', () => {
  const merged = ev({
    action: 'pull.merged',
    target: '#12',
    pull: 12,
    data: {
      title: 'Fix the queue',
      sha: 'abc',
      into: 'main',
      automatic: false,
    },
  });

  it('keeps the repository out of its own log', () => {
    expect(auditText(merged, { scope: 'repo' })).toBe(
      'mahmoud merged #12 “Fix the queue” into main'
    );
  });

  it('names the repository in the instance-wide log', () => {
    expect(auditText(merged)).toBe(
      'mahmoud merged choyiny/gitorange#12 “Fix the queue” into main'
    );
  });

  it('links the repository and the pull request', () => {
    const parts = auditParts(merged);
    expect(parts.find((p) => p.kind === 'pull')).toEqual({
      kind: 'pull',
      text: 'choyiny/gitorange#12',
      to: '/choyiny/gitorange/pull/12',
    });
    expect(parts[0]).toEqual({ kind: 'who', text: 'mahmoud' });
    const paused = auditParts(ev({ action: 'merging.paused' }));
    expect(paused.find((p) => p.kind === 'repo')).toEqual({
      kind: 'repo',
      text: 'choyiny/gitorange',
      to: '/choyiny/gitorange',
    });
  });

  it('leaves an instance event without a repository alone', () => {
    expect(
      auditText(
        ev({
          action: 'token.created',
          repo: null,
          target: 'laptop',
          data: { token: 't1', expiresAt: null },
        })
      )
    ).toBe('mahmoud created the access token “laptop”');
  });

  it('shows how a person reached the change', () => {
    expect(
      auditText(ev({ action: 'merging.resumed', via: 'Claude Code' }))
    ).toBe('mahmoud resumed merging on choyiny/gitorange via Claude Code');
  });
});

describe('every audit action reads as one sentence', () => {
  const cases: [string, Partial<AuditEvent>, string][] = [
    [
      'settings.changed',
      {
        action: 'settings.changed',
        target: 'choyiny/gitorange',
        data: {
          changes: {
            defaultBranch: { from: 'main', to: 'trunk' },
            description: { from: 'a', to: 'b' },
          },
        },
      },
      'mahmoud changed the default branch and the description on choyiny/gitorange',
    ],
    [
      'settings.changed with no known keys',
      { action: 'settings.changed', data: {} },
      'mahmoud changed settings on choyiny/gitorange',
    ],
    [
      'collaborator.added',
      { action: 'collaborator.added', target: 'cho' },
      'mahmoud added cho as a collaborator on choyiny/gitorange',
    ],
    [
      'collaborator.removed',
      { action: 'collaborator.removed', target: 'cho' },
      'mahmoud removed cho as a collaborator on choyiny/gitorange',
    ],
    [
      'agent.invited',
      { action: 'agent.invited', target: 'speedagent' },
      'mahmoud invited Speed to review choyiny/gitorange',
    ],
    [
      'agent.removed',
      { action: 'agent.removed', target: 'speedagent' },
      'mahmoud removed Speed as a reviewer on choyiny/gitorange',
    ],
    [
      'agent.created',
      {
        action: 'agent.created',
        repo: null,
        target: 'securityagent',
        data: { name: 'Security', preset: 'security' },
      },
      'mahmoud created the reviewer Security',
    ],
    [
      'agent.deleted',
      { action: 'agent.deleted', repo: null, target: 'securityagent' },
      'mahmoud deleted the reviewer Security',
    ],
    [
      'branch.deleted by a person',
      { action: 'branch.deleted', target: 'old-idea', data: { sha: 'abc' } },
      'mahmoud deleted branch old-idea in choyiny/gitorange',
    ],
    [
      'branches.cleaned',
      {
        action: 'branches.cleaned',
        target: '3 branches',
        data: { branches: ['a', 'b', 'c'], shas: {} },
      },
      'mahmoud cleaned up 3 merged branches in choyiny/gitorange',
    ],
    [
      'merging.paused',
      { action: 'merging.paused' },
      'mahmoud paused merging on choyiny/gitorange',
    ],
    [
      'merging.resumed',
      { action: 'merging.resumed' },
      'mahmoud resumed merging on choyiny/gitorange',
    ],
    [
      'pull.merged',
      {
        action: 'pull.merged',
        target: '#12',
        pull: 12,
        data: { title: 'Fix it', into: 'main', automatic: false },
      },
      'mahmoud merged choyiny/gitorange#12 “Fix it” into main',
    ],
    [
      'pull.merged automatically',
      {
        actor: { kind: 'system', login: null, name: null },
        action: 'pull.merged',
        target: '#12',
        pull: 12,
        data: { title: 'Fix it', into: 'main', automatic: true },
      },
      'System merged choyiny/gitorange#12 “Fix it” into main',
    ],
    [
      'pull.reverted',
      { action: 'pull.reverted', target: '#12', pull: 12 },
      'mahmoud reverted choyiny/gitorange#12',
    ],
    [
      'pull.reverted with its new pull request',
      {
        action: 'pull.reverted',
        target: '#12',
        pull: 12,
        data: { revert: 13 },
      },
      'mahmoud reverted choyiny/gitorange#12 with choyiny/gitorange#13',
    ],
    [
      'pull.approved',
      { action: 'pull.approved', target: '#12', pull: 12 },
      'mahmoud approved choyiny/gitorange#12',
    ],
    [
      'finding.approved',
      {
        action: 'finding.approved',
        target: 'Token is logged',
        pull: 74,
        data: { finding: 'f', kind: 'needs_person', agent: 'securityagent' },
      },
      "mahmoud approved Security's finding on choyiny/gitorange#74",
    ],
    [
      'finding.approved on a change request is a dismissal',
      {
        action: 'finding.approved',
        target: 'Slow query',
        pull: 74,
        data: { finding: 'f', kind: 'change_requested', agent: 'speedagent' },
      },
      "mahmoud dismissed Speed's change request on choyiny/gitorange#74",
    ],
    [
      'finding.changes_requested',
      {
        action: 'finding.changes_requested',
        target: 'Slow query',
        pull: 74,
        data: { finding: 'f', kind: 'needs_person', agent: 'speedagent' },
      },
      "mahmoud asked for changes on Speed's finding on choyiny/gitorange#74",
    ],
    [
      'finding.assigned',
      {
        action: 'finding.assigned',
        target: 'Slow query',
        pull: 74,
        data: { finding: 'f', agent: 'speedagent', assignee: 'cho' },
      },
      "mahmoud assigned Speed's finding on choyiny/gitorange#74 to cho",
    ],
    [
      'finding.assigned cleared',
      {
        action: 'finding.assigned',
        target: 'Slow query',
        pull: 74,
        data: { finding: 'f', agent: 'speedagent', assignee: null },
      },
      "mahmoud unassigned Speed's finding on choyiny/gitorange#74",
    ],
    [
      'finding.delegated: approve',
      {
        actor: { kind: 'ai', login: 'cho', name: null },
        via: 'GitOrange AI',
        action: 'finding.delegated',
        pull: 74,
        data: {
          agent: 'speedagent',
          kind: 'needs_person',
          decision: 'approve',
        },
      },
      "GitOrange AI approved Speed's finding on choyiny/gitorange#74 for cho",
    ],
    [
      'finding.delegated: request changes',
      {
        actor: { kind: 'ai', login: 'cho', name: null },
        via: 'GitOrange AI',
        action: 'finding.delegated',
        pull: 74,
        data: {
          agent: 'speedagent',
          kind: 'needs_person',
          decision: 'request_changes',
        },
      },
      "GitOrange AI asked for changes on Speed's finding on choyiny/gitorange#74 for cho",
    ],
    [
      'finding.delegated: leave',
      {
        actor: { kind: 'ai', login: 'cho', name: null },
        via: 'GitOrange AI',
        action: 'finding.delegated',
        pull: 74,
        data: { agent: 'speedagent', decision: 'leave', reason: 'Unsure.' },
      },
      "GitOrange AI left Speed's finding on choyiny/gitorange#74 for cho to decide",
    ],
    [
      'finding.undone: an AI decision',
      {
        action: 'finding.undone',
        pull: 74,
        data: {
          agent: 'speedagent',
          undid: 'approved',
          via: 'GitOrange AI',
        },
      },
      "mahmoud undid GitOrange AI's decision on Speed's finding on choyiny/gitorange#74",
    ],
    [
      'finding.undone: their own decision',
      {
        action: 'finding.undone',
        pull: 74,
        data: { agent: 'speedagent', undid: 'changes_requested', via: null },
      },
      "mahmoud reopened Speed's finding on choyiny/gitorange#74",
    ],
    [
      'finding.taught',
      {
        action: 'finding.taught',
        pull: 74,
        data: { agent: 'speedagent', teach: 'Never flag test files.' },
      },
      'mahmoud taught Speed a rule from its finding on choyiny/gitorange#74',
    ],
    [
      'token.created',
      {
        action: 'token.created',
        repo: null,
        target: 'laptop',
        data: { token: 't', expiresAt: null },
      },
      'mahmoud created the access token “laptop”',
    ],
    [
      'token.deleted',
      {
        action: 'token.deleted',
        repo: null,
        target: 'laptop',
        data: { token: 't' },
      },
      'mahmoud deleted the access token “laptop”',
    ],
    [
      'visibility.changed',
      {
        action: 'visibility.changed',
        target: 'choyiny/gitorange',
        data: { from: 'private', to: 'internal' },
      },
      'mahmoud made choyiny/gitorange internal',
    ],
    [
      'repository.created',
      {
        action: 'repository.created',
        target: 'choyiny/gitorange',
        data: { visibility: 'private' },
      },
      'mahmoud created choyiny/gitorange (private)',
    ],
    [
      'repository.deleted',
      {
        action: 'repository.deleted',
        repo: null,
        target: 'choyiny/old-thing',
        data: { repository: 'r1' },
      },
      'mahmoud deleted choyiny/old-thing',
    ],
    [
      'instance.settings',
      {
        action: 'instance.settings',
        repo: null,
        target: 'actions.retention_days',
        data: { value: 30 },
      },
      'mahmoud changed the instance setting Actions retention days',
    ],
    [
      'instance.settings reset',
      {
        action: 'instance.settings',
        repo: null,
        target: 'ai.review_model',
        data: { reset: true },
      },
      'mahmoud reset the instance setting AI review model to its default',
    ],
  ];

  it.each(cases)('%s', (_name, over, sentence) => {
    expect(auditText(ev(over))).toBe(sentence);
  });

  it('is told about every action the spec lists', () => {
    // docs/superpowers/specs/2026-10-08-crew-redesign-design.md → audit_events actions.
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        'settings.changed',
        'collaborator.added',
        'collaborator.removed',
        'agent.invited',
        'agent.removed',
        'agent.created',
        'agent.deleted',
        'branch.deleted',
        'branches.cleaned',
        'merging.paused',
        'merging.resumed',
        'pull.merged',
        'pull.reverted',
        'pull.approved',
        'finding.approved',
        'finding.changes_requested',
        'finding.assigned',
        'finding.delegated',
        'finding.undone',
        'finding.taught',
        'token.created',
        'token.deleted',
        'visibility.changed',
        'repository.created',
        'repository.deleted',
        'instance.settings',
      ].sort()
    );
  });

  it('has a case for each of them', () => {
    const covered = new Set(
      cases.map(([, over]) => over.action).filter(Boolean)
    );
    for (const action of AUDIT_ACTIONS) expect(covered.has(action)).toBe(true);
  });
});

describe('in a repository’s own log', () => {
  it.each<[string, Partial<AuditEvent>, string]>([
    [
      'settings',
      { action: 'settings.changed', data: { changes: { name: {} } } },
      'mahmoud changed the name',
    ],
    [
      'invited agent',
      { action: 'agent.invited', target: 'speedagent' },
      'mahmoud invited Speed to review this repository',
    ],
    [
      'removed agent',
      { action: 'agent.removed', target: 'speedagent' },
      'mahmoud removed Speed as a reviewer on this repository',
    ],
    [
      'visibility',
      {
        action: 'visibility.changed',
        data: { from: 'internal', to: 'private' },
      },
      'mahmoud made this repository private',
    ],
    [
      'created',
      { action: 'repository.created', data: { visibility: 'internal' } },
      'mahmoud created this repository (internal)',
    ],
    ['paused', { action: 'merging.paused' }, 'mahmoud paused merging'],
    [
      'cleaned',
      {
        action: 'branches.cleaned',
        data: { branches: ['a'] },
        target: '1 branch',
      },
      'mahmoud cleaned up 1 merged branch',
    ],
  ])('%s', (_n, over, sentence) => {
    expect(auditText(ev(over), { scope: 'repo' })).toBe(sentence);
  });
});

describe('the pull request timeline in the same log', () => {
  const system = { kind: 'system', login: null, name: null } as const;
  it.each<[string, Partial<AuditEvent>, string]>([
    [
      'state changed',
      {
        actor: system,
        action: 'pull.state_changed',
        pull: 74,
        data: { state: 'ready' },
      },
      'System marked #74 as ready to merge',
    ],
    [
      'waiting on a person',
      {
        actor: system,
        action: 'pull.state_changed',
        pull: 74,
        data: { state: 'human_review' },
      },
      'System marked #74 as waiting on a person',
    ],
    [
      'stacked',
      { actor: system, action: 'pull.stacked', pull: 74, data: { pr: 73 } },
      'System stacked #74 on #73',
    ],
    [
      'unstacked',
      { actor: system, action: 'pull.unstacked', pull: 74, data: { pr: 73 } },
      'System unstacked #74 from #73',
    ],
    [
      'ordered: recorded on the pull request that lands later',
      {
        actor: system,
        action: 'pull.ordered',
        pull: 73,
        data: { before: 72, for_pr: 74 },
      },
      'System set #73 to land after #72, so #74 can build on both',
    ],
    [
      'ordered without a third pull request',
      {
        actor: system,
        action: 'pull.ordered',
        pull: 73,
        data: { before: 72, for_pr: 73 },
      },
      'System set #73 to land after #72',
    ],
    [
      'must account for',
      {
        actor: system,
        action: 'pull.must_account_for',
        pull: 74,
        data: { pr: 73 },
      },
      'System flagged #74 as needing to account for #73',
    ],
    [
      'accounted for',
      {
        actor: system,
        action: 'pull.accounted_for',
        pull: 74,
        data: { pr: 73 },
      },
      'System marked #74 as accounted for #73',
    ],
    [
      'dismissed',
      { action: 'pull.dismissed', pull: 74, data: { pr: 73 } },
      'mahmoud dismissed the dependency of #74 on #73',
    ],
    [
      'withdrawn',
      { action: 'pull.withdrawn', pull: 74 },
      'mahmoud withdrew their approval of #74',
    ],
    [
      'learned',
      {
        actor: { kind: 'agent', login: 'speedagent', name: 'Speed' },
        action: 'pull.learned',
        pull: 74,
        data: { handle: 'speedagent', findings: 2 },
      },
      'Speed learned from 2 dismissed findings on #74',
    ],
    [
      'rebased',
      {
        actor: system,
        action: 'pull.rebased',
        pull: 74,
        data: { onto: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40) },
      },
      'System rebased #74 onto main',
    ],
  ])('%s', (_n, over, sentence) => {
    expect(auditText(ev(over), { scope: 'repo' })).toBe(sentence);
  });

  it('says what blocks a pull request, in the detail line', () => {
    expect(
      auditDetail(
        ev({
          actor: system,
          action: 'pull.state_changed',
          pull: 74,
          data: {
            state: 'human_review',
            reasons: [{ kind: 'changes_requested', flags: 2 }],
          },
        })
      )
    ).toBe('changes requested on 2 flags');
  });
});

describe('what the data does not say', () => {
  it('copes with an action it does not know', () => {
    expect(
      auditText(ev({ action: 'pull.something_new', pull: 5, target: '#5' }), {
        scope: 'repo',
      })
    ).toBe('mahmoud recorded something new on #5');
    expect(
      auditText(ev({ action: 'widget.frobbed', repo: null, target: 'w1' }))
    ).toBe('mahmoud widget frobbed w1');
  });

  it('copes with a finding that names no agent', () => {
    expect(
      auditText(
        ev({
          action: 'finding.approved',
          pull: 9,
          data: { kind: 'needs_person' },
        }),
        { scope: 'repo' }
      )
    ).toBe('mahmoud approved a finding on #9');
  });

  it('copes with a removed actor', () => {
    expect(
      auditText(
        ev({
          actor: { kind: 'person', login: null, name: null },
          action: 'merging.resumed',
        }),
        { scope: 'repo' }
      )
    ).toBe('A former member resumed merging');
  });

  it('copes with data that is not what it expects', () => {
    expect(
      auditText(
        ev({
          action: 'settings.changed',
          data: { changes: 'nonsense' },
        }),
        { scope: 'repo' }
      )
    ).toBe('mahmoud changed settings');
    expect(
      auditText(ev({ action: 'branches.cleaned', target: 'some', data: {} }), {
        scope: 'repo',
      })
    ).toBe('mahmoud cleaned up merged branches');
  });
});

describe('the second line', () => {
  it('quotes the finding and the reason for a decision', () => {
    expect(
      auditDetail(
        ev({
          action: 'finding.approved',
          target: 'Token is logged',
          pull: 74,
          data: {
            agent: 'securityagent',
            kind: 'needs_person',
            reason: 'Only the first four characters.',
          },
        })
      )
    ).toBe('“Token is logged”. Reason: Only the first four characters.');
  });

  it('gives the note for requested changes and the teaching', () => {
    expect(
      auditDetail(
        ev({
          action: 'finding.changes_requested',
          target: 'Slow query',
          data: { note: 'Add an index.' },
        })
      )
    ).toBe('“Slow query”. Note: Add an index.');
    expect(
      auditDetail(
        ev({
          action: 'finding.taught',
          target: 'Slow query',
          data: { teach: 'Never flag test files.' },
        })
      )
    ).toBe('“Slow query”. Taught: Never flag test files.');
  });

  it('gives what GitOrange AI thought', () => {
    expect(
      auditDetail(
        ev({
          actor: { kind: 'ai', login: 'cho', name: null },
          action: 'finding.delegated',
          target: 'Slow query',
          data: { decision: 'leave', reason: 'Unsure.' },
        })
      )
    ).toBe('“Slow query”. Why: Unsure.');
  });

  it('shows what a settings change was', () => {
    expect(
      auditDetail(
        ev({
          action: 'settings.changed',
          data: {
            changes: {
              defaultBranch: { from: 'main', to: 'trunk' },
              protectedBranches: { from: [], to: ['main', 'release/*'] },
              deleteMergedBranches: { from: true, to: false },
            },
          },
        })
      )
    ).toBe(
      'Default branch: main → trunk. Protected branches: none → main, release/*. Automatic branch clean-up: on → off'
    );
  });

  it('lists cleaned branches and the instance setting value', () => {
    expect(
      auditDetail(
        ev({
          action: 'branches.cleaned',
          data: { branches: ['a', 'b'], shas: {} },
        })
      )
    ).toBe('a, b');
    expect(
      auditDetail(
        ev({
          action: 'instance.settings',
          repo: null,
          target: 'app.name',
          data: { value: 'XY Space' },
        })
      )
    ).toBe('Now: XY Space');
  });

  it('says when a token lapses', () => {
    expect(
      auditDetail(
        ev({
          action: 'token.created',
          repo: null,
          target: 'laptop',
          data: { expiresAt: Date.UTC(2026, 10, 4) },
        })
      )
    ).toBe('Expires 2026-11-04');
    expect(
      auditDetail(
        ev({
          action: 'token.created',
          repo: null,
          target: 'laptop',
          data: { expiresAt: null },
        })
      )
    ).toBe('Never expires');
  });

  it('gives the reason merging was paused', () => {
    expect(
      auditDetail(
        ev({
          action: 'merging.paused',
          data: { reason: 'Freeze for the demo' },
        })
      )
    ).toBe('Reason: Freeze for the demo');
    expect(
      auditDetail(ev({ action: 'merging.paused', data: { reason: '' } }))
    ).toBeNull();
  });

  it('shows an empty value as none', () => {
    expect(
      auditDetail(
        ev({
          action: 'settings.changed',
          data: { changes: { description: { from: '', to: 'A code host' } } },
        })
      )
    ).toBe('Description: none → A code host');
  });

  it('has nothing to add to a plain event', () => {
    expect(auditDetail(ev({ action: 'merging.paused' }))).toBeNull();
  });

  it('keeps a long reason short', () => {
    const d = auditDetail(
      ev({
        action: 'finding.approved',
        target: 'T',
        data: { reason: 'x'.repeat(500) },
      })
    );
    expect(d!.length).toBeLessThan(260);
    expect(d!.endsWith('…')).toBe(true);
  });
});

describe('links and categories', () => {
  it('links to the pull request, else the repository, else nothing', () => {
    expect(auditLink(ev({ action: 'pull.merged', pull: 12 }))).toBe(
      '/choyiny/gitorange/pull/12'
    );
    expect(auditLink(ev({ action: 'merging.paused' }))).toBe(
      '/choyiny/gitorange'
    );
    expect(auditLink(ev({ action: 'token.created', repo: null }))).toBeNull();
  });

  it('puts every action in a category', () => {
    for (const action of AUDIT_ACTIONS)
      expect(auditCategory(action)).toMatch(
        /^(merging|decisions|access|settings)$/
      );
    expect(auditCategory('pull.state_changed')).toBe('activity');
    expect(auditCategory('pull.rebased')).toBe('activity');
    expect(auditCategory('pull.dismissed')).toBe('decisions');
    expect(auditCategory('something.else')).toBe('activity');
  });
});
