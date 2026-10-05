import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '@/lib/api';
import { api, type RepoDetail, type StackNode } from '@/lib/uiApi';
import { AgentRunLink } from './AgentRunLink';

/** Links separated by commas, so adjacent ones don't run together. */
function joined(items: ReactNode[]) {
  return items.map((el, i) => (
    <Fragment key={i}>
      {i > 0 && ', '}
      {el}
    </Fragment>
  ));
}

export function StackSidebar({
  repo,
  number,
  stack,
}: {
  repo: RepoDetail;
  number: number;
  stack: StackNode;
}) {
  const base = `/${repo.fullName}`;
  const o = repo.owner.username;
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['repo', o, repo.name] });
  const retry = useMutation({
    mutationFn: () => api.retryStack(o, repo.name, number),
    onSuccess: refresh,
  });
  const unstack = useMutation({
    mutationFn: () => api.unstack(o, repo.name, number),
    onSuccess: refresh,
  });
  const dismiss = useMutation({
    mutationFn: (pr: number) => api.dismissStackEdge(o, repo.name, number, pr),
    onSuccess: refresh,
  });
  const control = (label: string, onClick: () => void, title: string) =>
    repo.permissions.write ? (
      <button
        className="btn-link ml-1"
        title={title}
        disabled={unstack.isPending || dismiss.isPending}
        onClick={onClick}
      >
        {label}
      </button>
    ) : null;
  const link = (n: number) => (
    <Link key={n} to={`${base}/pull/${n}`}>
      #{n}
    </Link>
  );
  const empty =
    !stack.parent &&
    !stack.children.length &&
    !stack.waitsOn.length &&
    !stack.mustAccountFor.length &&
    !stack.cycleWith.length &&
    !stack.unchecked.length &&
    !stack.pending.length;
  return (
    <div className="border-bottom pb-3 mb-3">
      <div className="d-flex flex-items-center flex-justify-between mb-2">
        <span className="text-bold color-fg-muted">Stack</span>
        <AgentRunLink repo={repo} number={number} kind="stack_discovery" />
      </div>
      {empty && stack.checking && (
        <div className="color-fg-muted">
          Checking against other open pull requests…
        </div>
      )}
      {empty && !stack.checking && (
        <div className="color-fg-muted">
          Independent of other open pull requests.
        </div>
      )}
      {stack.pending.length > 0 && (
        <p className="color-fg-muted mb-2">
          Checking against {joined(stack.pending.map(link))}…
        </p>
      )}
      {stack.parent && (
        <p className="mb-2">
          {stack.parent.kind === 'ordered_after' ? (
            <>
              Lands after {link(stack.parent.number)} so{' '}
              {stack.parent.forPr
                ? link(stack.parent.forPr)
                : 'another pull request'}{' '}
              can build on both: {stack.parent.reason}
            </>
          ) : (
            <>
              Builds on {link(stack.parent.number)}: {stack.parent.reason}
            </>
          )}
          {control(
            'Unstack',
            () => unstack.mutate(),
            'Retarget to the land target and stop building on it'
          )}
        </p>
      )}
      {stack.children.length > 0 && (
        <p className="mb-2">Built on by {joined(stack.children.map(link))}</p>
      )}
      {stack.waitsOn.map((d) => (
        <p key={`w${d.number}`} className="mb-2">
          Waits on {link(d.number)}: {d.reason}
          {control(
            'Dismiss',
            () => dismiss.mutate(d.number),
            'Stop waiting on it'
          )}
        </p>
      ))}
      {stack.mustAccountFor.map((d) => (
        <div
          key={`m${d.number}`}
          className={`${d.accounted ? 'border rounded-2' : 'flash flash-warn'} p-2 mb-2`}
        >
          {d.accounted && (
            <span className="Label Label--success mr-1">accounted for</span>
          )}
          Must change for {link(d.number)}
          {d.landed ? ' (landed)' : ''}: {d.reason}
          {d.instructions && !d.accounted && (
            <div className="mt-1">{d.instructions}</div>
          )}
          {!d.accounted &&
            control(
              'Dismiss',
              () => dismiss.mutate(d.number),
              'Stop waiting on it'
            )}
        </div>
      ))}
      {(unstack.isError || dismiss.isError) && (
        <p className="color-fg-danger f6 mb-2">
          {errorMessage(unstack.error ?? dismiss.error)}
        </p>
      )}
      {stack.cycleWith.length > 0 && (
        <p className="color-fg-danger mb-2">
          Depends in a circle on {joined(stack.cycleWith.map(link))}; a person
          decides the order.
        </p>
      )}
      {stack.unchecked.length > 0 && (
        <p className="mb-2">
          Couldn't check against {joined(stack.unchecked.map(link))}.{' '}
          {repo.permissions.write && (
            <button
              className="btn-link"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              Retry
            </button>
          )}
          {retry.isError && (
            <span className="color-fg-danger f6 d-block">
              {errorMessage(retry.error)}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
