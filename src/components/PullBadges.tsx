import { Link } from 'react-router-dom';
import { AlertIcon, SparkleFillIcon } from '@primer/octicons-react';
import type { Pull } from '@/lib/uiApi';

const AI_LABEL: Record<NonNullable<Pull['aiResolution']>, string> = {
  queued: 'Waiting to resolve conflicts with AI…',
  running: 'Resolving conflicts with AI…',
  proposed: 'Conflicts resolved by AI',
  failed: 'Conflicts need a person',
};

/** AI conflict resolution next to a listed PR's title: spinner while it runs, like checks. */
export function AiResolutionBadge({ state }: { state: Pull['aiResolution'] }) {
  if (!state) return null;
  const label = AI_LABEL[state];
  return (
    <span
      className="d-inline-flex flex-items-center v-align-middle"
      style={{ gap: 2 }}
      title={label}
      aria-label={label}
      role="img"
    >
      {state === 'failed' ? (
        <span className="color-fg-attention d-inline-flex">
          <AlertIcon size={14} />
        </span>
      ) : (
        <span
          className={`d-inline-flex ${state === 'proposed' ? 'color-fg-done' : 'color-fg-attention'}`}
        >
          <SparkleFillIcon size={14} />
        </span>
      )}
      {(state === 'queued' || state === 'running') && (
        <span
          className={`run-spinner ${state === 'queued' ? 'color-fg-muted' : 'color-fg-attention'}`}
          style={{ width: 12, height: 12 }}
        />
      )}
    </span>
  );
}

type ReviewState = NonNullable<Pull['review']>['state'];

const REVIEW_LABEL: Record<ReviewState, string> = {
  reviewing: 'Reviewing…',
  review_required: 'Review required',
  approved: 'Approved',
  failed: 'Review failed',
};

const REVIEW_CLASS: Record<ReviewState, string> = {
  reviewing: 'color-fg-muted',
  review_required: 'color-fg-muted',
  approved: 'color-fg-success',
  failed: 'color-fg-danger',
};

/** The auto-merge review in a listed PR's meta line, as GitHub shows "Review required". */
export function ReviewLabel({
  review,
  to,
}: {
  review: Pull['review'];
  to: string;
}) {
  if (!review) return null;
  const flags =
    review.state === 'review_required' && review.flags > 0
      ? ` · ${review.flags} flag${review.flags === 1 ? '' : 's'}`
      : '';
  return (
    <>
      {' • '}
      <Link
        to={to}
        className={`${REVIEW_CLASS[review.state]} d-inline-flex flex-items-center`}
        style={{ gap: 4, verticalAlign: 'bottom' }}
      >
        {review.state === 'reviewing' && (
          <span className="run-spinner" style={{ width: 10, height: 10 }} />
        )}
        {REVIEW_LABEL[review.state]}
        {flags}
      </Link>
    </>
  );
}
