import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertIcon, GitBranchIcon, GitMergeIcon } from '@primer/octicons-react';
import { api, qk, type RepoDetail, type StackDependency } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { treeRows } from '@/lib/stackTree';
import { Spinner } from './Spinner';

const KIND: Record<StackDependency['kind'], string> = {
  builds_on: 'builds on',
  must_account_for: 'must change for',
  conflicts: 'conflicts with',
  independent: 'independent of',
};

function DepChip({ d, base }: { d: StackDependency; base: string }) {
  return (
    <Link
      to={`${base}/pull/${d.number}`}
      title={d.reason}
      className={`Label mr-1 ${d.kind === 'must_account_for' ? 'Label--attention' : 'Label--secondary'}`}
    >
      {KIND[d.kind]} #{d.number}
      {d.landed ? ' (landed)' : ''}
    </Link>
  );
}

/** Open pull requests as a tree per target branch: who builds on whom, and why. */
export function StackTree({ repo }: { repo: RepoDetail }) {
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.pullTree(o, repo.name),
    queryFn: () => api.pullTree(o, repo.name),
  });
  const base = `/${repo.fullName}`;
  if (q.isError)
    return (
      <div className="flash flash-error m-3">
        Couldn't load the tree: {errorMessage(q.error)}
      </div>
    );
  if (!q.data) return <Spinner />;
  if (q.data.stacking && !q.data.targets.length)
    return (
      <div className="blankslate">
        <GitBranchIcon size={24} className="color-fg-muted mb-2" />
        <h3 className="blankslate-heading">No open pull requests</h3>
        <p>Open pull requests show up here, stacked on what they build on.</p>
      </div>
    );
  if (!q.data.targets.length)
    return (
      <div className="blankslate">
        <GitBranchIcon size={24} className="color-fg-muted mb-2" />
        <h3 className="blankslate-heading">Stacking is off</h3>
        <p>
          Add{' '}
          <code>
            stacking: {'{'} enabled: true {'}'}
          </code>{' '}
          to <code>.gitorange/review.yml</code> on the target branch, and
          GitOrange works out how open pull requests build on each other.
        </p>
      </div>
    );
  return (
    <>
      {q.data.targets.map((t) => (
        <div key={t.branch} className="mb-3">
          <div
            className="Box-row d-flex flex-wrap flex-items-center color-bg-subtle"
            style={{ gap: 6 }}
          >
            <GitBranchIcon /> <strong>{t.branch}</strong>
            {t.landed.length > 0 && (
              <span className="f6 color-fg-muted">
                · recently landed:{' '}
                {t.landed.map((l) => (
                  <Link
                    key={l.number}
                    to={`${base}/pull/${l.number}`}
                    className="mr-1"
                  >
                    <GitMergeIcon size={12} /> #{l.number}
                  </Link>
                ))}
              </span>
            )}
          </div>
          {treeRows(t.nodes).map(({ node, depth, guides, last }) => (
            <div
              key={node.number}
              className="Box-row d-flex flex-items-start"
              style={{ gap: 8 }}
            >
              <span
                aria-hidden
                className="d-flex"
                style={{ alignSelf: 'stretch' }}
              >
                {guides.map((g, i) => (
                  <span
                    key={i}
                    style={{
                      width: 16,
                      borderLeft: g
                        ? '1px solid var(--borderColor-default, #d0d7de)'
                        : 'none',
                    }}
                  />
                ))}
                {depth > 0 && (
                  <span
                    style={{
                      width: 16,
                      height: last ? '50%' : '100%',
                      borderLeft:
                        '1px solid var(--borderColor-default, #d0d7de)',
                      borderBottom:
                        '1px solid var(--borderColor-default, #d0d7de)',
                    }}
                  />
                )}
              </span>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <Link
                  to={`${base}/pull/${node.number}`}
                  className="Link--primary text-bold wb-break-word"
                >
                  {node.title}
                </Link>{' '}
                <span className="color-fg-muted f6 wb-break-word">
                  #{node.number} · {node.headRef} · {node.author.username}
                </span>
                {node.parent && (
                  <div className="f6 color-fg-muted mt-1">
                    {node.parent.reason}
                  </div>
                )}
                <div className="mt-1">
                  {node.waitsOn.map((d) => (
                    <DepChip key={`w${d.number}`} d={d} base={base} />
                  ))}
                  {node.mustAccountFor
                    .filter((d) => d.number !== node.parent?.number)
                    .map((d) => (
                      <DepChip key={`m${d.number}`} d={d} base={base} />
                    ))}
                  {node.cycleWith.length > 0 && (
                    <span className="Label Label--danger mr-1">
                      <AlertIcon size={12} /> depends in a circle on{' '}
                      {node.cycleWith.map((c) => `#${c}`).join(', ')}
                    </span>
                  )}
                  {node.checking && (
                    <span className="Label Label--secondary mr-1">
                      checking…
                    </span>
                  )}
                  {node.pending.length > 0 && (
                    <span className="Label Label--secondary mr-1">
                      checking {node.pending.map((c) => `#${c}`).join(', ')}…
                    </span>
                  )}
                  {node.unchecked.length > 0 && (
                    <span className="Label Label--secondary mr-1">
                      couldn't check against{' '}
                      {node.unchecked.map((c) => `#${c}`).join(', ')}
                    </span>
                  )}
                </div>
                {[
                  ...node.waitsOn.map((d) => ({ d, verb: 'waits on' })),
                  ...node.mustAccountFor
                    .filter((d) => d.number !== node.parent?.number)
                    .map((d) => ({ d, verb: 'must change for' })),
                ].map(({ d, verb }) => (
                  <div key={`${verb}${d.number}`} className="f6 color-fg-muted">
                    {verb} #{d.number}: {d.reason}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
