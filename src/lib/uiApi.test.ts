import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { api, qk } from './uiApi';

/** What the page asked the server for. */
type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let reply: { status: number; json: unknown };

beforeEach(() => {
  calls = [];
  reply = { status: 200, json: {} };
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const sent = async (call: () => Promise<unknown>) => {
  await call();
  expect(calls).toHaveLength(1);
  return calls[0];
};

describe('crew redesign reads', () => {
  const reads: [string, () => Promise<unknown>, string][] = [
    ['repoStats', () => api.repoStats(), '/api/repos?stats=1'],
    ['agentPresets', () => api.agentPresets(), '/api/agents/presets'],
    ['agentsBuiltin', () => api.agentsBuiltin(), '/api/agents/builtin'],
    [
      'agentStats',
      () => api.agentStats('data-agent'),
      '/api/agents/data-agent/stats',
    ],
    ['delegations', () => api.delegations(), '/api/me/delegations'],
    [
      'approvalFlag',
      () => api.approvalFlag('f 1'),
      '/api/approvals/flags/f%201',
    ],
    ['sessions', () => api.sessions('o', 'r'), '/api/repos/o/r/sessions'],
    [
      'session',
      () => api.session('o', 'r', 's-a3e258a5a3'),
      '/api/repos/o/r/sessions/s-a3e258a5a3',
    ],
    ['branches', () => api.branches('o', 'r'), '/api/repos/o/r/branches'],
    [
      'branchMap (server default window)',
      () => api.branchMap('o', 'r'),
      '/api/repos/o/r/branches/map',
    ],
    [
      'branchMap (30 days)',
      () => api.branchMap('o', 'r', 30),
      '/api/repos/o/r/branches/map?days=30',
    ],
    ['queue', () => api.queue('o', 'r'), '/api/repos/o/r/queue'],
    ['live', () => api.live('o', 'r'), '/api/repos/o/r/live'],
    ['health', () => api.health('o', 'r'), '/api/repos/o/r/health'],
    [
      'repoAudit (first page)',
      () => api.repoAudit('o', 'r'),
      '/api/repos/o/r/audit',
    ],
    [
      'repoAudit (next page, smaller)',
      () => api.repoAudit('o', 'r', 'abc', 5),
      '/api/repos/o/r/audit?cursor=abc&limit=5',
    ],
    ['adminAudit (first page)', () => api.adminAudit(), '/api/admin/audit'],
    [
      'adminAudit (next page)',
      () => api.adminAudit('c1'),
      '/api/admin/audit?cursor=c1',
    ],
    ['search', () => api.search('auth'), '/api/search?q=auth'],
    [
      'search in a repository',
      () => api.search('a b', 'o/r'),
      '/api/search?q=a+b&repo=o%2Fr',
    ],
    [
      'search with no repository',
      () => api.search('#12', null),
      '/api/search?q=%2312',
    ],
  ];

  it.each(reads)(
    '%s asks for the right URL with GET',
    async (_n, call, url) => {
      expect(await sent(call)).toEqual({
        url,
        method: 'GET',
        body: undefined,
      });
    }
  );

  it('encodes an owner or repository name', async () => {
    expect((await sent(() => api.queue('a b', 'c/d'))).url).toBe(
      '/api/repos/a%20b/c%2Fd/queue'
    );
  });

  it('hands a search the abort signal, so a superseded request is cancelled', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
    });
    const controller = new AbortController();
    await api.search('x', null, controller.signal);
    expect(seen[0]).toBe(controller.signal);
  });
});

describe('crew redesign writes', () => {
  it('creates the recommended crew, and an agent from a preset', async () => {
    expect(await sent(() => api.createAgentCrew())).toEqual({
      url: '/api/admin/agents/crew',
      method: 'POST',
      body: undefined,
    });
    calls = [];
    expect(await sent(() => api.createAgent({ preset: 'security' }))).toEqual({
      url: '/api/admin/agents',
      method: 'POST',
      body: { preset: 'security' },
    });
  });

  it('replaces the delegated agents with the handles given', async () => {
    expect(await sent(() => api.setDelegations(['speed', 'data']))).toEqual({
      url: '/api/me/delegations',
      method: 'PUT',
      body: { agents: ['speed', 'data'] },
    });
  });

  it('approves a finding with no body, or with a trimmed reason and teaching', async () => {
    const url = '/api/repos/o/r/pulls/3/review/flags/f1/approve';
    expect(await sent(() => api.approveFlag('o', 'r', 3, 'f1'))).toEqual({
      url,
      method: 'POST',
      body: undefined,
    });
    calls = [];
    expect(
      (
        await sent(() =>
          api.approveFlag('o', 'r', 3, 'f1', {
            reason: '  Legal signed off  ',
            teach: 'Refunds over $500 need approval',
          })
        )
      ).body
    ).toEqual({
      reason: 'Legal signed off',
      teach: 'Refunds over $500 need approval',
    });
    calls = [];
    // Empty text is not sent: the server would count it as a reason that isn't there.
    expect(
      (
        await sent(() =>
          api.approveFlag('o', 'r', 3, 'f1', { reason: '  ', teach: null })
        )
      ).body
    ).toBeUndefined();
  });

  it('requests changes with a note, and teaches only when asked', async () => {
    const url = '/api/repos/o/r/pulls/3/review/flags/f1/request-changes';
    expect(
      await sent(() => api.requestFlagChanges('o', 'r', 3, 'f1', ' Rotate it '))
    ).toEqual({ url, method: 'POST', body: { note: 'Rotate it' } });
    calls = [];
    expect(
      (
        await sent(() =>
          api.requestFlagChanges('o', 'r', 3, 'f1', '', 'Always')
        )
      ).body
    ).toEqual({ note: null, teach: 'Always' });
  });

  it('assigns a finding to a login, or clears it with null', async () => {
    const url = '/api/repos/o/r/pulls/3/review/flags/f1/assign';
    expect(
      await sent(() => api.assignFlag('o', 'r', 3, 'f1', 'amira'))
    ).toEqual({ url, method: 'POST', body: { login: 'amira' } });
    calls = [];
    expect(
      (await sent(() => api.assignFlag('o', 'r', 3, 'f1', null))).body
    ).toEqual({ login: null });
  });

  it('undoes a decision and lets GitOrange AI decide, with no body', async () => {
    expect(await sent(() => api.undoFlag('o', 'r', 3, 'f1'))).toEqual({
      url: '/api/repos/o/r/pulls/3/review/flags/f1/undo',
      method: 'POST',
      body: undefined,
    });
    calls = [];
    expect(await sent(() => api.delegateFlag('o', 'r', 3, 'f1'))).toEqual({
      url: '/api/repos/o/r/pulls/3/review/flags/f1/delegate',
      method: 'POST',
      body: undefined,
    });
  });

  it('cleans branches, pauses and resumes merging, and reverts a pull request', async () => {
    expect(await sent(() => api.cleanBranches('o', 'r'))).toEqual({
      url: '/api/repos/o/r/branches/clean',
      method: 'POST',
      body: undefined,
    });
    calls = [];
    expect(
      await sent(() => api.pauseMerging('o', 'r', ' Error spike '))
    ).toEqual({
      url: '/api/repos/o/r/merging/pause',
      method: 'POST',
      body: { reason: 'Error spike' },
    });
    calls = [];
    // The reason is optional: none is sent, not an empty one.
    expect((await sent(() => api.pauseMerging('o', 'r'))).body).toBeUndefined();
    calls = [];
    expect(await sent(() => api.resumeMerging('o', 'r'))).toEqual({
      url: '/api/repos/o/r/merging/pause',
      method: 'DELETE',
      body: undefined,
    });
    calls = [];
    expect(await sent(() => api.revertPull('o', 'r', 7))).toEqual({
      url: '/api/repos/o/r/pulls/7/revert',
      method: 'POST',
      body: undefined,
    });
  });

  it('changes whether landing deletes the pull request branch', async () => {
    expect(
      await sent(() => api.updateRepo('o', 'r', { deleteMergedBranches: true }))
    ).toEqual({
      url: '/api/repos/o/r',
      method: 'PATCH',
      body: { deleteMergedBranches: true },
    });
  });

  it('reads the reason a revert was refused from the 409', async () => {
    reply = {
      status: 409,
      json: { message: 'It was never merged.', error: 'It was never merged.' },
    };
    const failure = await api.revertPull('o', 'r', 7).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(409);
    expect(failure.message).toBe('It was never merged.');
    expect(failure.body.message).toBe('It was never merged.');
  });
});

describe('pull request lists', () => {
  it('asks for the whole list without a limit, as before', async () => {
    expect((await sent(() => api.pulls('o', 'r', 'open'))).url).toBe(
      '/api/repos/o/r/pulls?state=open'
    );
  });

  it('asks for one page of a limit', async () => {
    expect(
      (await sent(() => api.pulls('o', 'r', 'merged', { limit: 5 }))).url
    ).toBe('/api/repos/o/r/pulls?state=merged&limit=5');
    calls = [];
    expect(
      (await sent(() => api.pulls('o', 'r', 'closed', { limit: 25, page: 3 })))
        .url
    ).toBe('/api/repos/o/r/pulls?state=closed&limit=25&page=3');
  });

  it('sends a search, trimmed, and none when it is blank', async () => {
    expect(
      (
        await sent(() =>
          api.pulls('o', 'r', 'closed', { limit: 25, q: '  claude s4 ' })
        )
      ).url
    ).toBe('/api/repos/o/r/pulls?state=closed&limit=25&q=claude+s4');
    calls = [];
    expect(
      (await sent(() => api.pulls('o', 'r', 'closed', { limit: 25, q: '  ' })))
        .url
    ).toBe('/api/repos/o/r/pulls?state=closed&limit=25');
  });

  it('leaves out page 1, and a page without a limit', async () => {
    expect(
      (await sent(() => api.pulls('o', 'r', 'closed', { limit: 25, page: 1 })))
        .url
    ).toBe('/api/repos/o/r/pulls?state=closed&limit=25');
    calls = [];
    expect(
      (await sent(() => api.pulls('o', 'r', 'closed', { page: 4 }))).url
    ).toBe('/api/repos/o/r/pulls?state=closed');
  });

  it('keeps every page under the pull request lists, and tells pages apart', () => {
    for (const key of [
      qk.pulls('o', 'r', 'open'),
      qk.pulls('o', 'r', 'merged', 5),
      qk.pulls('o', 'r', 'closed', 25, 2),
    ])
      expect(key.slice(0, 4)).toEqual(['repo', 'o', 'r', 'pulls']);
    expect(qk.pulls('o', 'r', 'closed', 25, 1)).not.toEqual(
      qk.pulls('o', 'r', 'closed', 25, 2)
    );
    expect(qk.pulls('o', 'r', 'closed')).not.toEqual(
      qk.pulls('o', 'r', 'closed', 25)
    );
    expect(qk.pulls('o', 'r', 'closed', 25)).not.toEqual(
      qk.pulls('o', 'r', 'merged', 25)
    );
    expect(qk.pulls('o', 'r', 'closed', 25, 1, 'a')).not.toEqual(
      qk.pulls('o', 'r', 'closed', 25, 1, 'b')
    );
  });
});

describe('query keys', () => {
  it('start every repository-scoped key with the repository, so its live pings refresh them', () => {
    const keys = [
      qk.branches('o', 'r'),
      qk.branchMap('o', 'r'),
      qk.branchMap('o', 'r', 30),
      qk.sessions('o', 'r'),
      qk.session('o', 'r', 's-1'),
      qk.queue('o', 'r'),
      qk.live('o', 'r'),
      qk.health('o', 'r'),
      qk.repoAudit('o', 'r'),
      qk.repoAudit('o', 'r', 'c1'),
    ];
    for (const key of keys) expect(key.slice(0, 3)).toEqual(['repo', 'o', 'r']);
  });

  it('keeps finding and delegation keys under approvals, so live pings and decisions refresh them', () => {
    expect(qk.approvalFlag('f1').slice(0, 1)).toEqual(qk.approvals);
    expect(qk.delegations.slice(0, 1)).toEqual(qk.approvals);
  });

  it('keeps the board under repos and the agent lookups under agents', () => {
    expect(qk.repoStats.slice(0, 1)).toEqual(qk.repos);
    for (const key of [
      qk.agentPresets,
      qk.agentsBuiltin,
      qk.agentStats('security'),
    ])
      expect(key.slice(0, 1)).toEqual(qk.agents);
  });

  it('tells one search, scope and page apart', () => {
    expect(qk.search('a', null)).not.toEqual(qk.search('a', 'o/r'));
    expect(qk.search('a', null)).not.toEqual(qk.search('b', null));
    expect(qk.adminAudit()).not.toEqual(qk.adminAudit('c1'));
    expect(qk.repoAudit('o', 'r')).not.toEqual(qk.repoAudit('o', 'r', 'c1'));
    expect(qk.branchMap('o', 'r')).not.toEqual(qk.branchMap('o', 'r', 10));
  });
});
