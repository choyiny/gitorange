import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_KINDS,
  actorRole,
  agentKindLabel,
  formatCost,
  formatTokens,
  isAgentKind,
  modelsOf,
  parseActionsView,
  runActor,
  runAvatarStatus,
  runOutcome,
  runStatusLook,
} from './agentRuns';
import { avatarState } from './agentLook';

describe('kinds', () => {
  it('names the six kinds the server records, in the order the page lists them', () => {
    expect(AGENT_RUN_KINDS.map((k) => k.kind)).toEqual([
      'review',
      'rebase',
      'conflict_resolution',
      'stack_discovery',
      'sweep',
      'learning',
    ]);
    expect(agentKindLabel('stack_discovery')).toBe('Stack discovery');
    expect(agentKindLabel('conflict_resolution')).toBe(
      'Conflict resolution (squash-era)'
    );
  });
  it('recognises a kind from the URL and nothing else', () => {
    expect(isAgentKind('learning')).toBe(true);
    expect(isAgentKind('all')).toBe(false);
    expect(isAgentKind(null)).toBe(false);
    expect(isAgentKind('')).toBe(false);
  });
});

describe('parseActionsView', () => {
  const view = (qs: string) => parseActionsView(new URLSearchParams(qs));
  it('shows workflow runs by default, with the filter and page from the URL', () => {
    expect(view('')).toEqual({ mode: 'workflows', workflow: '', page: 1 });
    expect(view('workflow=.github/workflows/ci.yml&page=3')).toEqual({
      mode: 'workflows',
      workflow: '.github/workflows/ci.yml',
      page: 3,
    });
  });
  it('clamps a bad page to 1', () => {
    for (const qs of ['page=0', 'page=-4', 'page=abc'])
      expect(view(qs)).toMatchObject({ mode: 'workflows', page: 1 });
  });
  it('opens Agent runs for a kind, or for all of them', () => {
    expect(view('agent=review')).toEqual({ mode: 'agents', kind: 'review' });
    expect(view('agent=all')).toEqual({ mode: 'agents', kind: null });
  });
  it('treats an unknown agent kind as the workflow list, like before', () => {
    expect(view('agent=bogus').mode).toBe('workflows');
  });
});

describe('runActor: who did the work', () => {
  it('Clef routes reviews and stacks pull requests', () => {
    expect(
      runActor({ kind: 'review', title: 'Review of 1a2b3c4' })
    ).toMatchObject({ id: 'clef', handle: 'clef', builtin: true });
    expect(
      runActor({ kind: 'stack_discovery', title: 'Stack discovery for #9' })
    ).toMatchObject({ id: 'clef', builtin: true });
    expect(
      runActor({ kind: 'sweep', title: 'Sweep after a push to main' })
    ).toMatchObject({ id: 'clef' });
  });
  it('Fixer rebases and resolves conflicts', () => {
    expect(
      runActor({ kind: 'rebase', title: 'Rebase #4 onto main' })
    ).toMatchObject({ id: 'fixer', handle: 'fixer', builtin: true });
    expect(
      runActor({
        kind: 'conflict_resolution',
        title: 'Resolve conflicts with main',
      })
    ).toMatchObject({ id: 'fixer' });
  });
  it('a reviewer agent reviews and learns, named in the run title', () => {
    expect(
      runActor({ kind: 'review', title: 'Review by @securityagent of 1a2b3c4' })
    ).toEqual({
      id: 'reviewer',
      handle: 'securityagent',
      builtin: false,
    });
    expect(
      runActor({ kind: 'learning', title: '@data-agent learns from #67' })
    ).toEqual({ id: 'reviewer', handle: 'data-agent', builtin: false });
  });
  it('is null when a learning run does not name its agent', () => {
    expect(runActor({ kind: 'learning', title: 'Something else' })).toBeNull();
  });
});

describe('actorRole', () => {
  it('says in plain words what each did', () => {
    expect(actorRole({ kind: 'review', title: 'Review of 1a2b3c4' })).toBe(
      'Decides which reviewers to ask'
    );
    expect(
      actorRole({
        kind: 'review',
        title: 'Review by @securityagent of 1a2b3c4',
      })
    ).toBe('Reviews the change');
    expect(actorRole({ kind: 'rebase', title: 'Rebase #4 onto main' })).toBe(
      'Rebases the branch'
    );
    expect(
      actorRole({ kind: 'conflict_resolution', title: 'Resolve conflicts' })
    ).toBe('Resolves conflicts');
    expect(
      actorRole({ kind: 'stack_discovery', title: 'Stack discovery for #9' })
    ).toBe('Works out how pull requests fit together');
    expect(actorRole({ kind: 'sweep', title: 'Sweep after a push' })).toBe(
      'Re-checks open pull requests'
    );
    expect(
      actorRole({ kind: 'learning', title: '@data-agent learns from #67' })
    ).toBe('Learns from dismissed requests');
  });
});

describe('run status', () => {
  it('running shows the working avatar, failed the failure face, finished a pass', () => {
    expect(avatarState(runAvatarStatus('running'))).toBe('startWaiting');
    expect(avatarState(runAvatarStatus('failed'))).toBe('error');
    expect(avatarState(runAvatarStatus('succeeded'))).toBe('success');
  });
  it('chips always carry words', () => {
    expect(runStatusLook('running')).toEqual({
      tone: 'info',
      label: 'Running',
    });
    expect(runStatusLook('succeeded')).toEqual({
      tone: 'good',
      label: 'Finished',
    });
    expect(runStatusLook('failed')).toEqual({
      tone: 'critical',
      label: 'Failed',
    });
  });
});

describe('runOutcome', () => {
  const step = (over: Partial<Parameters<typeof runOutcome>[1][number]>) => ({
    decision: null,
    error: null,
    ...over,
  });
  it('is the run error when it failed', () => {
    expect(
      runOutcome({ status: 'failed', error: 'Model timed out' }, [
        step({ decision: 'earlier decision' }),
      ])
    ).toBe('Model timed out');
  });
  it('falls back to the last failing step when the run has no error text', () => {
    expect(
      runOutcome({ status: 'failed', error: null }, [
        step({}),
        step({ error: 'Push rejected' }),
      ])
    ).toBe('Push rejected');
  });
  it('is the last decision a step recorded when it finished', () => {
    expect(
      runOutcome({ status: 'succeeded', error: null }, [
        step({ decision: 'first' }),
        step({ decision: 'Ordered #77 after #76.' }),
        step({}),
      ])
    ).toBe('Ordered #77 after #76.');
  });
  it('says nothing was recorded, or that it is still going', () => {
    expect(runOutcome({ status: 'succeeded', error: null }, [step({})])).toBe(
      null
    );
    expect(runOutcome({ status: 'running', error: null }, [])).toBe(
      'Still working.'
    );
  });
});

describe('formatting', () => {
  it('shows dollars with enough places for fractions of a cent', () => {
    expect(formatCost(null)).toBe('');
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.00001)).toBe('<$0.0001');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.1234)).toBe('$0.123');
    expect(formatCost(12.3456)).toBe('$12.35');
  });
  it('groups token counts', () => {
    expect(formatTokens(38125)).toBe('38,125');
  });
  it('lists each model once, without the Workers AI prefix', () => {
    expect(
      modelsOf([
        { model: '@cf/zai/glm-5.3' },
        { model: null },
        { model: '@cf/zai/glm-5.3, @cf/meta/clef' },
      ])
    ).toEqual(['zai/glm-5.3', 'meta/clef']);
  });
});
