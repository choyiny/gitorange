import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertIcon, GitBranchIcon } from '@primer/octicons-react';
import {
  api,
  qk,
  type CommitRuns,
  type Pull,
  type RepoDetail,
} from '@/lib/uiApi';
import {
  decodeEntities,
  ICON_SLOT,
  pullGraph,
  type PullGraph as Graph,
} from '@/lib/pullGraph';
import { sortReviewers } from '@/lib/pullBoard';
import { renderMermaid } from '@/lib/mermaid';
import { QueryError } from '@/components/actions/states';
import { EmptyState } from '@/components/ui/EmptyState';
import { STATE_ICON, useCommitStatuses } from '@/components/Checks';
import { AiResolutionBadge } from '@/components/PullBadges';
import { ReviewerAvatars } from '@/components/ReviewerAvatars';
import { RunStatusIcon } from '@/components/RunStatusIcon';

// The red is the one the diagram itself draws "must change for" with (src/lib/pullGraph.ts).
const LEGEND: { label: string; dash?: string; color?: string }[] = [
  { label: 'stacked on' },
  { label: 'waits on', dash: '6 4' },
  { label: 'lands after', dash: '2 3' },
  { label: 'must change for', color: '#cf222e' },
  { label: 'accounted for', dash: '6 4' },
];

function Legend() {
  return (
    <div className="pg-legend small muted" aria-label="How to read the arrows">
      {LEGEND.map((l) => (
        <span key={l.label} className="pg-key">
          <svg width="28" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="28"
              y2="4"
              style={{ stroke: l.color ?? 'currentColor' }}
              strokeWidth="2"
              strokeDasharray={l.dash}
            />
          </svg>
          {l.label}
        </span>
      ))}
      <span>Arrows point at what lands first.</span>
    </div>
  );
}

/** Decodes the labels' entity codes, as text: no markup is parsed. */
function decodeLabels(root: Element) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode())
    if (t.nodeValue) t.nodeValue = decodeEntities(t.nodeValue);
}

/** The node id pullGraph gave a rendered node (`pr12`, `m9`, `land`). */
function idOf(el: Element): string {
  return (
    el.getAttribute('data-id') ?? /flowchart-(\w+)-\d+$/.exec(el.id)?.[1] ?? ''
  );
}

/** PR number of a rendered node, from its id; never from labels. */
function numberOf(el: Element): number | null {
  const m = /^(?:pr|m)(\d+)$/.exec(idOf(el));
  return m ? Number(m[1]) : null;
}

/** What a PR's node shows under its title, as the list row does: checks, AI conflict resolution, reviewers. */
type NodeIcons = {
  checks: CommitRuns['state'] | null;
  ai: Pull['aiResolution'];
  reviewers: NonNullable<Pull['reviewers']>;
};

const MAX_REVIEWERS = 6;

/** How many icon slots the icons take: one each (a reviewer's robot is one). */
function slots(i: NodeIcons | undefined): number {
  if (!i) return 0;
  return (
    (i.checks ? 1 : 0) +
    (i.ai ? 1 : 0) +
    Math.min(i.reviewers.length, MAX_REVIEWERS)
  );
}

function IconRow({ icons }: { icons: NodeIcons }) {
  return (
    <span className="pg-icons">
      {icons.checks && (
        <span title={`Checks: ${icons.checks}`}>
          <RunStatusIcon {...STATE_ICON[icons.checks]} size={14} />
        </span>
      )}
      <AiResolutionBadge state={icons.ai} />
      <ReviewerAvatars
        reviewers={sortReviewers(icons.reviewers).slice(0, MAX_REVIEWERS)}
        size={16}
        className="reviewer-avatars pg-avatars"
      />
    </span>
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Swaps a node's icon line (the room pullGraph left, made of ICON_SLOT) for a foreignObject over the same box,
 * and returns the element the icons render into; null when the node has no such line.
 */
function iconHost(node: Element): HTMLElement | null {
  const rows = [...node.querySelectorAll('text tspan')].filter(
    (t) => t.textContent && new RegExp(`^(${ICON_SLOT})+$`).test(t.textContent)
  );
  const row = rows[rows.length - 1] as SVGTextContentElement | undefined;
  const text = row?.closest('text');
  if (!row || !text?.parentNode) return null;
  // getBBox on a tspan is the whole text's box in some browsers: measure the line from its characters instead.
  const chars = row.getNumberOfChars();
  if (!chars) return null;
  const start = row.getStartPositionOfChar(0);
  const end = row.getEndPositionOfChar(chars - 1);
  const size = parseFloat(getComputedStyle(row).fontSize) || 16;
  const height = Math.max(size * 1.25, 18);
  row.setAttribute('visibility', 'hidden');
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  // A little wider than the measured room, so the last robot is never clipped.
  fo.setAttribute('x', String(start.x - 4));
  fo.setAttribute('y', String(start.y - size * 0.95));
  fo.setAttribute('width', String(end.x - start.x + 8));
  fo.setAttribute('height', String(height));
  const transform = text.getAttribute('transform');
  if (transform) fo.setAttribute('transform', transform);
  const host = document.createElement('div');
  host.className = 'pg-icon-host';
  fo.append(host);
  text.parentNode.append(fo);
  return host;
}

function TargetGraph({
  graph,
  base,
  icons,
}: {
  graph: Graph;
  base: string;
  icons: Map<number, NodeIcons>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Where each drawn PR node's icons go (replaced with every redraw).
  const [hosts, setHosts] = useState<[number, HTMLElement][]>([]);
  const navigate = useNavigate();
  const [status, setStatus] = useState<'drawing' | 'drawn' | 'failed'>(
    'drawing'
  );
  const tipsKey = JSON.stringify(graph.tips);
  useEffect(() => {
    let live = true;
    setStatus('drawing');
    renderMermaid(graph.source).then(
      (svg) => {
        const root = ref.current;
        if (!live || !root) return;
        // Sanitized SVG into a div React renders no children into.
        root.innerHTML = svg;
        decodeLabels(root);
        // Shown now, not on the next render: the icon lines are measured below, and a hidden SVG has no layout.
        root.hidden = false;
        setStatus('drawn');
        const drawn: [number, HTMLElement][] = [];
        // Mermaid's strict mode drops `click`; nodes link to their PR here instead.
        for (const el of root.querySelectorAll('g.node')) {
          const n = numberOf(el);
          if (n === null) continue;
          const tip = graph.tips[idOf(el)];
          if (tip) {
            const title = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'title'
            );
            title.textContent = tip;
            el.prepend(title);
          }
          const host = iconHost(el);
          if (host) drawn.push([n, host]);
          const go = () => navigate(`${base}/pull/${n}`);
          el.setAttribute('role', 'link');
          el.setAttribute('tabindex', '0');
          // The state and its reasons, which sighted mouse users get as hover text, for keyboard and screen readers.
          el.setAttribute(
            'aria-label',
            tip ? tip.replace(/\n/g, '. ') : `Pull request #${n}`
          );
          (el as SVGElement).style.cursor = 'pointer';
          el.addEventListener('click', go);
          el.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') go();
          });
        }
        setHosts(drawn);
      },
      () => live && setStatus('failed')
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw when the text changes, not on every refetch
  }, [graph.source, tipsKey, base, navigate]);
  return (
    <section
      className="panel pg-target"
      aria-label={`Landing on ${graph.target}`}
    >
      <header className="pg-head">
        <GitBranchIcon size={16} />
        <strong className="pg-branch">{graph.target}</strong>
        {graph.landed.length > 0 && (
          <span className="small muted">
            recently landed:{' '}
            {graph.landed.map((l, i) => (
              <span key={l.number}>
                {i > 0 && ', '}
                <Link to={`${base}/pull/${l.number}`} title={l.title}>
                  #{l.number}
                </Link>
              </span>
            ))}
          </span>
        )}
      </header>
      {graph.cycles.length > 0 && (
        <div className="callout pg-cycle" role="status">
          <AlertIcon size={16} />
          <span>
            {graph.cycles.map((c) => `#${c}`).join(', ')} depend on each other
            in a circle (outlined in red), so none of them can land until one of
            those dependencies is dismissed.
          </span>
        </div>
      )}
      {status === 'failed' && (
        <p className="pg-note small muted">This graph couldn't be drawn.</p>
      )}
      {status === 'drawing' && (
        <div className="sk sk-block" role="status" aria-label="Drawing" />
      )}
      <div ref={ref} className="pull-graph" hidden={status !== 'drawn'} />
      {hosts.map(([n, host]) => {
        const i = icons.get(n);
        return i ? createPortal(<IconRow icons={i} />, host, `pr${n}`) : null;
      })}
    </section>
  );
}

/** Open pull requests as a graph per land target: how they're slated to land. */
export function PullGraph({ repo }: { repo: RepoDetail }) {
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.pullTree(o, repo.name),
    queryFn: () => api.pullTree(o, repo.name),
  });
  // The list's own data (the same queries, so the cache is shared): reviewers and AI resolution, then checks.
  const open = useQuery({
    queryKey: qk.pulls(o, repo.name, 'open'),
    queryFn: () => api.pulls(o, repo.name, 'open'),
  });
  const statuses = useCommitStatuses(
    repo,
    (open.data?.pulls ?? []).map((p) => p.headSha)
  );
  const icons = useMemo(() => {
    const m = new Map<number, NodeIcons>();
    for (const p of open.data?.pulls ?? [])
      m.set(p.number, {
        checks: (p.headSha && statuses.data?.[p.headSha]?.state) || null,
        ai: p.aiResolution,
        reviewers: p.reviewers ?? [],
      });
    return m;
  }, [open.data, statuses.data]);
  const graphs = useMemo(
    () => (q.data ? pullGraph(q.data, (n) => slots(icons.get(n))) : null),
    [q.data, icons]
  );
  const base = `/${repo.fullName}`;
  if (q.isError && !graphs)
    return (
      <div className="panel">
        <QueryError
          error={q.error}
          onRetry={() => void q.refetch()}
          title="The graph did not load"
        />
      </div>
    );
  if (!graphs)
    return (
      <div className="pg" role="status" aria-busy="true" aria-label="Loading">
        <div className="sk sk-line w50" />
        <div className="sk sk-block" />
      </div>
    );
  if (!graphs.length)
    return (
      <div className="panel">
        <EmptyState
          picture={<GitBranchIcon size={24} />}
          title="Nothing is slated to land."
          body="Open pull requests show up here, flowing into their target branch."
        />
      </div>
    );
  return (
    <div className="pg">
      <Legend />
      {graphs.map((g) => (
        <TargetGraph key={g.target} graph={g} base={base} icons={icons} />
      ))}
    </div>
  );
}
