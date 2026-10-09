import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo, fullDate } from '@/lib/format';
import { AgentAvatar } from '@/components/AgentAvatar';
import { InlineConfirm } from '@/components/InlineConfirm';
import { LoadError, Notice } from '@/components/Notice';
import { AdminFrame, RowsSkeleton } from '@/components/SetFrame';
import { CrewIcon } from '@/components/shell/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { Section } from '@/components/ui/Section';

/**
 * Site admin → Agents: every reviewer agent with its repository, and the one thing the directory doesn't do:
 * delete. Creating moved to New reviewer (`/agents/new`), reading to the directory (`/agents`).
 */
export default function AdminAgents() {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const [deleted, setDeleted] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (handle: string) => api.deleteAgent(handle),
    onSuccess: (_r, handle) => {
      setDeleted(handle);
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.namespace(handle) });
    },
  });
  const list = agents.data ?? [];

  return (
    <>
      <PageHead
        icon="shield"
        crumbs={[{ label: 'Site admin', to: '/admin' }, { label: 'Agents' }]}
        title="Agents"
        lede="Reviewer agents are accounts that review pull requests in the repositories that invite them. Each one is defined by AGENT.md in its own repository, which anyone who can push there can edit."
        actions={
          <>
            <Link className="btn" to="/agents">
              Agents directory
            </Link>
            <Link className="btn primary" to="/agents/new">
              <PlusIcon />
              New reviewer
            </Link>
          </>
        }
      />
      <AdminFrame>
        <Section
          title="Reviewer agents"
          actions={
            agents.data && (
              <span className="muted small">
                {list.length === 1 ? '1 agent' : `${list.length} agents`}
              </span>
            )
          }
        >
          {deleted && (
            <Notice tone="ok">
              Deleted @{deleted}. It’s removed from every repository; its past
              reviews keep its name, and its repository stays until you delete
              it.
            </Notice>
          )}
          <div className="panel">
            {agents.isError ? (
              <LoadError
                what="the agents"
                error={agents.error}
                onRetry={() => void agents.refetch()}
              />
            ) : agents.isPending ? (
              <RowsSkeleton rows={3} />
            ) : list.length === 0 ? (
              <EmptyState
                picture={<CrewIcon size={20} />}
                title="No agents yet."
                body="Create the recommended crew, or a reviewer of your own."
                action={
                  <Link className="btn small primary" to="/agents/new">
                    New reviewer
                  </Link>
                }
              />
            ) : (
              <ul className="rowlist">
                {list.map((a) => (
                  <li key={a.id}>
                    <AgentAvatar
                      handle={a.username}
                      color={a.color}
                      size={40}
                    />
                    <div className="grow">
                      <span className="wrap">
                        <Link to={`/${a.username}`}>
                          <b>{a.username}</b>
                        </Link>{' '}
                        <span className="muted">{a.name}</span>
                      </span>
                      <span className="small muted wrap">
                        {a.repository ? (
                          <Link to={`/${a.repository}`}>{a.repository}</Link>
                        ) : (
                          'Repository deleted'
                        )}{' '}
                        ·{' '}
                        <span title={fullDate(a.createdAt)}>
                          created {timeAgo(a.createdAt)}
                        </span>
                      </span>
                      {a.configError && (
                        <span className="small attention wrap">
                          {a.configError}
                        </span>
                      )}
                    </div>
                    <div className="ctl">
                      <InlineConfirm
                        label="Delete"
                        confirmLabel={`Delete @${a.username}`}
                        pendingLabel="Deleting…"
                        accessibleName={`Delete @${a.username}`}
                        pending={
                          remove.isPending && remove.variables === a.username
                        }
                        error={
                          remove.isError && remove.variables === a.username
                            ? errorMessage(remove.error)
                            : null
                        }
                        onConfirm={() => {
                          setDeleted(null);
                          remove.mutate(a.username);
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </AdminFrame>
    </>
  );
}
