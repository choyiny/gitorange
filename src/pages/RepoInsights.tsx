import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CheckCircleIcon,
  GitMergeIcon,
  GraphIcon,
  PersonIcon,
  PlayIcon,
} from '@primer/octicons-react';
import {
  api,
  INSIGHT_PERIODS,
  qk,
  type RepoDetail,
  type RepoInsights as Insights,
} from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { dayLabel, spanOf } from '@/lib/format';
import { Spinner } from '@/components/Spinner';

const PERIOD_LABEL: Record<number, string> = {
  7: '1 week',
  30: '1 month',
  90: '3 months',
  365: '1 year',
};

const pct = (x: number | null) =>
  x === null ? '—' : `${Math.round(x * 100)}%`;
const span = (s: number | null) => (s === null ? '—' : spanOf(s));
const of = (a: number, b: number) => (b > 0 ? a / b : null);

/** A headline number with what it is out of. */
function Card({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="Box p-3">
      <div
        className="f6 color-fg-muted d-flex flex-items-center"
        style={{ gap: 6 }}
      >
        {icon}
        {label}
      </div>
      <div className="f1 text-bold lh-condensed mt-1">{value}</div>
      <div className="f6 color-fg-muted">{detail}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  value: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="Box-row py-2">
      <div className="d-flex flex-items-baseline" style={{ gap: 12 }}>
        <div
          className="flex-1 min-width-0"
          style={{ overflowWrap: 'anywhere' }}
        >
          {label}
          {hint && <div className="f6 color-fg-muted">{hint}</div>}
        </div>
        <div className="text-bold text-right flex-shrink-0">{value}</div>
      </div>
      {children}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="Box">
      <div className="Box-header py-2">
        <h3 className="Box-title f5">{title}</h3>
      </div>
      {children}
    </div>
  );
}

/** Merged pull requests split into auto-merged (green) and merged by a person (purple). */
function MergeSplit({ data }: { data: Insights }) {
  const { merged, autoMerged, mergedByPerson } = data.pulls;
  if (!merged) return null;
  return (
    <>
      <span
        className="Progress mt-2"
        role="img"
        aria-label={`${autoMerged} auto-merged, ${mergedByPerson} merged by a person`}
      >
        <span
          className="Progress-item color-bg-success-emphasis"
          style={{ width: `${(autoMerged / merged) * 100}%` }}
        />
        <span
          className="Progress-item color-bg-done-emphasis"
          style={{ width: `${(mergedByPerson / merged) * 100}%` }}
        />
      </span>
      <div
        className="f6 color-fg-muted mt-1 d-flex flex-wrap"
        style={{ columnGap: 12 }}
      >
        <span>
          <span className="color-fg-success">●</span> Auto-merged {autoMerged}
        </span>
        <span>
          <span className="color-fg-done">●</span> By a person {mergedByPerson}
        </span>
      </div>
    </>
  );
}

function Report({ data, base }: { data: Insights; base: string }) {
  const { pulls, reviews, flags, resolutions, ci, timeToMerge, learning } =
    data;
  const ciFinished = ci.succeeded + ci.failed;
  return (
    <>
      <div
        className="mb-4"
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
        }}
      >
        <Card
          icon={<GitMergeIcon size={14} />}
          label="Merged"
          value={String(pulls.merged)}
          detail={`${pulls.opened} opened · ${pulls.openNow} open now`}
        />
        <Card
          icon={<CheckCircleIcon size={14} />}
          label="Auto-merged"
          value={pct(pulls.autoMergeShare)}
          detail={`${pulls.autoMerged} of ${pulls.merged} merged`}
        />
        <Card
          icon={<PersonIcon size={14} />}
          label="Needed a person"
          value={pct(of(reviews.pullsNeedingHuman, reviews.pullsReviewed))}
          detail={`${reviews.pullsNeedingHuman} of ${reviews.pullsReviewed} reviewed`}
        />
        <Card
          icon={<PlayIcon size={14} />}
          label="CI pass rate"
          value={pct(ci.passRate)}
          detail={`${ci.succeeded} of ${ciFinished} finished runs`}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
          alignItems: 'start',
        }}
      >
        <Section title="Pull requests">
          <Row label="Opened" value={pulls.opened} />
          <Row label="Merged" value={pulls.merged}>
            <MergeSplit data={data} />
          </Row>
          <Row
            label="Merged with no one involved"
            hint="Auto-merged, and the review never asked a person anything"
            value={pulls.mergedHandsOff}
          />
          <Row
            label="Merged after human review"
            hint="The review raised at least one flag for a person"
            value={pulls.mergedAfterHumanReview}
          />
          <Row label="Closed without merging" value={pulls.closedUnmerged} />
          <Row
            label={<Link to={`${base}/pulls`}>Open now</Link>}
            value={pulls.openNow}
          />
          <Row label="Median time to merge" value={span(timeToMerge.all)} />
          <Row label="… when auto-merged" value={span(timeToMerge.auto)} />
          <Row
            label="… when merged by a person"
            value={span(timeToMerge.person)}
          />
        </Section>

        <Section title="Auto-merge review">
          <Row
            label="Reviews run"
            hint="One per head commit"
            value={reviews.runs}
          />
          <Row label="Cleared for auto-merge" value={reviews.autoVerdicts} />
          <Row label="Asked a person" value={reviews.humanVerdicts} />
          <Row label="Failed" value={reviews.failed} />
          <Row
            label="Pull requests that needed human review"
            value={`${reviews.pullsNeedingHuman} of ${reviews.pullsReviewed}`}
          />
          <Row label="Flags raised" value={flags.raised} />
          <Row label="Flags approved" value={flags.approved} />
          <Row
            label="Median time to approval"
            hint="From a flag being raised to a person approving it"
            value={span(flags.medianTimeToApproval)}
          />
          <Row
            label={<Link to="/approvals">Waiting on a person now</Link>}
            hint={
              flags.pendingNow
                ? `On ${flags.pendingPullsNow} open pull request${flags.pendingPullsNow === 1 ? '' : 's'}`
                : undefined
            }
            value={flags.pendingNow}
          />
        </Section>

        <Section title="Flags by kind">
          {flags.byKind.length ? (
            <>
              <div
                className="Box-row py-2 d-flex f6 color-fg-muted"
                style={{ gap: 12 }}
              >
                <span className="flex-1">Flag</span>
                <span style={{ width: 56 }} className="text-right">
                  Raised
                </span>
                <span style={{ width: 64 }} className="text-right">
                  Approved
                </span>
              </div>
              {flag(flags.byKind)}
            </>
          ) : (
            <div className="Box-row color-fg-muted">
              No flags raised in this period.
            </div>
          )}
        </Section>

        <Section title="Agents learning">
          {learning.length ? (
            <>
              <div
                className="Box-row py-2 d-flex f6 color-fg-muted"
                style={{ gap: 12 }}
              >
                <span className="flex-1">Agent</span>
                <span style={{ width: 72 }} className="text-right">
                  Dismissed
                </span>
                <span style={{ width: 64 }} className="text-right">
                  Lessons
                </span>
              </div>
              {learning.map((a) => (
                <div
                  key={a.handle}
                  className="Box-row py-2 d-flex flex-items-baseline"
                  style={{ gap: 12 }}
                >
                  <span className="flex-1 min-width-0">
                    <Link to={`/${a.handle}`}>@{a.handle}</Link>
                  </span>
                  <span style={{ width: 72 }} className="text-right text-bold">
                    {a.dismissed}
                  </span>
                  <span style={{ width: 64 }} className="text-right">
                    {a.lessonsCommitted}
                  </span>
                </div>
              ))}
            </>
          ) : (
            <div className="Box-row color-fg-muted">
              No change requests were dismissed in this period.
            </div>
          )}
        </Section>

        <Section title="AI conflict resolution">
          <Row label="Attempts" value={resolutions.attempts} />
          <Row
            label="Resolved"
            hint="Proposed a resolution, or it was merged"
            value={`${resolutions.succeeded} (${pct(of(resolutions.succeeded, resolutions.attempts))})`}
          />
          <Row label="Merged with the resolution" value={resolutions.applied} />
          <Row label="Failed" value={resolutions.failed} />
          <Row label="Discarded" value={resolutions.rejected} />
          {resolutions.inProgress > 0 && (
            <Row label="Running" value={resolutions.inProgress} />
          )}
          <Row label="Pull requests with conflicts" value={resolutions.pulls} />
        </Section>

        <Section title="CI on pull requests">
          <Row
            label={<Link to={`${base}/actions`}>Runs</Link>}
            value={ci.runs}
          />
          <Row label="Passed" value={ci.succeeded} />
          <Row label="Failed" value={ci.failed} />
          <Row label="Cancelled" value={ci.cancelled} />
          <Row
            label="Pass rate"
            hint="Of runs that passed or failed"
            value={pct(ci.passRate)}
          />
          <Row
            label="Median time to green"
            hint="From opening a pull request to its first passing run"
            value={span(ci.medianTimeToGreen)}
          />
        </Section>
      </div>
    </>
  );
}

function flag(rows: Insights['flags']['byKind']) {
  return rows.map((f) => (
    <div
      key={f.key}
      className="Box-row py-2 d-flex flex-items-baseline"
      style={{ gap: 12 }}
    >
      <span className="flex-1 min-width-0" style={{ overflowWrap: 'anywhere' }}>
        <Link to={`/${f.key}`}>{f.title}</Link>
      </span>
      <span style={{ width: 56 }} className="text-right text-bold">
        {f.raised}
      </span>
      <span style={{ width: 64 }} className="text-right">
        {f.approved}
      </span>
    </div>
  ));
}

export default function RepoInsights() {
  const repo = useOutletContext<RepoDetail>();
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get('days'));
  const days = (INSIGHT_PERIODS as readonly number[]).includes(asked)
    ? asked
    : 30;
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.insights(o, repo.name, days),
    queryFn: () => api.insights(o, repo.name, days),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div
        className="d-flex flex-wrap flex-items-center flex-justify-between pb-3 mb-3 border-bottom"
        style={{ gap: 12 }}
      >
        <div>
          <h2
            className="f3 text-normal d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <GraphIcon />
            Insights
          </h2>
          <div className="f6 color-fg-muted">
            {q.data
              ? `${dayLabel(Date.parse(q.data.since) / 1000)} – ${dayLabel(Date.parse(q.data.until) / 1000)}`
              : ' '}
          </div>
        </div>
        <div className="BtnGroup" role="group" aria-label="Period">
          {INSIGHT_PERIODS.map((d) => (
            <button
              key={d}
              type="button"
              className={`btn btn-sm BtnGroup-item${d === days ? ' selected' : ''}`}
              aria-pressed={d === days}
              onClick={() =>
                setParams(d === 30 ? {} : { days: String(d) }, {
                  replace: true,
                })
              }
            >
              {PERIOD_LABEL[d]}
            </button>
          ))}
        </div>
      </div>
      {q.error ? (
        <div className="flash flash-error">{errorMessage(q.error)}</div>
      ) : !q.data ? (
        <Spinner />
      ) : (
        <Report data={q.data} base={`/${repo.fullName}`} />
      )}
    </div>
  );
}
