import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { parsePolicy, PolicyError } from '../review/policy';
import type { ClassifierAnswer } from '../db/app.schema';
import {
  parseRecheck,
  parseRelation,
  readDecision,
  readOrder,
  routeDecision,
  workersAiStackModels,
  type Decision,
} from '../stack/models';
import { buildTree, type EdgeInput } from '../stack/tree';
import { linearize, type Choose } from '../stack/linearize';

describe('review.yml stacking', () => {
  it('has defaults', () => {
    expect(parsePolicy('model: clef\n').stacking).toEqual({
      max_open: 20,
      related_above: 0.3,
      confident_above: 0.6,
    });
  });

  it('reads every field', () => {
    expect(
      parsePolicy(
        'stacking:\n  max_open: 5\n  related_above: 0.5\n  confident_above: 0.8\n'
      ).stacking
    ).toEqual({
      max_open: 5,
      related_above: 0.5,
      confident_above: 0.8,
    });
  });

  it('accepts and ignores the old enabled key', () => {
    for (const old of ['true', 'false'])
      expect(
        parsePolicy(`stacking:\n  enabled: ${old}\n  max_open: 5\n`).stacking
      ).toEqual({ max_open: 5, related_above: 0.3, confident_above: 0.6 });
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

  it('without one line through the prerequisites, has no parent and waits on all', () => {
    const t = buildTree(
      [1, 2, 3, 4],
      [
        edge(1, 4, 'builds_on'),
        edge(2, 4, 'conflicts'),
        edge(3, 4, 'builds_on'),
      ]
    );
    expect(t.get(4)!.parent).toBeNull();
    expect(
      t
        .get(4)!
        .waitsOn.map((d) => d.number)
        .sort()
    ).toEqual([1, 2, 3]);
  });

  it('stacks on the prerequisite whose chain holds the others, preferring must_account_for', () => {
    const order = (a: number, b: number, forPr: number): EdgeInput => ({
      ...edge(a, b, 'ordered_after'),
      slot: 'order',
      forPr,
    });
    // #31 needs #28 and #29; #29 was ordered after #28 for it.
    const t = buildTree(
      [28, 29, 31],
      [
        edge(28, 31, 'builds_on'),
        edge(29, 31, 'must_account_for'),
        order(28, 29, 31),
      ]
    );
    expect(t.get(31)!.parent).toMatchObject({
      number: 29,
      kind: 'must_account_for',
    });
    expect(t.get(31)!.waitsOn).toEqual([]); // #28 is on #29's chain
    expect(t.get(29)!.parent).toMatchObject({
      number: 28,
      kind: 'ordered_after',
      forPr: 31,
    });
    expect(t.get(28)!.children).toEqual([29]);
  });

  it('ignores dismissed edges and marks accounted ones', () => {
    const t = buildTree(
      [1, 2, 3],
      [
        { ...edge(1, 3, 'conflicts'), dismissed: true },
        { ...edge(2, 3, 'must_account_for'), accounted: true },
      ]
    );
    expect(t.get(3)!.waitsOn).toEqual([]);
    expect(t.get(3)!.mustAccountFor).toMatchObject([
      { number: 2, accounted: true },
    ]);
    expect(t.get(3)!.parent?.number).toBe(2);
  });

  it('keeps blocking while a must_account_for is re-checked', () => {
    const t = buildTree(
      [1, 2],
      [edge(1, 2, 'must_account_for', 'a', 'recheck')]
    );
    expect(t.get(2)!.mustAccountFor).toMatchObject([
      { number: 1, accounted: false },
    ]);
    expect(t.get(2)!.pending).toEqual([]);
  });

  it('never stacks on a line that holds a prerequisite only through a conflict', () => {
    const t = buildTree(
      [1, 2, 3],
      [
        edge(1, 3, 'builds_on'),
        edge(2, 3, 'builds_on'),
        edge(1, 2, 'conflicts'), // #2 lands after #1, but isn't stacked on it
      ]
    );
    expect(t.get(3)!.parent).toBeNull();
    expect(t.get(3)!.waitsOn.map((d) => d.number)).toEqual([1, 2]);
    expect(t.get(2)!.waitsOn.map((d) => d.number)).toEqual([1]);
  });

  it('stacks on the line an order edge makes after a conflict', () => {
    const t = buildTree(
      [1, 2, 3],
      [
        edge(1, 3, 'builds_on'),
        edge(2, 3, 'builds_on'),
        edge(1, 2, 'conflicts'),
        { ...edge(1, 2, 'ordered_after'), slot: 'order', forPr: 3 },
      ]
    );
    expect(t.get(2)!.parent?.number).toBe(1);
    expect(t.get(3)!.parent?.number).toBe(2);
    expect(t.get(3)!.waitsOn).toEqual([]);
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

  it('reports a failed re-check as unchecked on the dependent, and it still blocks', () => {
    const t = buildTree(
      [1, 2],
      [
        {
          ...edge(1, 2, 'must_account_for'),
          errorMessage: 'Re-check failed: model down',
        },
      ]
    );
    expect(t.get(2)!.unchecked).toEqual([1]);
    expect(t.get(1)!.unchecked).toEqual([]);
    expect(t.get(2)!.mustAccountFor.map((d) => d.number)).toEqual([1]);
    expect(t.get(2)!.parent?.number).toBe(1);
    // Dismissed, or accounted for: nothing to retry.
    for (const extra of [{ dismissed: true }, { accounted: true }])
      expect(
        buildTree(
          [1, 2],
          [
            {
              ...edge(1, 2, 'must_account_for'),
              errorMessage: 'Re-check failed: model down',
              ...extra,
            },
          ]
        ).get(2)!.unchecked
      ).toEqual([]);
  });

  it('lists a prerequisite once in waitsOn when a verdict and an order edge both name it', () => {
    const t = buildTree(
      [1, 2],
      [
        edge(1, 2, 'conflicts'),
        { ...edge(1, 2, 'conflicts'), slot: 'order', forPr: 2 },
      ]
    );
    expect(t.get(2)!.waitsOn.map((d) => d.number)).toEqual([1]);
  });

  it('lists an unchecked PR once, and a failed order row is never unchecked', () => {
    const t = buildTree(
      [1, 2],
      [
        edge(1, 2, null, null, 'failed'),
        {
          ...edge(1, 2, 'must_account_for'),
          errorMessage: 'Re-check failed: model down',
        },
      ]
    );
    expect(t.get(2)!.unchecked).toEqual([1]);
    const order = buildTree(
      [1, 2],
      [
        {
          ...edge(1, 2, 'must_account_for'),
          slot: 'order',
          forPr: 2,
          errorMessage: 'Re-check failed: model down',
        },
      ]
    );
    expect(order.get(2)!.unchecked).toEqual([]);
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

  it('never reports an unfinished order row as unchecked or pending, nor stacks on it', () => {
    const t = buildTree(
      [1, 2],
      [
        {
          ...edge(1, 2, 'ordered_after', 'a', 'failed'),
          slot: 'order',
          forPr: 2,
        },
        {
          ...edge(1, 2, 'ordered_after', 'a', 'triage'),
          slot: 'order',
          forPr: 2,
        },
      ]
    );
    expect(t.get(2)!.unchecked).toEqual([]);
    expect(t.get(2)!.pending).toEqual([]);
    expect(t.get(2)!.parent).toBeNull();
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

describe('parseRecheck', () => {
  it('reads an answer and drops instructions once accounted for', () => {
    expect(
      parseRecheck(
        '```json\n{"accounted":true,"reason":"Adds the check.","instructions":"x"}\n```'
      )
    ).toEqual({
      accounted: true,
      reason: 'Adds the check.',
      instructions: null,
    });
    expect(
      parseRecheck(
        '{"accounted":false,"reason":"Still missing.","instructions":"Add it."}'
      )
    ).toEqual({
      accounted: false,
      reason: 'Still missing.',
      instructions: 'Add it.',
    });
  });

  it('refuses anything else', () => {
    for (const text of [
      '{"accounted":"yes","reason":"r","instructions":null}',
      '{"reason":"r","instructions":null}',
      '{"accounted":true,"reason":"","instructions":null}',
      '[]',
      'not json',
    ])
      expect(() => parseRecheck(text)).toThrow();
  });
});

describe('linearize', () => {
  const firstIs =
    (n: number): Choose =>
    async (x, y) =>
      x === n || y !== n ? x : y;

  it('adds nothing when one prerequisite’s chain already holds the others', async () => {
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([
          [29, [28]],
          [31, [28, 29]],
        ]),
        others: [],
        orders: [],
      },
      async () => {
        throw new Error('no choice needed');
      }
    );
    expect(added).toEqual([]);
  });

  it('orders two unrelated prerequisites by the choice, for the PR that needs both', async () => {
    const asked: number[][] = [];
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([[31, [28, 29]]]),
        others: [],
        orders: [],
      },
      async (x, y, forPr) => {
        asked.push([x, y, forPr]);
        return 29;
      }
    );
    expect(asked).toEqual([[29, 28, 31]]);
    expect(added).toEqual([{ before: 29, after: 28, forPr: 31 }]);
  });

  it('lets an existing relationship win over the choice, and still puts the pair in one line', async () => {
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([[31, [28, 29]]]),
        others: [{ pre: 28, dep: 29 }], // #29 conflicts with #28 and lands after it
        orders: [],
      },
      async () => {
        throw new Error('no choice needed');
      }
    );
    // A conflict sets the direction but isn't a line to stack on: the order edge is still added.
    expect(added).toEqual([{ before: 28, after: 29, forPr: 31 }]);
  });

  it('never orders a pair a maintainer refused; the dependent waits on both', async () => {
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([[31, [28, 29]]]),
        others: [],
        orders: [],
        refused: [{ before: 28, after: 29, forPr: 31 }],
      },
      async () => {
        throw new Error('no choice needed');
      }
    );
    expect(added).toEqual([]);
  });

  it('keeps one order when two dependents would choose opposite orders', async () => {
    const asked: number[] = [];
    const added = await linearize(
      {
        open: [1, 2, 8, 9],
        stackable: new Map([
          [8, [1, 2]],
          [9, [1, 2]],
        ]),
        others: [],
        orders: [],
      },
      async (x, y, forPr) => {
        asked.push(forPr);
        // #8 wants #2 first, #9 wants #1 first.
        return forPr === 8 ? (x === 2 ? x : y) : x === 1 ? x : y;
      }
    );
    expect(asked).toEqual([8]);
    expect(added).toEqual([{ before: 2, after: 1, forPr: 8 }]);
  });

  it('rolls back a chain that would close a cycle', async () => {
    const added = await linearize(
      {
        open: [1, 2, 3, 9],
        stackable: new Map([[9, [1, 2, 3]]]),
        others: [{ pre: 1, dep: 3 }], // #3 lands after #1
        orders: [],
      },
      async (x) => x // whichever is asked about goes first: chain 3, 2, 1
    );
    // 2 after 3 is fine alone, but 1 after 2 would close 1 → 2 → 3 → 1: nothing of the chain is kept.
    expect(added).toEqual([]);
  });

  it('chains three prerequisites and stays acyclic whatever the choice says', async () => {
    const added = await linearize(
      {
        open: [1, 2, 3, 9],
        stackable: new Map([[9, [1, 2, 3]]]),
        others: [],
        orders: [],
      },
      async (_x, y) => y // contrary: always the second
    );
    expect(added).toHaveLength(2);
    const after = new Map(added.map((e) => [e.after, e.before]));
    // Following "lands after" from any node ends: no cycle.
    for (const start of [1, 2, 3]) {
      const seen = new Set<number>();
      for (
        let n: number | undefined = start;
        n !== undefined;
        n = after.get(n)
      ) {
        expect(seen.has(n)).toBe(false);
        seen.add(n);
      }
    }
  });

  it('skips PRs in a dependency cycle', async () => {
    const added = await linearize(
      {
        open: [1, 2, 3, 4],
        stackable: new Map([
          [1, [2]],
          [2, [1]],
          [4, [1, 3]],
        ]),
        others: [],
        orders: [],
      },
      firstIs(3)
    );
    expect(added).toEqual([]);
  });

  it('reads Clef’s order answer', () => {
    expect(
      readOrder({
        first: {
          type: 'choice',
          value: 'b',
          confidence: 0.8,
          probabilities: { b: 0.8 },
        },
      })
    ).toEqual({ first: 'b', confidence: 0.8 });
    expect(() => readOrder({ first: { type: 'noul', value: 0.9 } })).toThrow();
    expect(() =>
      readOrder({
        first: { type: 'choice', value: 'c', confidence: 1, probabilities: {} },
      })
    ).toThrow();
  });
});
