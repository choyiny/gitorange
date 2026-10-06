import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertIcon, GitBranchIcon } from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import {
  decodeEntities,
  pullGraph,
  type PullGraph as Graph,
} from '@/lib/pullGraph';
import { renderMermaid } from '@/lib/mermaid';
import { Spinner } from './Spinner';

const LEGEND: { label: string; dash?: string; color?: string }[] = [
  { label: 'stacked on' },
  { label: 'waits on', dash: '6 4' },
  { label: 'lands after', dash: '2 3' },
  { label: 'must change for', color: '#cf222e' },
  { label: 'accounted for', dash: '6 4' },
];

function Legend() {
  return (
    <div
      className="d-flex flex-wrap flex-items-center f6 color-fg-muted px-3 pt-2"
      style={{ gap: 16 }}
    >
      {LEGEND.map((l) => (
        <span
          key={l.label}
          className="d-inline-flex flex-items-center"
          style={{ gap: 4 }}
        >
          <svg width="28" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="28"
              y2="4"
              stroke={l.color ?? 'currentColor'}
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

/** PR number of a rendered node, from the node ids pullGraph gives (`pr12`, `m9`); never from labels. */
function numberOf(el: Element): number | null {
  const id =
    el.getAttribute('data-id') ?? /flowchart-(\w+)-\d+$/.exec(el.id)?.[1] ?? '';
  const m = /^(?:pr|m)(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

function TargetGraph({ graph, base }: { graph: Graph; base: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [status, setStatus] = useState<'drawing' | 'drawn' | 'failed'>(
    'drawing'
  );
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
  }, [graph.source, base, navigate]);
  return (
    <div className="mb-3">
      <div
        className="Box-row d-flex flex-items-center color-bg-subtle"
        style={{ gap: 6 }}
      >
        <GitBranchIcon />{' '}
        <strong className="wb-break-word">{graph.target}</strong>
      </div>
      {graph.cycles.length > 0 && (
        <div className="flash flash-warn mx-3 mt-3">
          <AlertIcon /> {graph.cycles.map((c) => `#${c}`).join(', ')} depend on
          each other in a circle (outlined in red), so none of them can land
          until one of those dependencies is dismissed.
        </div>
      )}
      {status === 'failed' && (
        <div className="f6 color-fg-muted p-3">
          This graph couldn't be drawn.
        </div>
      )}
      {status === 'drawing' && <Spinner />}
      <div ref={ref} className="pull-graph" hidden={status !== 'drawn'} />
    </div>
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
  if (q.isError)
    return (
      <div className="flash flash-error m-3">
        Couldn't load the graph: {errorMessage(q.error)}
      </div>
    );
  if (!graphs) return <Spinner />;
  if (!graphs.length)
    return (
      <div className="blankslate">
        <GitBranchIcon size={24} className="color-fg-muted mb-2" />
        <h3 className="blankslate-heading">Nothing is slated to land.</h3>
        <p>
          Open pull requests show up here, flowing into their target branch.
        </p>
      </div>
    );
  return (
    <>
      <Legend />
      {graphs.map((g) => (
        <TargetGraph key={g.target} graph={g} base={base} />
      ))}
    </>
  );
}
