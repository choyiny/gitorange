import { describe, expect, it } from 'vitest';
import {
  askCandidates,
  dedupeItems,
  displayOrder,
  findingSentence,
  guardMessage,
  inboxRows,
  isOwnerQuestion,
  keyAction,
  moveCurrent,
  onlyAssignedTo,
  selectable,
  splitFindingDetail,
  type FindingRow,
} from './approvalsInbox';
import type { ApprovalItem, Member, ReviewFlag, User } from './uiApi';

const user = (username: string, name = username): User => ({
  id: `u-${username}`,
  username,
  name,
  image: null,
});

const flag = (id: string, over: Partial<ReviewFlag> = {}): ReviewFlag => ({
  id,
  kind: 'needs_person',
  title: `Finding ${id}`,
  paths: [],
  detail: null,
  detailModel: null,
  agentSha: null,
  approvedBy: null,
  approvedAt: null,
  approvedVia: null,
  changesRequestedBy: null,
  changesRequestedAt: null,
  changesRequestedNote: null,
  question: null,
  guarded: false,
  assignee: null,
  decidedVia: null,
  reason: null,
  teach: null,
  ...over,
});

const item = (n: number, over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  repo: { fullName: 'cho/app', name: 'app' },
  pull: {
    number: n,
    title: `Pull ${n}`,
    author: user('cho'),
    updatedAt: '2026-10-08T10:00:00.000Z',
    headSha: 'abc1234',
    createdVia: null,
    sessionLabel: null,
    sessionId: 'sess-1',
  },
  reviewFailed: null,
  resolutionFailed: null,
  needsApproval: false,
  agents: [],
  pullState: null,
  stackStale: [],
  stackUnchecked: [],
  ...over,
});

const findingRow = (f: ReviewFlag, agent = user('securityagent', 'Security')) =>
  inboxRows([
    item(1, {
      agents: [
        { reviewerId: 'r1', agent, status: 'flagged', error: null, flags: [f] },
      ],
    }),
  ])[0] as FindingRow;

describe('inbox rows', () => {
  it('turns every kind of item into rows, in the order the old page showed them', () => {
    const rows = inboxRows([
      item(7, {
        reviewFailed: 'The model timed out',
        resolutionFailed: "AI couldn't resolve its conflicts: boom",
        stackStale: [{ pr: 3, since: '2026-10-01T00:00:00.000Z' }],
        stackUnchecked: [4, 5],
        needsApproval: true,
        agents: [
          {
            reviewerId: 'r1',
            agent: user('dataagent', 'Data'),
            status: 'failed',
            error: 'no model',
            flags: [],
          },
          {
            reviewerId: 'r2',
            agent: user('securityagent', 'Security'),
            status: 'flagged',
            error: null,
            flags: [flag('f1'), flag('f2')],
          },
        ],
      }),
    ]);
    expect(rows.map((r) => [r.type, r.key])).toEqual([
      ['review-failed', 'rf:cho/app#7'],
      ['resolution-failed', 'rs:cho/app#7'],
      ['stack-stale', 'st:cho/app#7:3'],
      ['stack-unchecked', 'su:cho/app#7'],
      ['needs-approval', 'na:cho/app#7'],
      ['reviewer-failed', 'rv:r1'],
      ['finding', 'f:f1'],
      ['finding', 'f:f2'],
    ]);
    expect(rows[0]).toMatchObject({
      owner: 'cho',
      name: 'app',
      repo: 'cho/app',
      prUrl: '/cho/app/pull/7',
    });
  });

  it('shows a pull request that needs a person for another reason once, only when nothing else applies', () => {
    const state = {
      state: 'human_review' as const,
      reasons: [{ kind: 'stack_cycle' }],
    };
    expect(
      inboxRows([item(2, { pullState: state })]).map((r) => r.type)
    ).toEqual(['human-review']);
    expect(
      inboxRows([item(2, { pullState: state, needsApproval: true })]).map(
        (r) => r.type
      )
    ).toEqual(['needs-approval']);
  });

  it("warns on a pull request needing approval when an agent's change request still stands", () => {
    const plain = inboxRows([item(1, { needsApproval: true })])[0];
    expect(plain).toMatchObject({ changeRequested: false });
    const asked = inboxRows([
      item(1, {
        needsApproval: true,
        pullState: {
          state: 'human_review',
          reasons: [{ kind: 'agent_changes_requested' }],
        },
      }),
    ])[0];
    expect(asked).toMatchObject({ changeRequested: true });
  });

  it('shows each pull request once, keeping the first page it came on', () => {
    const a = item(1);
    const again = item(1, { needsApproval: true });
    const b = item(2);
    expect(
      dedupeItems([{ items: [a, b] }, { items: [again] }]).map((i) => [
        i.pull.number,
        i.needsApproval,
      ])
    ).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('keeps only findings someone asked you to decide', () => {
    const mine = flag('f1', {
      assignee: { login: 'mahmoud', name: null, isAgent: false, color: null },
    });
    const rows = inboxRows([
      item(1, {
        needsApproval: true,
        agents: [
          {
            reviewerId: 'r',
            agent: user('dataagent'),
            status: 'flagged',
            error: null,
            flags: [mine, flag('f2')],
          },
        ],
      }),
    ]);
    expect(onlyAssignedTo(rows, 'mahmoud').map((r) => r.key)).toEqual(['f:f1']);
    expect(onlyAssignedTo(rows, 'MAHMOUD').map((r) => r.key)).toEqual(['f:f1']);
  });
});

describe('what can be picked and what keys do', () => {
  it('never lets a guarded finding, an owner question or a decided finding into bulk approval', () => {
    expect(selectable(findingRow(flag('a')))).toBe(true);
    expect(selectable(findingRow(flag('a', { guarded: true })))).toBe(false);
    expect(selectable(findingRow(flag('a', { question: 'Was it?' })))).toBe(
      false
    );
    expect(
      selectable(
        findingRow(
          flag('a', { changesRequestedAt: '2026-10-08T10:00:00.000Z' })
        )
      )
    ).toBe(false);
    expect(selectable(inboxRows([item(1, { needsApproval: true })])[0])).toBe(
      false
    );
  });

  it('knows an owner question from a developer finding', () => {
    expect(isOwnerQuestion(findingRow(flag('a', { question: 'Q?' })))).toBe(
      true
    );
    expect(isOwnerQuestion(findingRow(flag('a')))).toBe(false);
    expect(
      isOwnerQuestion(
        findingRow(flag('a', { question: 'Q?', kind: 'change_requested' }))
      )
    ).toBe(false);
  });

  it('moves with j and k from any row, and approves selected with A', () => {
    expect(keyAction('j', null)).toEqual({ kind: 'move', dir: 1 });
    expect(keyAction('k', null)).toEqual({ kind: 'move', dir: -1 });
    expect(keyAction('A', null)).toEqual({ kind: 'bulk' });
    expect(keyAction('a', null)).toBeNull();
  });

  it('approves, asks for changes, dismisses and selects an ordinary finding by one key', () => {
    const row = findingRow(flag('a'), user('speedagent', 'Speed'));
    expect(keyAction('o', row)).toEqual({ kind: 'open' });
    expect(keyAction('Enter', row)).toEqual({ kind: 'open' });
    expect(keyAction('a', row)).toEqual({ kind: 'approve' });
    expect(keyAction('r', row)).toEqual({ kind: 'panel', panel: 'changes' });
    expect(keyAction('d', row)).toEqual({ kind: 'panel', panel: 'dismiss' });
    expect(keyAction('x', row)).toEqual({ kind: 'select' });
    expect(keyAction('q', row)).toBeNull();
  });

  it('never approves or selects a guarded finding by one key: it opens its page and says why', () => {
    const row = findingRow(flag('a', { guarded: true }));
    expect(keyAction('a', row)).toEqual({
      kind: 'open',
      toast: 'Security findings need a reason. Open it to decide.',
    });
    expect(keyAction('d', row)).toEqual({
      kind: 'open',
      toast: 'Security findings need a reason. Open it to decide.',
    });
    expect(keyAction('x', row)).toEqual({
      kind: 'toast',
      message: "Security findings can't be approved in bulk.",
    });
    expect(keyAction('r', row)).toEqual({ kind: 'panel', panel: 'changes' });
  });

  it('opens an owner question on its page for a, r and d', () => {
    const row = findingRow(flag('a', { question: 'Were they all CAD?' }));
    for (const k of ['a', 'r', 'd', 'o'])
      expect(keyAction(k, row)).toEqual({ kind: 'open' });
    expect(keyAction('x', row)).toBeNull();
  });

  it("says a guarded agent's owner question needs a reason when a or d opens it", () => {
    const row = findingRow(
      flag('a', { question: 'Were they all CAD?', guarded: true }),
      user('dataagent', 'Data')
    );
    const toast = 'Data findings need a reason. Open it to decide.';
    expect(keyAction('a', row)).toEqual({ kind: 'open', toast });
    expect(keyAction('d', row)).toEqual({ kind: 'open', toast });
    expect(keyAction('r', row)).toEqual({ kind: 'open' });
    expect(keyAction('x', row)).toBeNull();
  });

  it('opens other rows, and ignores decision keys on them', () => {
    const row = inboxRows([item(1, { needsApproval: true })])[0];
    expect(keyAction('o', row)).toEqual({ kind: 'open' });
    for (const k of ['a', 'r', 'd', 'x']) expect(keyAction(k, row)).toBeNull();
  });

  it('does not select or re-request a finding that already has changes requested', () => {
    const asked = { changesRequestedAt: '2026-10-08T10:00:00.000Z' };
    const row = findingRow(flag('a', asked));
    expect(keyAction('x', row)).toBeNull();
    expect(keyAction('r', row)).toBeNull();
    expect(keyAction('a', row)).toEqual({ kind: 'approve' });
    expect(keyAction('d', row)).toEqual({ kind: 'panel', panel: 'dismiss' });
    const guarded = findingRow(flag('b', { ...asked, guarded: true }));
    expect(keyAction('r', guarded)).toBeNull();
    expect(keyAction('a', guarded)).toMatchObject({ kind: 'open' });
  });

  it('says why a guarded agent needs a reason, with its name', () => {
    expect(guardMessage('Data')).toBe(
      'Data findings need a reason. Open it to decide.'
    );
  });

  it('moves the current row and stops at the ends', () => {
    const keys = ['a', 'b', 'c'];
    expect(moveCurrent(keys, null, 1)).toBe('a');
    expect(moveCurrent(keys, 'gone', -1)).toBe('a');
    expect(moveCurrent(keys, 'a', 1)).toBe('b');
    expect(moveCurrent(keys, 'c', 1)).toBe('c');
    expect(moveCurrent(keys, 'a', -1)).toBe('a');
    expect(moveCurrent([], 'a', 1)).toBeNull();
  });
});

describe('receipts in place', () => {
  it('keeps a decided row where it was after the list reloads without it', () => {
    expect(
      displayOrder(
        ['a', 'c'],
        [
          { key: 'b', index: 1 },
          { key: 'a', index: 0 },
        ]
      )
    ).toEqual(['a', 'b', 'c']);
    expect(displayOrder(['a'], [{ key: 'z', index: 9 }])).toEqual(['a', 'z']);
    expect(
      displayOrder(
        [],
        [
          { key: 'y', index: 1 },
          { key: 'x', index: 0 },
        ]
      )
    ).toEqual(['x', 'y']);
  });
});

describe('the finding as recorded', () => {
  const detail = [
    'Opening a link downloads the file without checking who is signed in.',
    '| | Before | After |\n|---|---|---|\n| **Sign-in** | Required | Not checked |',
    '```mermaid\nflowchart LR\n  A --> B\n```',
    '<details><summary><code>worker/src/share.ts</code> lines 3–5</summary>\n\n```diff\n-  const user = await requireUser(c);\n+  const link = await find(c);\n```\n\n</details>',
    '<details><summary><code>src/a.ts</code> lines 1–2</summary>\n\n```diff\n+x\n```\n\n</details>',
  ].join('\n\n');

  it('splits it into its sentence, table, diagram and excerpts', () => {
    const parts = splitFindingDetail(detail);
    expect(parts.sentence).toBe(
      'Opening a link downloads the file without checking who is signed in.'
    );
    expect(parts.table).toBe(
      '| | Before | After |\n|---|---|---|\n| **Sign-in** | Required | Not checked |'
    );
    expect(parts.diagram).toBe('```mermaid\nflowchart LR\n  A --> B\n```');
    expect(parts.excerpts).toHaveLength(2);
    expect(parts.excerpts[0]).toContain('worker/src/share.ts');
    expect(parts.excerpts[0]).toContain('</details>');
    expect(parts.rest).toBeNull();
  });

  it('keeps anything it does not recognise, and copes with no detail', () => {
    expect(splitFindingDetail(null)).toEqual({
      sentence: null,
      table: null,
      diagram: null,
      excerpts: [],
      rest: null,
    });
    const parts = splitFindingDetail('One sentence.\n\nA second paragraph.');
    expect(parts.sentence).toBe('One sentence.');
    expect(parts.rest).toBe('A second paragraph.');
    expect(splitFindingDetail('| a |\n|---|\n| b |').sentence).toBeNull();
  });

  it('uses the sentence under the title only when it says more', () => {
    expect(
      findingSentence(flag('a', { title: 'Removes CSV export', detail }))
    ).toBe(
      'Opening a link downloads the file without checking who is signed in.'
    );
    expect(
      findingSentence(
        flag('a', {
          title: 'Removes CSV export',
          detail: 'Removes CSV export.',
        })
      )
    ).toBeNull();
    expect(findingSentence(flag('a'))).toBeNull();
  });
});

describe('who can be asked', () => {
  const member = (
    username: string,
    role = 'user',
    name = username
  ): Member => ({
    ...user(username, name),
    email: null,
    role,
    createdAt: '2026-01-01',
  });

  it('lists people with push rights: site admins, collaborators and the owner, never yourself', () => {
    expect(
      askCandidates({
        members: [
          member('mahmoud', 'admin', 'Mahmoud'),
          member('ada', 'admin', 'Ada'),
          member('cho', 'user', 'Cho'),
          member('reader', 'user', 'Reader'),
          member('zed', 'user', 'Zed'),
        ],
        collaborators: [user('zed', 'Zed'), user('ada', 'Ada')],
        owner: 'cho',
        me: 'mahmoud',
      })
    ).toEqual([
      { login: 'ada', name: 'Ada' },
      { login: 'cho', name: 'Cho' },
      { login: 'zed', name: 'Zed' },
    ]);
  });

  it('leaves out a team owner, which is not a person', () => {
    expect(
      askCandidates({
        members: [member('cho')],
        collaborators: [],
        owner: 'acme',
        me: 'mahmoud',
      })
    ).toEqual([]);
  });
});
