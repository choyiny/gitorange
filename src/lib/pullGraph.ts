import type { PullStateName, StackDependency, StackTree } from './uiApi';

/** One Mermaid flowchart per land target: how its open pull requests are slated to land. */
export type PullGraph = {
  target: string;
  source: string;
  /** Open PRs that depend on each other in a circle. */
  cycles: number[];
};

// Kept as-is inside a quoted label; everything else becomes a Mermaid entity code (#NN;).
const SAFE = /[\p{L}\p{N} .,:!?'/_+=()@-]/u;
// Words Mermaid gives meaning to: their first letter is encoded too, though a quoted label can't run them.
const KEYWORDS =
  /click|call|href|javascript|classdef|class|style|init|securitylevel|subgraph|direction/gi;

/**
 * Untrusted text (a PR title, a branch name) as the inside of a quoted Mermaid label: one line, no quote,
 * bracket, pipe, backtick, angle bracket, `%` or `#`, so it can't close the label, add a directive, a
 * statement, a link or styling. Mermaid decodes the entity codes back into the same characters as text.
 */
export function mermaidText(s: string): string {
  const flat = s.replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '');
  const marks = new Set([...flat.matchAll(KEYWORDS)].map((m) => m.index));
  let out = '';
  let i = 0;
  for (const ch of flat) {
    out += SAFE.test(ch) && !marks.has(i) ? ch : `#${ch.codePointAt(0)};`;
    i += ch.length;
  }
  return out;
}

/**
 * Mermaid turns `#NN;` into `&#NN;` but, with htmlLabels off, draws that as literal text. Decodes it back, in one
 * pass, so a title that itself contains `&#35;` (encoded as `#38;#35;`) still reads `&#35;`.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&#(\d{1,7});/g, (m, n: string) => {
    const cp = Number(n);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

const MAX_TITLE = 40;
function truncate(s: string): string {
  const cps = [...s];
  return cps.length > MAX_TITLE
    ? `${cps.slice(0, MAX_TITLE - 1).join('')}…`
    : s;
}

const label = (text: string) => `["${mermaidText(text)}"]`;

const CLASS: Record<PullStateName, string> = {
  ready: 'ready',
  waiting: 'waiting',
  agent_followup: 'agent',
  human_review: 'person',
};

// Primer's Label colours for each state (see STATE_CLASS), plus the land target and merged PRs.
const CLASS_DEFS = [
  'classDef ready fill:#dafbe1,stroke:#1a7f37,color:#1f2328',
  'classDef waiting fill:#f6f8fa,stroke:#818b98,color:#1f2328',
  'classDef agent fill:#fff8c5,stroke:#9a6700,color:#1f2328',
  'classDef person fill:#fff1e5,stroke:#bc4c00,color:#1f2328',
  'classDef target fill:#ddf4ff,stroke:#0969da,color:#1f2328',
  'classDef merged fill:#fbefff,stroke:#8250df,color:#1f2328',
];

const RED = 'stroke:#cf222e,stroke-width:2px';
const DASHED = 'stroke-dasharray:6 4';
const DOTTED = 'stroke-dasharray:2 3';

type Edge = { arrow: string; style: string | null };

/** How an edge from a PR to `d` (something that lands before it) is drawn. */
function edgeFor(d: StackDependency, as: 'parent' | 'wait' | 'account'): Edge {
  if (d.kind === 'ordered_after')
    return { arrow: '-.->|lands after|', style: DOTTED };
  if (d.kind === 'must_account_for' && !d.accounted)
    return { arrow: '-->|must change for|', style: RED };
  if (as === 'parent') return { arrow: '-->|stacked on|', style: null };
  if (as === 'account') return { arrow: '-.->|accounted for|', style: DASHED };
  return { arrow: '-.->|waits on|', style: DASHED };
}

/**
 * The Mermaid source of each land target's graph. Arrows point from a PR to what must land before it (the PR
 * it's stacked on, waits on, lands after or must change for), and every PR with nothing ahead of it points
 * into its land target, so each graph flows down into the branch. Node ids carry only PR numbers
 * (`pr12`, `m9` for a merged PR, `land`); the page attaches navigation after rendering.
 */
export function pullGraph(tree: StackTree): PullGraph[] {
  return tree.targets.map((t) => {
    const open = new Set(t.nodes.map((n) => n.number));
    const landedTitle = new Map(t.landed.map((l) => [l.number, l.title]));
    const nodeLines = [`  land${label(t.branch)}`];
    for (const n of t.nodes)
      nodeLines.push(
        `  pr${n.number}${label(`#${n.number} ${truncate(n.title)}`)}`
      );
    const extra = new Set<string>();
    const idOf = (d: StackDependency) => {
      const id = d.landed ? `m${d.number}` : `pr${d.number}`;
      if (!open.has(d.number) && !extra.has(id)) {
        extra.add(id);
        const title = landedTitle.get(d.number);
        nodeLines.push(
          `  ${id}${label(
            `#${d.number}${title ? ` ${truncate(title)}` : ''}${d.landed ? ' (merged)' : ''}`
          )}`
        );
      }
      return id;
    };
    const edges: string[] = [];
    const styles: string[] = [];
    const add = (from: string, e: Edge, to: string) => {
      if (e.style) styles.push(`  linkStyle ${edges.length} ${e.style}`);
      edges.push(`  ${from} ${e.arrow} ${to}`);
    };
    for (const n of t.nodes) {
      const from = `pr${n.number}`;
      const drawn = new Set<number>();
      if (!n.parent && n.waitsOn.length === 0)
        add(from, { arrow: '-->', style: null }, 'land');
      if (n.parent) {
        drawn.add(n.parent.number);
        add(from, edgeFor(n.parent, 'parent'), idOf(n.parent));
      }
      for (const d of n.waitsOn) {
        if (drawn.has(d.number)) continue;
        drawn.add(d.number);
        add(from, edgeFor(d, 'wait'), idOf(d));
      }
      for (const d of n.mustAccountFor) {
        // Open ones already accounted for sit in the PR's chain: nothing more to say.
        if (drawn.has(d.number) || (!d.landed && d.accounted)) continue;
        drawn.add(d.number);
        add(from, edgeFor(d, 'account'), idOf(d));
      }
    }
    const classes = [
      '  class land target',
      ...[...extra]
        .filter((id) => id.startsWith('m'))
        .map((id) => `  class ${id} merged`),
      ...t.nodes.flatMap((n) =>
        n.pullState ? [`  class pr${n.number} ${CLASS[n.pullState.state]}`] : []
      ),
    ];
    const cycles = t.nodes
      .filter((n) => n.cycleWith.length > 0)
      .map((n) => n.number)
      .sort((x, y) => x - y);
    const source = [
      '---',
      'config:',
      '  htmlLabels: false',
      '  flowchart:',
      '    htmlLabels: false',
      '---',
      'flowchart TD',
      ...nodeLines,
      ...edges,
      ...CLASS_DEFS.map((c) => `  ${c}`),
      ...classes,
      ...cycles.map(
        (c) =>
          `  style pr${c} stroke:#cf222e,stroke-width:3px,stroke-dasharray:5 3`
      ),
      ...styles,
    ].join('\n');
    return { target: t.branch, source, cycles };
  });
}
