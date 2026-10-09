import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertIcon, GitBranchIcon } from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import {
  decodeEntities,
  pullGraph,
  type PullGraph as Graph,
} from '@/lib/pullGraph';
import { renderMermaid } from '@/lib/mermaid';
import { QueryError } from '@/components/actions/states';
import { EmptyState } from '@/components/ui/EmptyState';

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

function TargetGraph({ graph, base }: { graph: Graph; base: string }) {
  const ref = useRef<HTMLDivElement>(null);
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
        setStatus('drawn');
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
          const go = () => navigate(`${base}/pull/${n}`);
          el.setAttribute('role', 'link');
          el.setAttribute('tabindex', '0');
          el.setAttribute('aria-label', `Pull request #${n}`);
          (el as SVGElement).style.cursor = 'pointer';
          el.addEventListener('click', go);
          el.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') go();
          });
        }
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
  const graphs = useMemo(() => (q.data ? pullGraph(q.data) : null), [q.data]);
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
        <TargetGraph key={g.target} graph={g} base={base} />
      ))}
    </div>
  );
}
