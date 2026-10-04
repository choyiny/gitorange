import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { parsePolicy, PolicyError } from '../review/policy';
import type { ClassifierAnswer } from '../db/app.schema';
import {
  parseRelation,
  readDecision,
  routeDecision,
  workersAiStackModels,
  type Decision,
} from '../stack/models';
import { buildTree, type EdgeInput } from '../stack/tree';

describe('review.yml stacking', () => {
  it('is off by default', () => {
    expect(parsePolicy('model: clef\n').stacking).toEqual({
      enabled: false,
      max_open: 20,
      related_above: 0.3,
      confident_above: 0.6,
    });
  });

  it('reads every field', () => {
    expect(
      parsePolicy(
        'stacking:\n  enabled: true\n  max_open: 5\n  related_above: 0.5\n  confident_above: 0.8\n'
      ).stacking
    ).toEqual({
      enabled: true,
      max_open: 5,
      related_above: 0.5,
      confident_above: 0.8,
    });
  });

  it('rejects unknown keys and out-of-range values', () => {
    for (const bad of [
      'stacking:\n  enable: true\n',
      'stacking:\n  max_open: 1\n',
      'stacking:\n  related_above: 1.5\n',
      'stacking:\n  confident_above: -0.1\n',
    ])
      expect(() => parsePolicy(bad)).toThrow(PolicyError);
  });
});

const answers = (
  related: number,
  kind: string,
  kindConfidence: number,
  prerequisite: string,
  prerequisiteConfidence: number
): Record<string, ClassifierAnswer> => ({
  related: { type: 'noul', value: related },
  kind: {
    type: 'choice',
    value: kind,
    confidence: kindConfidence,
    probabilities: { [kind]: kindConfidence },
  },
  prerequisite: {
    type: 'choice',
    value: prerequisite,
    confidence: prerequisiteConfidence,
    probabilities: { [prerequisite]: prerequisiteConfidence },
  },
});

describe('Clef decisions', () => {
  it('reads Clef’s three answers', () => {
    expect(readDecision(answers(0.8, 'builds_on', 0.7, 'a', 0.9))).toEqual({
      related: 0.8,
      kind: 'builds_on',
      kindConfidence: 0.7,
      prerequisite: 'a',
      prerequisiteConfidence: 0.9,
    });
  });

  it('rejects missing or malformed answers', () => {
    expect(() => readDecision({})).toThrow();
    expect(() => readDecision(answers(0.8, 'blocks', 0.7, 'a', 0.9))).toThrow();
    expect(() =>
      readDecision(answers(0.8, 'builds_on', 0.7, 'c', 0.9))
    ).toThrow();
  });

  const o = {
    relatedAbove: 0.3,
    confidentAbove: 0.6,
    conflicts: false,
    aLanded: false,
  };
  const d = (over: Partial<Decision>): Decision => ({
    related: 0.9,
    kind: 'builds_on',
    kindConfidence: 0.9,
    prerequisite: 'a',
    prerequisiteConfidence: 0.9,
    ...over,
  });

  it('stops at unrelated pairs', () => {
    expect(routeDecision(d({ related: 0.2 }), o)).toEqual({
      action: 'independent',
    });
  });

  it('keeps a confident decision and only asks for words', () => {
    expect(routeDecision(d({}), o)).toEqual({
      action: 'explain',
      kind: 'builds_on',
      prerequisite: 'a',
    });
    expect(routeDecision(d({ kind: 'independent' }), o)).toEqual({
      action: 'independent',
    });
  });

  it('judges an independent answer on the kind alone', () => {
    expect(
      routeDecision(d({ kind: 'independent', prerequisiteConfidence: 0.1 }), o)
    ).toEqual({ action: 'independent' });
    expect(
      routeDecision(d({ kind: 'independent', kindConfidence: 0.5 }), o)
    ).toEqual({ action: 'decide' });
  });

  it('lets the reasoning model decide when Clef is unsure', () => {
    expect(routeDecision(d({ kindConfidence: 0.5 }), o)).toEqual({
      action: 'decide',
    });
    expect(routeDecision(d({ prerequisiteConfidence: 0.5 }), o)).toEqual({
      action: 'decide',
    });
  });

  it('treats a textual conflict as related, and never as independent', () => {
    expect(
      routeDecision(d({ related: 0.1, kind: 'independent' }), {
        ...o,
        conflicts: true,
      })
    ).toEqual({ action: 'explain', kind: 'conflicts', prerequisite: 'a' });
  });

  it('never lets a landed PR depend on an open one', () => {
    expect(
      routeDecision(d({ prerequisite: 'b' }), { ...o, aLanded: true })
    ).toEqual({ action: 'decide' });
  });
});

describe('reasoning model answers', () => {
  it('reads a relation, fenced or not', () => {
    const text =
      '{"kind":"must_account_for","prerequisite":"a","reason":"#1 adds a registry.","instructions":"Add checks."}';
    for (const t of [text, '```json\n' + text + '\n```'])
      expect(parseRelation(t, { aLanded: false })).toEqual({
        kind: 'must_account_for',
        prerequisite: 'a',
        reason: '#1 adds a registry.',
        instructions: 'Add checks.',
      });
  });

  it('normalizes independent and drops stray instructions', () => {
    expect(
      parseRelation(
        '{"kind":"independent","prerequisite":"b","reason":"Unrelated.","instructions":"x"}',
        { aLanded: false }
      )
    ).toEqual({
      kind: 'independent',
      prerequisite: null,
      reason: 'Unrelated.',
      instructions: null,
    });
  });

  it('keeps a decided kind and prerequisite whatever the explanation says', async () => {
    const AI = {
      run: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: 'builds_on',
                prerequisite: 'b',
                reason: 'Uses the registry.',
                instructions: 'Register the new setting.',
              }),
            },
          },
        ],
      }),
    };
    const models = workersAiStackModels(
      { ...env, AI, AI_GATEWAY: 'off' } as unknown as CloudflareBindings,
      { review: 'model' },
      { repositoryId: 'r', pullRequestId: 'p' }
    );
    const side = {
      number: 1,
      title: 't',
      description: '',
      summaries: '',
      diffs: '',
    };
    expect(
      await models.explain({
        a: { ...side, landed: true },
        b: { ...side, number: 2, landed: false },
        conflicts: [],
        decided: { kind: 'must_account_for', prerequisite: 'a' },
      })
    ).toEqual({
      kind: 'must_account_for',
      prerequisite: 'a',
      reason: 'Uses the registry.',
      instructions: 'Register the new setting.',
    });
  });

  it('caps instructions at 1500 characters', () => {
    const r = parseRelation(
      JSON.stringify({
        kind: 'must_account_for',
        prerequisite: 'a',
        reason: 'r',
        instructions: 'x'.repeat(3000),
      }),
      { aLanded: false }
    );
    expect(r.instructions).toHaveLength(1500);
  });

  it('rejects unknown kinds, bad prerequisites, empty reasons, and a landed PR depending on an open one', () => {
    for (const text of [
      '{"kind":"blocks","prerequisite":"a","reason":"r","instructions":null}',
      '{"kind":"builds_on","prerequisite":"c","reason":"r","instructions":null}',
      '{"kind":"builds_on","prerequisite":null,"reason":"r","instructions":null}',
      '{"kind":"builds_on","prerequisite":"a","reason":"","instructions":null}',
      'not json',
    ])
      expect(() => parseRelation(text, { aLanded: false })).toThrow();
    expect(() =>
      parseRelation(
        '{"kind":"builds_on","prerequisite":"b","reason":"r","instructions":null}',
        { aLanded: true }
      )
    ).toThrow();
  });
});

const edge = (
  a: number,
  b: number,
  kind: EdgeInput['kind'],
  prerequisite: EdgeInput['prerequisite'] = 'a',
  stage: EdgeInput['stage'] = 'done'
): EdgeInput => ({
  a,
  b,
  stage,
  kind,
  prerequisite,
  reason: `${a}-${b}`,
  instructions: kind === 'must_account_for' ? 'Do it.' : null,
  files: [],
});

describe('buildTree', () => {
  it('stacks a dependent PR on its prerequisite', () => {
    const t = buildTree([1, 2], [edge(1, 2, 'builds_on')]);
    expect(t.get(2)!.parent?.number).toBe(1);
    expect(t.get(1)!.children).toEqual([2]);
    expect(t.get(1)!.parent).toBeNull();
  });

  it('follows the direction the model chose', () => {
    const t = buildTree([1, 2], [edge(1, 2, 'builds_on', 'b')]);
    expect(t.get(1)!.parent?.number).toBe(2);
  });

  it('prefers must_account_for, then the newer prerequisite, and keeps the rest as waits-on', () => {
    const t = buildTree(
      [1, 2, 3, 4],
      [
        edge(1, 4, 'builds_on'),
        edge(2, 4, 'conflicts'),
        edge(3, 4, 'builds_on'),
      ]
    );
    expect(t.get(4)!.parent?.number).toBe(3);
    expect(
      t
        .get(4)!
        .waitsOn.map((d) => d.number)
        .sort()
    ).toEqual([1, 2]);
    const u = buildTree(
      [1, 2, 3],
      [edge(1, 3, 'must_account_for'), edge(2, 3, 'builds_on')]
    );
    expect(u.get(3)!.parent?.number).toBe(1);
    expect(u.get(3)!.mustAccountFor.map((d) => d.number)).toEqual([1]);
  });

  it('never parents on a conflict alone', () => {
    const t = buildTree([1, 2], [edge(1, 2, 'conflicts')]);
    expect(t.get(2)!.parent).toBeNull();
    expect(t.get(2)!.waitsOn.map((d) => d.number)).toEqual([1]);
  });

  it('lists a landed prerequisite only when it must be accounted for', () => {
    const t = buildTree(
      [2, 3],
      [edge(1, 2, 'must_account_for'), edge(1, 3, 'builds_on')]
    );
    expect(t.get(2)!.parent).toBeNull();
    expect(t.get(2)!.mustAccountFor).toMatchObject([
      { number: 1, landed: true, instructions: 'Do it.' },
    ]);
    expect(t.get(3)!.mustAccountFor).toEqual([]);
    expect(t.get(3)!.waitsOn).toEqual([]);
  });

  it('breaks cycles and reports them', () => {
    const t = buildTree(
      [1, 2, 3],
      [
        edge(1, 2, 'builds_on', 'a'),
        edge(2, 3, 'builds_on', 'a'),
        edge(1, 3, 'builds_on', 'b'),
      ]
    );
    for (const n of [1, 2, 3]) {
      expect(t.get(n)!.parent).toBeNull();
      expect(t.get(n)!.cycleWith.length).toBe(2);
    }
  });

  it('reports failed pairs as unchecked and ignores independent and unfinished ones', () => {
    const t = buildTree(
      [1, 2, 3],
      [
        edge(1, 2, null, null, 'failed'),
        edge(1, 3, 'independent', null),
        edge(2, 3, null, null, 'triage'),
      ]
    );
    expect(t.get(1)!.unchecked).toEqual([2]);
    expect(t.get(2)!.unchecked).toEqual([1]);
    expect(t.get(3)!.waitsOn).toEqual([]);
    expect(t.get(3)!.parent).toBeNull();
  });

  it('lists pairs still being checked as pending', () => {
    const t = buildTree(
      [2, 3, 4],
      [
        edge(2, 3, null, null, 'triage'),
        edge(1, 4, null, null, 'deep'),
        edge(2, 4, 'builds_on'),
      ]
    );
    expect(t.get(2)!.pending).toEqual([3]);
    expect(t.get(3)!.pending).toEqual([2]);
    // #1 has landed: only the open side waits.
    expect(t.get(4)!.pending).toEqual([1]);
    expect(t.get(4)!.checking).toBe(false);
  });
});
