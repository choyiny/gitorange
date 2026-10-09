import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { PlusIcon, ShieldIcon } from '@primer/octicons-react';
import { api, qk, type Agent, type AgentStats } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { agentColor } from '@/lib/agentLook';
import {
  avatarStatusOf,
  cardStats,
  groupAgents,
  overallStatus,
  presetState,
  whereText,
} from '@/lib/agentPage';
import { AgentCard } from '@/components/agents/AgentCard';
import { useEnter } from '@/components/code/useEnter';
import { CrewIcon } from '@/components/shell/icons';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { Section } from '@/components/ui/Section';
import { LoadError } from '@/components/Notice';

/** Placeholder cards while a section loads. */
function CardsSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div
      className="sk-grid"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="sk sk-card" />
      ))}
    </div>
  );
}

/** Agents, `/agents`: who reviews your code, the agents built in, and the reviewers you could add. */
export default function Agents() {
  const me = useCurrentUser();
  const admin = me?.role === 'admin';
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const builtin = useQuery({
    queryKey: qk.agentsBuiltin,
    queryFn: api.agentsBuiltin,
  });
  const presets = useQuery({
    queryKey: qk.agentPresets,
    queryFn: api.agentPresets,
  });
  const list = agents.data ?? [];
  // One record per agent: it says whether the agent is on a repository you can see, and fills its card.
  const records = useQueries({
    queries: list.map((a) => ({
      queryKey: qk.agentStats(a.username),
      queryFn: () => api.agentStats(a.username),
    })),
  });
  const stats = new Map<string, AgentStats | undefined>(
    list.map((a, i) => [a.username, records[i]?.data])
  );
  const recordsReady = records.every((r) => !r.isPending);
  const ready = !!agents.data && recordsReady;
  const entering = useEnter(ready);

  const groups = groupAgents(list, stats);
  const handles = new Set(list.map((a) => a.username.toLowerCase()));
  const toCreate = (presets.data ?? []).filter(
    (p) => presetState(p, handles) === 'create'
  );

  // Nothing to say once every preset exists and every agent is at work.
  const showAvailable =
    !ready ||
    !presets.data ||
    groups.available.length > 0 ||
    toCreate.length > 0;

  const agentCard = (a: Agent) => {
    const s = stats.get(a.username);
    const repos = s?.repos ?? [];
    const status = s
      ? avatarStatusOf({
          repos: repos.length,
          status: overallStatus(repos),
        })
      : 'idle';
    return (
      <AgentCard
        key={a.id}
        to={`/${a.username}`}
        handle={a.username}
        color={a.color}
        name={a.name}
        subtitle={`@${a.username}`}
        bio={a.bio || 'No description yet.'}
        status={status}
        stats={cardStats(s)}
        foot={
          <>
            <Chip status={status}>
              {status === 'off' ? 'Not on a repository' : undefined}
            </Chip>
            {a.guarded && (
              <Chip
                tone="warn"
                icon={<ShieldIcon size={12} />}
                title="Its findings are never approved in bulk or by GitOrange AI, and approving one needs a reason"
              >
                Guarded
              </Chip>
            )}
            <span className="muted small">{whereText(s)}</span>
          </>
        }
      />
    );
  };

  return (
    <div className={`ag-page ${entering}`}>
      <PageHead
        icon="crew"
        crumbs={[{ label: 'Agents' }]}
        title="Agents"
        lede="Each agent is an account with its own profile and its own repository of instructions. Reviewers check every change for one area; built-in agents keep changes moving."
        actions={
          admin ? (
            <>
              <Link className="btn" to="/admin/agents">
                Manage agents
              </Link>
              <Link className="btn primary" to="/agents/new">
                <PlusIcon />
                New reviewer
              </Link>
            </>
          ) : (
            <Link className="btn" to="/agents/new">
              Who can add reviewers
            </Link>
          )
        }
      />

      <Section
        title="Reviewing your code"
        actions={
          ready && (
            <span className="muted small">
              {groups.reviewing.length} on repositories you can see
            </span>
          )
        }
      >
        {agents.isError ? (
          <LoadError
            what="the agents"
            error={agents.error}
            onRetry={() => void agents.refetch()}
          />
        ) : !ready ? (
          <CardsSkeleton />
        ) : groups.reviewing.length === 0 ? (
          <div className="panel">
            <EmptyState
              picture={<CrewIcon size={20} />}
              title="No reviewer is on a repository you can see"
              body={
                admin
                  ? 'Add the recommended crew, then invite each reviewer to a repository from its profile or from the repository’s settings.'
                  : 'A reviewer starts once it is invited to a repository. Ask a site admin or the repository’s owner.'
              }
              action={
                admin ? (
                  <Link className="btn small primary" to="/agents/new">
                    New reviewer
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="agrid">{groups.reviewing.map(agentCard)}</div>
        )}
      </Section>

      <Section title="Built in">
        {builtin.isError ? (
          <LoadError
            what="the built-in agents"
            error={builtin.error}
            onRetry={() => void builtin.refetch()}
          />
        ) : !builtin.data ? (
          <CardsSkeleton cards={2} />
        ) : (
          <div className="agrid">
            {builtin.data.map((b) => (
              <AgentCard
                key={b.id}
                to={`/agents/${b.id}`}
                handle={b.id}
                color={agentColor(b.id)}
                name={b.name}
                subtitle="Built in"
                bio={b.job}
                status="idle"
                stats={b.stats.map((s) => ({ value: s.value, label: s.label }))}
                foot={
                  <>
                    <Chip tone="info" icon={<CrewIcon size={12} />}>
                      Built in
                    </Chip>
                    <span className="muted small">Every repository</span>
                  </>
                }
              />
            ))}
          </div>
        )}
      </Section>

      {showAvailable && (
        <Section
          title="Available"
          actions={
            <span className="muted small">
              {admin
                ? 'Open one to add it to a repository, or create the ones that are missing'
                : 'Reviewers a site admin can add'}
            </span>
          }
        >
          {presets.isError ? (
            <LoadError
              what="the reviewer presets"
              error={presets.error}
              onRetry={() => void presets.refetch()}
            />
          ) : agents.isError ? (
            <LoadError
              what="the agents"
              error={agents.error}
              onRetry={() => void agents.refetch()}
            />
          ) : !ready || !presets.data ? (
            <CardsSkeleton />
          ) : (
            <div className="agrid">
              {groups.available.map(agentCard)}
              {toCreate.map((p) => (
                <AgentCard
                  key={p.facet}
                  to={`/agents/new#preset-${p.facet}`}
                  handle={p.handle}
                  color={p.color}
                  name={p.name}
                  subtitle={`@${p.handle}`}
                  bio={p.bio}
                  status="off"
                  foot={
                    <>
                      <Chip status="off">Not created yet</Chip>
                      {p.guarded && (
                        <Chip tone="warn" icon={<ShieldIcon size={12} />}>
                          Guarded
                        </Chip>
                      )}
                      <span className="muted small">
                        {admin
                          ? 'Create it from New reviewer'
                          : 'Ask a site admin to create it'}
                      </span>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
