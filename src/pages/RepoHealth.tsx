import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PulseIcon } from '@primer/octicons-react';
import { api, qk, type HealthReport, type RepoDetail } from '@/lib/uiApi';
import { healthLede } from '@/lib/health';
import { QueryError, StatsSkeleton } from '@/components/actions/states';
import { Contributors } from '@/components/health/Contributors';
import { DecisionSlot } from '@/components/health/DecisionCard';
import { BuiltIn, Reviewers } from '@/components/health/Reviewers';
import { TrendTable } from '@/components/health/TrendTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { Section } from '@/components/ui/Section';

function Report({ data, repo }: { data: HealthReport; repo: RepoDetail }) {
  const base = `/${repo.fullName}`;
  return (
    <>
      {data.decisionsWaiting > 0 && (
        <DecisionSlot
          fullName={repo.fullName}
          waiting={data.decisionsWaiting}
        />
      )}

      <Section title="Did anything get worse?">
        {data.areas.length === 0 ? (
          <div className="panel">
            <EmptyState
              picture={<PulseIcon size={24} />}
              title="Nothing is measured yet"
              body="Health fills in as reviewers raise findings, tests run on main and changes merge."
            />
          </div>
        ) : (
          <TrendTable areas={data.areas} base={base} />
        )}
        <p className="hl-measure muted small">
          Measured from your reviewers’ findings, tests on main and merges. For
          tests, the chart shows the share of runs that failed. A week with no
          test runs shows as a gap.
        </p>
      </Section>

      <Contributors
        contributors={data.contributors}
        owner={repo.owner.username}
        name={repo.name}
      />

      <Reviewers repo={repo} areas={data.areas} />
      <BuiltIn />
    </>
  );
}

/**
 * Health, the owner's "did anything get worse?" page for one repository: the decision waiting, a week-over-week row
 * for each reviewer, tests on main and merging, the branch map, who made things better or worse, and the reviewers.
 * Everything is measured from GitOrange's own signals, not from the running app. The report refreshes when the
 * repository changes (live pings) and its approvals when decisions are made.
 */
export default function RepoHealth() {
  const repo = useOutletContext<RepoDetail>();
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.health(o, repo.name),
    queryFn: () => api.health(o, repo.name),
  });
  return (
    <>
      <PageHead
        icon="pulse"
        crumbs={[{ label: 'Health' }]}
        title="Health"
        tab="health"
        lede={
          q.data
            ? healthLede(q.data, repo.openPullCount)
            : `How things are going in ${repo.fullName}.`
        }
      />
      {q.isError && !q.data ? (
        <div className="panel">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            title="Health did not load"
            picture={<PulseIcon size={24} />}
          />
        </div>
      ) : !q.data ? (
        <StatsSkeleton />
      ) : (
        <Report data={q.data} repo={repo} />
      )}
    </>
  );
}
