import { describe, expect, it } from 'vitest';
import {
  avatarStatusOf,
  cardStats,
  crewResultText,
  engineText,
  groupAgents,
  handleProblem,
  inviteChoices,
  latestNote,
  lessonTone,
  listNames,
  overallStatus,
  parseProfileTab,
  presetState,
  thresholdText,
  wakeText,
  whereText,
} from './agentPage';
import type { Agent, AgentPreset, AgentStats, CrewResult, Repo } from './uiApi';

const agent = (handle: string, extra: Partial<Agent> = {}): Agent => ({
  id: `id-${handle}`,
  username: handle,
  name: handle,
  image: null,
  bio: '',
  trigger: { ask: 'Anything?', above: 0.4 },
  engine: 'pass',
  color: '#2a78d6',
  facet: null,
  guarded: false,
  repository: `${handle}/${handle}`,
  configSha: null,
  configError: null,
  createdAt: '2026-10-01T00:00:00Z',
  deletedAt: null,
  ...extra,
});

const stats = (
  handle: string,
  repos: AgentStats['repos'],
  extra: Partial<AgentStats> = {}
): AgentStats => ({
  handle,
  raised: 0,
  kept: 0,
  dismissed: 0,
  keptPct: null,
  rules: 0,
  reviews: 0,
  byDay: [],
  bestCatch: null,
  repos,
  ...extra,
});

describe('overallStatus', () => {
  it('is idle without repositories or pull requests', () => {
    expect(overallStatus([])).toBe('idle');
    expect(overallStatus([{ status: 'idle' }, { status: 'idle' }])).toBe(
      'idle'
    );
  });
  it('takes the most pressing status across repositories', () => {
    expect(
      overallStatus([{ status: 'approved' }, { status: 'reviewing' }])
    ).toBe('reviewing');
    expect(
      overallStatus([{ status: 'reviewing' }, { status: 'flagged' }])
    ).toBe('flagged');
    expect(
      overallStatus([{ status: 'flagged' }, { status: 'changes_requested' }])
    ).toBe('changes_requested');
    expect(
      overallStatus([{ status: 'changes_requested' }, { status: 'failed' }])
    ).toBe('failed');
    expect(overallStatus([{ status: 'idle' }, { status: 'approved' }])).toBe(
      'approved'
    );
  });
  it('ignores a status that means it is not on the pull request', () => {
    expect(overallStatus([{ status: 'not_needed' }])).toBe('idle');
  });
});

describe('avatarStatusOf', () => {
  it('sleeps when deleted or not on any repository, otherwise shows what it is doing', () => {
    expect(avatarStatusOf({ deleted: true, repos: 2, status: 'flagged' })).toBe(
      'off'
    );
    expect(avatarStatusOf({ repos: 0, status: 'idle' })).toBe('off');
    expect(avatarStatusOf({ repos: 1, status: 'idle' })).toBe('idle');
    expect(avatarStatusOf({ repos: 1, status: 'flagged' })).toBe('flagged');
  });
});

describe('groupAgents', () => {
  const a = agent('aagent');
  const b = agent('bagent');
  const c = agent('cagent');
  it('puts agents invited to a repository you can see under reviewing, the rest under available', () => {
    const groups = groupAgents(
      [a, b, c],
      new Map([
        [
          'aagent',
          stats('aagent', [{ repo: 'o/r', status: 'idle', number: null }]),
        ],
        ['bagent', stats('bagent', [])],
        [
          'cagent',
          stats('cagent', [{ repo: 'o/s', status: 'approved', number: 3 }]),
        ],
      ])
    );
    expect(groups.reviewing.map((x) => x.username)).toEqual([
      'aagent',
      'cagent',
    ]);
    expect(groups.available.map((x) => x.username)).toEqual(['bagent']);
  });
  it('keeps an agent whose record could not be read with the reviewers rather than hiding where it works', () => {
    const groups = groupAgents([a], new Map());
    expect(groups.reviewing).toHaveLength(1);
    expect(groups.available).toHaveLength(0);
  });
});

describe('cardStats', () => {
  it('shows raised, the share kept and the rules learned', () => {
    expect(
      cardStats(stats('x', [], { raised: 12, keptPct: 75, rules: 2 }))
    ).toEqual([
      { value: '12', label: 'raised' },
      { value: '75%', label: 'kept' },
      { value: '2', label: 'rules' },
    ]);
  });
  it('uses a dash for a share nobody has decided yet, and singular for one rule', () => {
    expect(cardStats(stats('x', [], { raised: 3, rules: 1 }))).toEqual([
      { value: '3', label: 'raised' },
      { value: '—', label: 'kept' },
      { value: '1', label: 'rule' },
    ]);
  });
  it('shows dashes while the record is unknown', () => {
    expect(cardStats(undefined)).toEqual([
      { value: '—', label: 'raised' },
      { value: '—', label: 'kept' },
      { value: '—', label: 'rules' },
    ]);
  });
});

describe('whereText', () => {
  it('names the repository, or counts several, or says it is on none', () => {
    expect(whereText(undefined)).toBe('Record unavailable');
    expect(whereText(stats('x', []))).toBe(
      'Add it to a repository from its profile'
    );
    expect(
      whereText(stats('x', [{ repo: 'o/r', status: 'idle', number: null }]))
    ).toBe('Reviews o/r');
    expect(
      whereText(
        stats('x', [
          { repo: 'o/r', status: 'idle', number: null },
          { repo: 'o/s', status: 'idle', number: null },
        ])
      )
    ).toBe('Reviews 2 repositories');
  });
});

describe('parseProfileTab', () => {
  it('reads the tab from the address and falls back to the overview', () => {
    expect(parseProfileTab('reviews')).toBe('reviews');
    expect(parseProfileTab('rules')).toBe('rules');
    expect(parseProfileTab('config')).toBe('config');
    expect(parseProfileTab('overview')).toBe('overview');
    expect(parseProfileTab('nope')).toBe('overview');
    expect(parseProfileTab(null)).toBe('overview');
  });
});

const repo = (
  fullName: string,
  extra: Partial<Repo> & { ownerId?: string } = {}
): Repo => {
  const [o, n] = fullName.split('/');
  const { ownerId, ...rest } = extra;
  return {
    id: `r-${fullName}`,
    owner: { id: ownerId ?? `u-${o}`, username: o, name: o, image: null },
    ownerType: 'user',
    visibility: 'internal',
    name: n,
    fullName,
    description: null,
    defaultBranch: 'main',
    protectedBranches: [],
    deleteMergedBranches: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...rest,
  };
};

describe('inviteChoices', () => {
  const repos = [
    repo('zoe/site'),
    repo('mia/app'),
    repo('mia/tools'),
    repo('team/shared', { ownerType: 'team', ownerId: 't-1' }),
    repo('securityagent/securityagent'),
  ];
  const opts = {
    invited: [] as string[],
    agentRepos: ['securityagent/securityagent'],
  };
  it('offers a site admin every repository it is not on, sorted, but not the agents’ own', () => {
    expect(
      inviteChoices(repos, {
        ...opts,
        invited: ['mia/app'],
        me: { id: 'x', role: 'admin' },
      }).map((r) => r.fullName)
    ).toEqual(['mia/tools', 'team/shared', 'zoe/site']);
  });
  it('offers anyone else the repositories they own', () => {
    expect(
      inviteChoices(repos, { ...opts, me: { id: 'u-mia', role: 'user' } }).map(
        (r) => r.fullName
      )
    ).toEqual(['mia/app', 'mia/tools']);
  });
  it('matches already invited repositories without regard to case', () => {
    expect(
      inviteChoices(repos, {
        ...opts,
        invited: ['MIA/App'],
        me: { id: 'u-mia', role: 'user' },
      }).map((r) => r.fullName)
    ).toEqual(['mia/tools']);
  });
  it('offers nothing when nobody is signed in', () => {
    expect(inviteChoices(repos, { ...opts, me: null })).toEqual([]);
  });
});

describe('wakeText and engineText', () => {
  it('says how sure Clef must be, as a whole percentage', () => {
    expect(wakeText({ ask: 'x', above: 0.4 })).toBe(
      'Wakes when Clef is 40% sure'
    );
    expect(wakeText({ ask: 'x', above: 0.35 })).toBe(
      'Wakes when Clef is 35% sure'
    );
  });
  it('states the threshold for the settings', () => {
    expect(thresholdText({ above: 0.4 })).toBe(
      'At least 40% sure that the answer is yes'
    );
  });
  it('describes the two engines', () => {
    expect(engineText('pass')).toBe('One reasoning-model pass per review');
    expect(engineText('pi')).toBe(
      'A Pi agent that reads the repository with read-only tools'
    );
  });
});

describe('listNames', () => {
  it('joins names the way a sentence would', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Security'])).toBe('Security');
    expect(listNames(['Security', 'Data'])).toBe('Security and Data');
    expect(listNames(['Security', 'Data', 'Speed'])).toBe(
      'Security, Data and Speed'
    );
  });
});

describe('crewResultText', () => {
  const created = (n: string) => agent(n.toLowerCase() + 'agent', { name: n });
  it('names who was added and who was skipped, and why', () => {
    const r: CrewResult = {
      created: [created('Security'), created('Data')],
      skipped: [{ handle: 'speedagent', reason: 'Already exists' }],
    };
    expect(crewResultText(r)).toEqual({
      added: 'Added Security and Data.',
      skipped: ['@speedagent: Already exists'],
    });
  });
  it('says so when everything was there already', () => {
    expect(
      crewResultText({
        created: [],
        skipped: [{ handle: 'speedagent', reason: 'Already exists' }],
      }).added
    ).toBeNull();
  });
});

describe('handleProblem', () => {
  it('accepts a handle that is a valid username', () => {
    expect(handleProblem('accessibility')).toBeNull();
    expect(handleProblem('my-agent2')).toBeNull();
  });
  it('says what is wrong, in plain words', () => {
    expect(handleProblem('')).toBe('Give the agent a handle.');
    expect(handleProblem('has space')).toBe(
      'Use letters, numbers and single hyphens only.'
    );
    expect(handleProblem('-lead')).toBe(
      'Use letters, numbers and single hyphens only.'
    );
    expect(handleProblem('trail-')).toBe(
      'Use letters, numbers and single hyphens only.'
    );
    expect(handleProblem('dou--ble')).toBe(
      'Use letters, numbers and single hyphens only.'
    );
    expect(handleProblem('a'.repeat(40))).toBe(
      'A handle can be at most 39 characters.'
    );
  });
});

describe('presetState', () => {
  const preset = (handle: string, exists: boolean): AgentPreset => ({
    facet: 'security',
    name: 'Security',
    handle,
    bio: '',
    color: '#2a78d6',
    guarded: true,
    triggerAsk: '?',
    triggerAbove: 0.4,
    engine: 'pi',
    recommended: true,
    exists,
  });
  it('can be created while its handle is free', () => {
    expect(presetState(preset('securityagent', false), new Set())).toBe(
      'create'
    );
  });
  it('is created once an agent holds its handle, and taken when something else does', () => {
    expect(
      presetState(preset('securityagent', true), new Set(['securityagent']))
    ).toBe('created');
    expect(presetState(preset('securityagent', true), new Set())).toBe('taken');
  });
});

describe('latestNote', () => {
  it('says how much of the whole a capped list shows', () => {
    expect(latestNote(10, 143, 'review')).toBe('Latest 10 of 143 reviews');
    expect(latestNote(4, 4, 'review')).toBe('All 4 reviews');
    expect(latestNote(1, 1, 'review')).toBe('1 review');
  });
  it('does not claim to be everything while the total is unknown', () => {
    expect(latestNote(10, undefined, 'review')).toBe('Latest 10 reviews');
    expect(latestNote(1, undefined, 'lesson')).toBe('Latest 1 lesson');
  });
});

describe('lessonTone', () => {
  it('colours each lesson status: learned is good, working is info, a failure is critical, the rest are quiet', () => {
    expect(lessonTone('committed')).toBe('good');
    expect(lessonTone('learning')).toBe('info');
    expect(lessonTone('failed')).toBe('critical');
    expect(lessonTone('pending')).toBe('off');
    expect(lessonTone('nothing')).toBe('off');
  });
});
