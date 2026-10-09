import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { errorMessage } from '@/lib/api';
import { agentColor } from '@/lib/agentLook';
import {
  api,
  qk,
  type HealthArea,
  type RepoAgent,
  type RepoDetail,
} from '@/lib/uiApi';
import { notReviewing, reviewerRecord, reviewerState } from '@/lib/health';
import { AgentAvatar } from '@/components/AgentAvatar';
import { QueryError, RowsSkeleton } from '@/components/actions/states';
import { CrewIcon } from '@/components/shell/icons';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PendingButton } from '@/components/ui/PendingButton';
import { Section } from '@/components/ui/Section';
import { useToast } from '@/components/ui/Toast';

function Row({
  to,
  color,
  avatar,
  name,
  job,
  record,
  recordTitle,
  end,
  off,
}: {
  to?: string;
  color: string;
  avatar: ReactNode;
  name: ReactNode;
  job?: string | null;
  record?: string | null;
  recordTitle?: string;
  end?: ReactNode;
  off?: boolean;
}) {
  const style = { '--agent': color } as CSSProperties;
  const inner = (
    <>
      {avatar}
      <span className="hl-rrow-main">
        <b>{name}</b>
        {job && <span className="muted small">{job}</span>}
      </span>
      <span className="hl-rrow-rec small" title={recordTitle}>
        {record}
      </span>
      {end}
    </>
  );
  const cls = off ? 'hl-rrow off' : 'hl-rrow';
  return to ? (
    <Link className={cls} to={to} style={style}>
      {inner}
    </Link>
  ) : (
    <div className={cls} style={style}>
      {inner}
    </div>
  );
}

const KEPT_TITLE =
  'The share of its findings a person kept, across every repository it reviews';

/**
 * The reviewers on this project, each with what it raised this week, its record overall and what it is doing here
 * now; then the agents that are not on it, which an admin of the repository can add. A reviewer's page is one click
 * away from every row.
 */
export function Reviewers({
  repo,
  areas,
}: {
  repo: RepoDetail;
  areas: HealthArea[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const o = repo.owner.username;
  const n = repo.name;
  const admin = repo.permissions.admin;
  const invited = useQuery({
    queryKey: qk.repoAgents(o, n),
    queryFn: () => api.repoAgents(o, n),
  });
  const directory = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const records = useQueries({
    queries: (invited.data ?? []).map((a) => ({
      queryKey: qk.agentStats(a.username),
      queryFn: () => api.agentStats(a.username),
    })),
  });
  const add = useMutation({
    mutationFn: (agent: { username: string; name: string }) =>
      api.inviteAgent(o, n, agent.username),
    onSuccess: async (_result, agent) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['repo', o, n] }),
        qc.invalidateQueries({ queryKey: qk.agents }),
        qc.invalidateQueries({ queryKey: qk.repos }),
      ]);
      toast(`Added ${agent.name} to ${repo.fullName}`);
    },
  });

  const on: RepoAgent[] = invited.data ?? [];
  const off = notReviewing(directory.data ?? [], on);
  const thisWeek = new Map(
    areas.filter((a) => a.agent).map((a) => [a.agent!.toLowerCase(), a])
  );

  return (
    <Section
      title="Reviewers"
      actions={
        <Link className="small" to="/agents">
          All agents
        </Link>
      }
    >
      {invited.isError && !invited.data ? (
        <div className="panel">
          <QueryError
            error={invited.error}
            onRetry={() => void invited.refetch()}
            title="Reviewers did not load"
            picture={<CrewIcon size={24} />}
          />
        </div>
      ) : invited.isPending ? (
        <RowsSkeleton rows={3} />
      ) : (
        <div className="hl-rlist">
          {on.length === 0 && (
            <EmptyState
              picture={<CrewIcon size={24} />}
              title="No reviewers on this project yet"
              body={
                off.length
                  ? 'Reviewers look at each change before it merges. Add one below.'
                  : 'Reviewers look at each change before it merges. A site admin can create them from Agents.'
              }
            />
          )}
          {on.map((a, i) => {
            const stats = records[i]?.data;
            const state = reviewerState(stats, repo.fullName);
            return (
              <Row
                key={a.id}
                to={`/${a.username}`}
                color={agentColor(a.username, a.color)}
                avatar={
                  <AgentAvatar
                    handle={a.username}
                    color={a.color}
                    status={state ?? 'idle'}
                    size={40}
                  />
                }
                name={a.name}
                job={a.bio}
                record={reviewerRecord(
                  thisWeek.get(a.username.toLowerCase()),
                  stats
                )}
                recordTitle={KEPT_TITLE}
                end={state ? <Chip status={state} /> : null}
              />
            );
          })}
          {off.map((a) => (
            <Row
              key={a.id}
              off
              color={agentColor(a.username, a.color)}
              avatar={
                <AgentAvatar
                  handle={a.username}
                  color={a.color}
                  status="off"
                  size={40}
                />
              }
              name={<Link to={`/${a.username}`}>{a.name}</Link>}
              job={a.bio}
              record="Not on this project"
              end={
                admin ? (
                  <PendingButton
                    className="small"
                    pending={
                      add.isPending && add.variables?.username === a.username
                    }
                    pendingLabel="Adding…"
                    disabled={add.isPending}
                    error={
                      add.isError && add.variables?.username === a.username
                        ? errorMessage(add.error)
                        : null
                    }
                    aria-label={`Add ${a.name} to ${repo.fullName}`}
                    onClick={() =>
                      add.mutate({ username: a.username, name: a.name })
                    }
                  >
                    Add
                  </PendingButton>
                ) : (
                  <Chip status="off" />
                )
              }
            />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Clef and Fixer: they work on every change in every project, so they have no state to show here. */
export function BuiltIn() {
  const q = useQuery({
    queryKey: qk.agentsBuiltin,
    queryFn: api.agentsBuiltin,
  });
  return (
    <Section title="Built in">
      {q.isError && !q.data ? (
        <div className="panel">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            title="The built-in agents did not load"
            picture={<CrewIcon size={24} />}
          />
        </div>
      ) : !q.data ? (
        <RowsSkeleton rows={2} />
      ) : (
        <div className="hl-rlist">
          {q.data.map((b) => (
            <Row
              key={b.id}
              to={`/agents/${b.id}`}
              color={agentColor(b.id)}
              avatar={<AgentAvatar handle={b.id} status="idle" size={40} />}
              name={b.name}
              job={b.job}
              record={b.stats.map((s) => `${s.value} ${s.label}`).join(' · ')}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
