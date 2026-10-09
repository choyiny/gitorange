import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, qk, type AgentStats, type Namespace } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { inviteChoices } from '@/lib/agentPage';
import { InlineConfirm } from '@/components/InlineConfirm';
import { EmptyState } from '@/components/ui/EmptyState';
import { PendingButton } from '@/components/ui/PendingButton';
import { Section } from '@/components/ui/Section';
import { Chip } from '@/components/ui/Chip';
import { useToast } from '@/components/ui/Toast';
import { CrewIcon } from '@/components/shell/icons';

type Agent = NonNullable<Namespace['agent']>;

const split = (fullName: string): [string, string] => {
  const i = fullName.indexOf('/');
  return [fullName.slice(0, i), fullName.slice(i + 1)];
};

/**
 * The repositories an agent reviews, what it is doing in each, and the controls to change that: "Turn off" (take it
 * off a repository: only where you are an admin of it) and "Add to a repository". The server decides who may do either.
 */
export function WhereItReviews({
  agent,
  stats,
}: {
  agent: Agent;
  /** Its record, for what it is doing in each repository; absent until it loads or if it failed. */
  stats?: AgentStats;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useCurrentUser();
  const handle = agent.username;
  const rows = agent.invitedTo;
  const [choice, setChoice] = useState('');
  const doing = new Map(
    (stats?.repos ?? []).map((r) => [r.repo.toLowerCase(), r])
  );
  // Whether you may turn it off is your admin right on that repository.
  const details = useQueries({
    queries: rows.map((r) => ({
      queryKey: qk.repo(r.owner.username, r.name),
      queryFn: () => api.repo(r.owner.username, r.name),
    })),
  });

  const refresh = (fullName: string) => {
    const [o, n] = split(fullName);
    return Promise.all([
      qc.invalidateQueries({ queryKey: qk.namespace(handle) }),
      qc.invalidateQueries({ queryKey: ['agents'] }),
      qc.invalidateQueries({ queryKey: ['repo', o, n] }),
      qc.invalidateQueries({ queryKey: qk.repos }),
    ]);
  };
  const turnOff = useMutation({
    mutationFn: (fullName: string) => {
      const [o, n] = split(fullName);
      return api.removeAgent(o, n, handle);
    },
    onSuccess: async (_r, fullName) => {
      await refresh(fullName);
      toast(`Turned off ${agent.name} on ${fullName}`);
    },
  });
  const add = useMutation({
    mutationFn: (fullName: string) => {
      const [o, n] = split(fullName);
      return api.inviteAgent(o, n, handle);
    },
    onSuccess: async (_r, fullName) => {
      setChoice('');
      await refresh(fullName);
      toast(`Added ${agent.name} to ${fullName}`);
    },
  });

  const all = useQuery({
    queryKey: qk.repos,
    queryFn: api.repos,
    enabled: !agent.deletedAt,
  });
  const agentList = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const choices = inviteChoices(all.data ?? [], {
    invited: rows.map((r) => r.fullName),
    agentRepos: (agentList.data ?? []).map((a) => a.repository),
    me,
  });
  const picked = choices.some((r) => r.fullName === choice) ? choice : '';

  return (
    <Section
      title="Where it reviews"
      actions={
        <span className="muted small">
          {rows.length === 1 ? '1 repository' : `${rows.length} repositories`}
        </span>
      }
    >
      <div className="panel">
        {rows.length === 0 ? (
          <EmptyState
            picture={<CrewIcon size={20} />}
            title={
              agent.deletedAt
                ? 'It was removed from every repository'
                : 'It is not on a repository you can see'
            }
            body={
              agent.deletedAt
                ? 'A deleted agent no longer reviews anything.'
                : 'Add it to a repository below, or from that repository’s settings. Until then it reviews nothing.'
            }
          />
        ) : (
          <ul className="ag-where">
            {rows.map((r, i) => {
              const status = doing.get(r.fullName.toLowerCase());
              const canTurnOff = details[i]?.data?.permissions.admin ?? false;
              const mine = turnOff.variables === r.fullName;
              return (
                <li key={r.id}>
                  <div className="ag-where-main">
                    <Link to={`/${r.fullName}`}>{r.fullName}</Link>
                    {status && (
                      <>
                        <Chip status={status.status} />
                        {status.number !== null && (
                          <Link
                            className="small"
                            to={`/${r.fullName}/pull/${status.number}`}
                          >
                            #{status.number}
                          </Link>
                        )}
                      </>
                    )}
                  </div>
                  {canTurnOff && (
                    <InlineConfirm
                      label="Turn off"
                      confirmLabel="Turn off"
                      pendingLabel="Turning off…"
                      accessibleName={`Turn off ${agent.name} on ${r.fullName}`}
                      pending={turnOff.isPending && mine}
                      error={
                        turnOff.isError && mine
                          ? errorMessage(turnOff.error)
                          : null
                      }
                      onConfirm={() => turnOff.mutate(r.fullName)}
                    />
                  )}
                  {canTurnOff && agent.guarded && (
                    <p className="ag-where-note muted">
                      {agent.name} is a guarded reviewer. With it off, changes
                      here can merge without its review.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!agent.deletedAt && choices.length > 0 && (
          <form
            className="ag-invite"
            onSubmit={(e) => {
              e.preventDefault();
              if (picked) add.mutate(picked);
            }}
          >
            <label className="sr" htmlFor="agent-add-repo">
              Add {agent.name} to a repository
            </label>
            <select
              id="agent-add-repo"
              className="form-select"
              value={picked}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">Add to a repository…</option>
              {choices.map((r) => (
                <option key={r.id} value={r.fullName}>
                  {r.fullName}
                </option>
              ))}
            </select>
            <PendingButton
              type="submit"
              className="small primary"
              pending={add.isPending}
              pendingLabel="Adding…"
              disabled={!picked}
              error={add.isError ? errorMessage(add.error) : null}
            >
              Add
            </PendingButton>
          </form>
        )}
      </div>
    </Section>
  );
}
