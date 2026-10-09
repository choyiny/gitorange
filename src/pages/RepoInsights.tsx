import type { ReactNode } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { GraphIcon } from '@primer/octicons-react';
import {
  api,
  qk,
  type RepoDetail,
  type RepoInsights as Insights,
} from '@/lib/uiApi';
import {
  barWidths,
  of,
  parsePeriod,
  pct,
  PERIOD_OPTIONS,
  rangeText,
  span,
} from '@/lib/insights';
import { AgentAvatar } from '@/components/AgentAvatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { Section } from '@/components/ui/Section';
import { Seg } from '@/components/ui/Seg';
import { QueryError, StatsSkeleton } from '@/components/actions/states';
import { useAgentDirectory } from '@/components/actions/RunActor';

/** A headline number: its value, what it is, and what it is out of. */
function Stat({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
      <span className="ins-detail">{detail}</span>
    </div>
  );
}

/** One line of a panel: what it counts, an optional hint, and the number. */
function Row({
  label,
  hint,
  value,
  children,
}: {
  label: ReactNode;
  hint?: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ins-row">
      <div className="ins-row-main">
        <span className="ins-label">
          {label}
          {hint && <span className="small muted">{hint}</span>}
        </span>
        <b className="ins-value">{value}</b>
      </div>
      {children}
    </div>
  );
}

/** Merged pull requests split into auto-merged and merged by a person. */
function MergeSplit({ data }: { data: Insights }) {
  const { merged, autoMerged, mergedByPerson } = data.pulls;
  if (!merged) return null;
  return (
    <>
      <span
        className="ins-split"
        role="img"
        aria-label={`${autoMerged} auto-merged, ${mergedByPerson} merged by a person`}
      >
        <span
          className="ins-split-auto"
          style={{ width: `${(autoMerged / merged) * 100}%` }}
        />
        <span
          className="ins-split-person"
          style={{ width: `${(mergedByPerson / merged) * 100}%` }}
        />
      </span>
      <div className="ins-legend small muted">
        <span>
          <i className="ins-key auto" /> Auto-merged {autoMerged}
        </span>
        <span>
          <i className="ins-key person" /> By a person {mergedByPerson}
        </span>
      </div>
    </>
  );
}

function Report({
  data,
  base,
  stale,
}: {
  data: Insights;
  base: string;
  stale: boolean;
}) {
  const { pulls, reviews, flags, resolutions, ci, timeToMerge, learning } =
    data;
  const lookup = useAgentDirectory();
  const ciFinished = ci.succeeded + ci.failed;
  const quiet =
    pulls.opened +
      pulls.merged +
      pulls.openNow +
      reviews.runs +
      flags.raised +
      flags.pendingNow +
      resolutions.attempts +
      ci.runs ===
    0;
  if (quiet)
    return (
      <div className="panel">
        <EmptyState
          picture={<GraphIcon size={24} />}
          title="Nothing happened in this period"
          body="No pull requests, reviews or test runs. Try a longer period."
        />
      </div>
    );
  const busiest = Math.max(0, ...flags.byKind.map((f) => f.raised));

  return (
    <div className={stale ? 'ins-report is-stale' : 'ins-report'}>
      <div className="stats">
        <Stat
          value={String(pulls.merged)}
          label="pull requests merged"
          detail={`${pulls.opened} opened · ${pulls.openNow} open now`}
        />
        <Stat
          value={pct(pulls.autoMergeShare)}
          label="auto-merged"
          detail={`${pulls.autoMerged} of ${pulls.merged} merged`}
        />
        <Stat
          value={pct(of(reviews.pullsNeedingHuman, reviews.pullsReviewed))}
          label="needed a person"
          detail={`${reviews.pullsNeedingHuman} of ${reviews.pullsReviewed} reviewed`}
        />
        <Stat
          value={pct(ci.passRate)}
          label="CI pass rate"
          detail={`${ci.succeeded} of ${ciFinished} finished runs`}
        />
      </div>

      <Section
        title="Flags by kind"
        actions={
          <span className="muted small">
            Findings raised by each reviewer; the darker part a person approved
          </span>
        }
      >
        {flags.byKind.length ? (
          <ul className="panel pad ins-bars">
            {flags.byKind.map((f) => {
              const who = lookup(f.key);
              const w = barWidths(f.raised, f.approved, busiest);
              return (
                <li
                  key={f.key}
                  className="ins-bar-row"
                  style={{ '--agent': who.color } as React.CSSProperties}
                >
                  <Link className="ins-agent" to={`/${f.key}`}>
                    <AgentAvatar
                      handle={f.key}
                      color={who.color}
                      status="idle"
                      size={28}
                    />
                    <span className="ins-agent-name">
                      <b>{who.name === f.key ? f.title : who.name}</b>
                      {who.name !== f.key && (
                        <span className="small muted">{f.title}</span>
                      )}
                    </span>
                  </Link>
                  <span className="ins-track" aria-hidden="true">
                    <span className="ins-bar" style={{ width: `${w.raised}%` }}>
                      <span
                        className="ins-bar-in"
                        style={{ width: `${w.approved}%` }}
                      />
                    </span>
                  </span>
                  <span className="ins-val mono">
                    {f.raised} raised · {f.approved} approved
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="panel">
            <EmptyState title="No flags raised in this period." />
          </div>
        )}
      </Section>

      <div className="ins-grid">
        <Section title="Pull requests">
          <div className="panel ins-rows">
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
          </div>
        </Section>

        <Section title="Auto-merge review">
          <div className="panel ins-rows">
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
          </div>
        </Section>

        <Section title="Agents learning">
          {learning.length ? (
            <div className="table-wrap">
              <table className="table ins-learning">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col" className="ins-num">
                      Dismissed
                    </th>
                    <th scope="col" className="ins-num">
                      Lessons
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {learning.map((a) => {
                    const who = lookup(a.handle);
                    return (
                      <tr key={a.handle}>
                        <th scope="row">
                          <Link className="ins-agent" to={`/${a.handle}`}>
                            <AgentAvatar
                              handle={a.handle}
                              color={who.color}
                              status="idle"
                              size={28}
                            />
                            <span className="ins-agent-name">
                              <b>
                                {who.name === a.handle
                                  ? `@${a.handle}`
                                  : who.name}
                              </b>
                              {who.name !== a.handle && (
                                <span className="small muted">@{a.handle}</span>
                              )}
                            </span>
                          </Link>
                        </th>
                        <td className="ins-num">
                          <b>{a.dismissed}</b>
                        </td>
                        <td className="ins-num">{a.lessonsCommitted}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel">
              <EmptyState title="No change requests were dismissed in this period." />
            </div>
          )}
        </Section>

        <Section
          title={
            <>
              <AgentAvatar handle="fixer" status="idle" size={24} />
              AI conflict resolution
            </>
          }
        >
          <div className="panel ins-rows">
            <Row label="Attempts" value={resolutions.attempts} />
            <Row
              label="Resolved"
              hint="Proposed a resolution, or it was merged"
              value={`${resolutions.succeeded} (${pct(of(resolutions.succeeded, resolutions.attempts))})`}
            />
            <Row
              label="Merged with the resolution"
              value={resolutions.applied}
            />
            <Row label="Failed" value={resolutions.failed} />
            <Row label="Discarded" value={resolutions.rejected} />
            {resolutions.inProgress > 0 && (
              <Row label="Running" value={resolutions.inProgress} />
            )}
            <Row
              label="Pull requests with conflicts"
              value={resolutions.pulls}
            />
          </div>
        </Section>

        <Section title="CI on pull requests">
          <div className="panel ins-rows">
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
          </div>
        </Section>
      </div>
    </div>
  );
}

export default function RepoInsights() {
  const repo = useOutletContext<RepoDetail>();
  const [params, setParams] = useSearchParams();
  const days = parsePeriod(params.get('days'));
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.insights(o, repo.name, days),
    queryFn: () => api.insights(o, repo.name, days),
    // Keep the last period on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
  const range = rangeText(q.data?.since, q.data?.until);

  return (
    <>
      <PageHead
        icon="graph"
        crumbs={[{ label: 'Insights' }]}
        title="Insights"
        tab="insights"
        lede={`How well agents land changes in ${repo.fullName}.${range ? ` ${range}.` : ''}`}
        actions={
          <Seg
            label="Period"
            options={PERIOD_OPTIONS}
            value={String(days)}
            onChange={(v) =>
              setParams(v === '30' ? {} : { days: v }, { replace: true })
            }
          />
        }
      />
      {q.isError && !q.data ? (
        <div className="panel">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            title="Insights did not load"
            picture={<GraphIcon size={24} />}
          />
        </div>
      ) : !q.data ? (
        <StatsSkeleton />
      ) : (
        <Report
          data={q.data}
          base={`/${repo.fullName}`}
          stale={q.isPlaceholderData}
        />
      )}
    </>
  );
}
