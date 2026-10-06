import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  mermaidText,
  nodeTooltip,
  pullGraph,
} from './pullGraph';
import type { StackDependency, StackTree } from './uiApi';

type Node = StackTree['targets'][number]['nodes'][number];

const dep = (
  number: number,
  kind: StackDependency['kind'],
  extra: Partial<StackDependency> = {}
): StackDependency => ({
  number,
  kind,
  reason: '',
  instructions: null,
  landed: false,
  files: [],
  accounted: false,
  forPr: null,
  ...extra,
});

const node = (number: number, extra: Partial<Node> = {}): Node => ({
  number,
  parent: null,
  children: [],
  waitsOn: [],
  mustAccountFor: [],
  cycleWith: [],
  unchecked: [],
  pending: [],
  checking: false,
  title: `PR ${number}`,
  headRef: `branch-${number}`,
  author: { id: 'u', username: 'u', name: 'U', image: null },
  pullState: { state: 'ready', reasons: [] },
  ...extra,
});

const tree = (
  ...targets: {
    branch: string;
    nodes: Node[];
    landed?: { number: number; title: string }[];
  }[]
): StackTree => ({
  targets: targets.map((t) => ({ landed: [], ...t })),
});

/** Edge statements, in order (their index is what linkStyle refers to). */
const edges = (source: string) =>
  source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\w+ (-->|-\.->)/.test(l));
const styleOf = (source: string, i: number) =>
  source
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`linkStyle ${i} `)) ?? '';

describe('pullGraph', () => {
  it('is empty when nothing is open', () => {
    expect(pullGraph({ targets: [] })).toEqual([]);
  });

  it('draws a flowchart whose PRs with nothing ahead point into the land target', () => {
    const [g] = pullGraph(tree({ branch: 'main', nodes: [node(1), node(2)] }));
    expect(g.target).toBe('main');
    expect(g.source).toMatch(/flowchart TD/);
    expect(g.source).toContain('land["main"]');
    expect(edges(g.source)).toEqual(['pr1 --> land', 'pr2 --> land']);
    expect(g.source).toContain('pr1["#35;1 PR 1"]');
  });

  it('turns off HTML labels', () => {
    const [g] = pullGraph(tree({ branch: 'main', nodes: [node(1)] }));
    expect(g.source).toMatch(/htmlLabels: false/);
  });

  it('styles each relationship, pointing from a PR to what lands before it', () => {
    const [g] = pullGraph(
      tree({
        branch: 'main',
        nodes: [
          node(1),
          node(2, { parent: dep(1, 'builds_on') }),
          node(3, {
            parent: dep(1, 'builds_on'),
            waitsOn: [dep(2, 'conflicts')],
          }),
          node(4, { parent: dep(2, 'ordered_after', { forPr: 5 }) }),
          node(5, {
            mustAccountFor: [dep(9, 'must_account_for', { landed: true })],
          }),
        ],
        landed: [{ number: 9, title: 'Merged thing' }],
      })
    );
    const es = edges(g.source);
    const at = (line: string) => {
      const i = es.indexOf(line);
      expect(es).toContain(line);
      return i;
    };
    // stacked on: solid
    const stacked = at('pr2 -->|stacked on| pr1');
    expect(styleOf(g.source, stacked)).toBe('');
    // waits on: dashed
    expect(styleOf(g.source, at('pr3 -.->|waits on| pr2'))).toMatch(
      /stroke-dasharray:\s*6 4/
    );
    // ordered after: dotted, its own label
    expect(styleOf(g.source, at('pr4 -.->|lands after| pr2'))).toMatch(
      /stroke-dasharray:\s*2 3/
    );
    // must account for a merged PR: red, into a node for the merged PR
    expect(styleOf(g.source, at('pr5 -->|must change for| m9'))).toMatch(
      /stroke:#cf222e/
    );
    expect(g.source).toContain('m9["#35;9 Merged thing (merged)"]');
    // Only PRs with nothing ahead point into main (#5's prerequisite already landed).
    expect(es.filter((e) => e.endsWith('land'))).toEqual([
      'pr1 --> land',
      'pr5 --> land',
    ]);
  });

  it('colours nodes by state and links nothing itself', () => {
    const [g] = pullGraph(
      tree({
        branch: 'main',
        nodes: [
          node(1, { pullState: { state: 'ready', reasons: [] } }),
          node(2, { pullState: { state: 'waiting', reasons: [] } }),
          node(3, { pullState: { state: 'agent_followup', reasons: [] } }),
          node(4, { pullState: { state: 'human_review', reasons: [] } }),
          node(5, { pullState: null }),
        ],
      })
    );
    expect(g.source).toContain('class pr1 ready');
    expect(g.source).toContain('class pr2 waiting');
    expect(g.source).toContain('class pr3 agent');
    expect(g.source).toContain('class pr4 person');
    expect(g.source).not.toContain('class pr5 ');
    for (const c of ['ready', 'waiting', 'agent', 'person'])
      expect(g.source).toMatch(new RegExp(`classDef ${c} `));
    // Navigation is attached after render, from node ids; the source has no links.
    expect(g.source).not.toMatch(/\bclick\b|href|javascript/i);
  });

  it('draws one graph per land target, each ending at its branch', () => {
    const gs = pullGraph(
      tree(
        { branch: 'main', nodes: [node(1)] },
        {
          branch: 'release',
          nodes: [node(2), node(3, { parent: dep(2, 'builds_on') })],
        }
      )
    );
    expect(gs.map((g) => g.target)).toEqual(['main', 'release']);
    expect(gs[1].source).toContain('land["release"]');
    expect(edges(gs[1].source)).toEqual([
      'pr2 --> land',
      'pr3 -->|stacked on| pr2',
    ]);
    expect(gs[0].source).not.toContain('pr2');
  });

  it('outlines PRs in a cycle and reports them', () => {
    const [g] = pullGraph(
      tree({
        branch: 'main',
        nodes: [
          node(1, { cycleWith: [2] }),
          node(2, { cycleWith: [1] }),
          node(3),
        ],
      })
    );
    expect(g.cycles).toEqual([1, 2]);
    expect(g.source).toMatch(/style pr1 [^\n]*stroke:#cf222e/);
    expect(g.source).toMatch(/style pr2 [^\n]*stroke:#cf222e/);
    expect(g.source).not.toMatch(/style pr3 /);
  });

  it('cannot be steered by a malicious title or branch name', () => {
    const evil = '"]-->x; click x "javascript:alert(1)"';
    const [g] = pullGraph(
      tree({
        branch: 'main"]\nclick land "javascript:alert(2)"',
        nodes: [
          node(1, { title: evil }),
          node(2, { title: '%%{init: {"securityLevel": "loose"}}%%' }),
          node(3, {
            title: 'a\n  classDef ready fill:#f00\n  style pr1 fill:red',
          }),
          node(4, {
            title: 'x`**bold**` <img src=x onerror=alert(1)> [a]{b}|c|',
          }),
        ],
      })
    );
    const lines = g.source.split('\n');
    // Every label is one quoted string with no quote, bracket, pipe, angle, backtick or percent inside.
    for (const l of lines.filter((l) => /^\s*(pr\d+|land|m\d+)\[/.test(l)))
      expect(l.trim()).toMatch(/^\w+\["[^"[\]{}|<>`%\n]*"\]$/);
    expect(g.source).not.toContain('%%');
    expect(g.source).not.toMatch(/\bclick\b|javascript:|securityLevel/i);
    expect(lines.filter((l) => /^\s*classDef ready/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /^\s*style pr1/.test(l))).toBe(false);
    // The injected text never adds edges or nodes of its own.
    expect(edges(g.source)).toEqual([
      'pr1 --> land',
      'pr2 --> land',
      'pr3 --> land',
      'pr4 --> land',
    ]);
  });

  it('truncates long titles to about 40 characters', () => {
    const [g] = pullGraph(
      tree({ branch: 'main', nodes: [node(1, { title: 'a'.repeat(100) })] })
    );
    const label = g.source.match(/pr1\["([^"]*)"\]/)![1];
    expect(label).toBe(`#35;1 ${'a'.repeat(39)}#8230;`);
  });
});

describe('mermaidText', () => {
  it('keeps letters, digits and plain punctuation, and encodes the rest', () => {
    expect(mermaidText('Fix: café (v2), done!')).toBe('Fix: café (v2), done!');
    expect(mermaidText('a"b<c>`d')).toBe('a#34;b#60;c#62;#96;d');
    expect(mermaidText('50% #1;')).toBe('50#37; #35;1#59;');
    expect(mermaidText('line\nbreak\ttab')).toBe('line break tab');
  });
});

describe('decodeEntities', () => {
  it('reads labels as their titles again', () => {
    expect(decodeEntities('&#35;12 a &#60;b&#62; &#34;c&#34; t&#8230;')).toBe(
      '#12 a <b> "c" t…'
    );
  });
  it('decodes once, so encoded entity text stays literal', () => {
    // A title of `&#35;` is encoded as `#38;#35;`, which Mermaid draws as `&#38;#35;`.
    expect(decodeEntities('&#38;#35;')).toBe('&#35;');
  });
  it('leaves out-of-range codes alone', () => {
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
});

describe('nodeTooltip', () => {
  it('lists the basics and the state with its reasons', () => {
    const t = nodeTooltip(
      node(3, {
        pullState: {
          state: 'human_review',
          reasons: [{ kind: 'changes_requested', flags: 2 }],
        },
      })
    ).split('\n');
    expect(t[0]).toBe('#3 PR 3');
    expect(t[1]).toBe('branch-3 · @u');
    expect(t[2]).toMatch(/changes requested on 2 flags/);
  });

  it('describes each dependency kind, pending, unchecked and checking', () => {
    const t = nodeTooltip(
      node(3, {
        parent: dep(1, 'builds_on', { reason: 'adds the helper' }),
        waitsOn: [
          dep(2, 'conflicts', { reason: 'same lines' }),
          dep(4, 'ordered_after'),
        ],
        mustAccountFor: [
          dep(5, 'must_account_for', { reason: 'renames it' }),
          dep(6, 'must_account_for', { reason: 'moves it', accounted: true }),
        ],
        pending: [7],
        unchecked: [8],
        checking: true,
      })
    ).split('\n');
    expect(t).toEqual(
      expect.arrayContaining([
        'stacked on #1: adds the helper',
        'waits on #2: same lines',
        'lands after #4',
        'must change for #5: renames it',
        'must change for #6: moves it (accounted for)',
        'checking #7…',
        "couldn't check against #8",
        'checking…',
      ])
    );
  });

  it('returns markup-like titles verbatim', () => {
    expect(
      nodeTooltip(node(1, { title: '<script>alert(1)</script>' }))
    ).toMatch(/^#1 <script>alert\(1\)<\/script>\n/);
  });

  it('is exposed per node id, merged ones marked', () => {
    const g = pullGraph(
      tree({
        branch: 'main',
        nodes: [node(2, { parent: dep(1, 'builds_on', { landed: true }) })],
      })
    )[0];
    expect(g.tips.pr2).toContain('#2 PR 2');
    expect(g.tips.m1).toBe('#1 (merged)');
  });
});
