import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertIcon,
  CheckIcon,
  GitBranchIcon,
  SyncIcon,
} from '@primer/octicons-react';
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

/**
 * How this pull request stacks with other open ones (Clef works it out): what it builds on or lands after, what
 * builds on it, what it waits on or must account for, and pairs it couldn't check. People with write access can
 * unstack it, dismiss a dependency and retry the check.
 */
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
        type="button"
        className="btn quiet small"
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
    <div className="pr-stack">
      <div className="pr-stack-head">
        <GitBranchIcon />
        <b>Stack</b>
        <span className="grow" />
        <AgentRunLink
          repo={repo}
          number={number}
          kind="stack_discovery"
          className="small"
        />
      </div>
      {empty && stack.checking && (
        <p className="muted">
          <span className="spinner" aria-hidden="true" /> Checking against other
          open pull requests…
        </p>
      )}
      {empty && !stack.checking && (
        <p className="muted">Independent of other open pull requests.</p>
      )}
      {stack.pending.length > 0 && (
        <p className="muted">
          Checking against {joined(stack.pending.map(link))}…
        </p>
      )}
      {stack.parent && (
        <div className="pr-stack-line">
          <p>
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
          </p>
          {control(
            'Unstack',
            () => unstack.mutate(),
            'Retarget to the land target and stop building on it'
          )}
        </div>
      )}
      {stack.children.length > 0 && (
        <p>Built on by {joined(stack.children.map(link))}</p>
      )}
      {stack.waitsOn.map((d) => (
        <div key={`w${d.number}`} className="pr-stack-line">
          <p>
            Waits on {link(d.number)}: {d.reason}
          </p>
          {control(
            'Dismiss',
            () => dismiss.mutate(d.number),
            'Stop waiting on it'
          )}
        </div>
      ))}
      {stack.mustAccountFor.map((d) => (
        <div
          key={`m${d.number}`}
          className={`pr-stack-must${d.accounted ? ' done' : ''}`}
        >
          <p>
            {d.accounted ? (
              <span className="chip good">
                <CheckIcon size={12} />
                accounted for
              </span>
            ) : (
              <AlertIcon className="pr-warn" />
            )}{' '}
            Must change for {link(d.number)}
            {d.landed ? ' (landed)' : ''}: {d.reason}
          </p>
          {d.instructions && !d.accounted && (
            <p className="pr-stack-how">{d.instructions}</p>
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
        <p className="ap-error" role="alert">
          {errorMessage(unstack.error ?? dismiss.error)}
        </p>
      )}
      {stack.cycleWith.length > 0 && (
        <p className="pr-bad">
          <AlertIcon /> Depends in a circle on{' '}
          {joined(stack.cycleWith.map(link))}; a person decides the order.
        </p>
      )}
      {stack.unchecked.length > 0 && (
        <div className="pr-stack-line">
          <p>
            Couldn&apos;t check against {joined(stack.unchecked.map(link))}.
          </p>
          {repo.permissions.write && (
            <button
              type="button"
              className="btn quiet small"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <SyncIcon size={14} />
              Retry
            </button>
          )}
        </div>
      )}
      {retry.isError && (
        <p className="ap-error" role="alert">
          {errorMessage(retry.error)}
        </p>
      )}
    </div>
  );
}
