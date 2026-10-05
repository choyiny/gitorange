import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DependabotIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';
import { Spinner } from '@/components/Spinner';
import { AdminNav } from '@/components/AdminNav';

/** Site admin → Agents: create reviewer agents, list them, delete them. */
export default function AdminAgents() {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const [form, setForm] = useState<{ handle: string; name: string } | null>(
    null
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const [flash, setFlash] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const create = useMutation({
    mutationFn: () => api.createAgent(form!),
    onSuccess: ({ agent }) => {
      setFlash({
        kind: 'success',
        text: `Created @${agent.username}. Edit AGENT.md in ${agent.repository} to say what it reviews.`,
      });
      setForm(null);
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.repos });
    },
    onError: (e) => setFlash({ kind: 'error', text: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (handle: string) => api.deleteAgent(handle),
    onSuccess: (_r, handle) => {
      setFlash({
        kind: 'success',
        text: `Deleted @${handle}. It's removed from every repository; its past reviews keep its name, and its repository stays until you delete it.`,
      });
      setConfirm(null);
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.namespace(handle) });
    },
    onError: (e) => setFlash({ kind: 'error', text: errorMessage(e) }),
  });

  return (
    <>
      <Header context={<span className="text-bold px-2">Site admin</span>} />
      <div className="container-lg px-3 py-4">
        <AdminNav />
        <div className="Subhead">
          <h2
            className="Subhead-heading d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <DependabotIcon size={24} /> Agents
          </h2>
          <div className="Subhead-description">
            Reviewer agents are accounts that review pull requests in the
            repositories that invite them. Each one is defined by AGENT.md in
            its own repository, which anyone who can push there can edit.
          </div>
          <div className="Subhead-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setForm(form ? null : { handle: '', name: '' })}
            >
              New agent
            </button>
          </div>
        </div>
        {flash && (
          <div className={`flash flash-${flash.kind} mb-3`}>{flash.text}</div>
        )}
        {form && (
          <form
            className="Box p-3 mb-4 d-flex flex-wrap flex-items-end"
            style={{ gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              setFlash(null);
              create.mutate();
            }}
          >
            <div className="flex-1">
              <label
                htmlFor="agent-handle"
                className="d-block f6 text-bold mb-1"
              >
                Handle
              </label>
              <input
                id="agent-handle"
                className="form-control width-full input-monospace"
                required
                placeholder="securityagent"
                value={form.handle}
                onChange={(e) => setForm({ ...form, handle: e.target.value })}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="agent-name" className="d-block f6 text-bold mb-1">
                Display name
              </label>
              <input
                id="agent-name"
                className="form-control width-full"
                required
                placeholder="Security Agent"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <button className="btn btn-primary" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create agent'}
            </button>
            <p className="f6 color-fg-muted width-full mb-0">
              Creates @{form.handle || 'handle'} and its repository{' '}
              <code>
                {form.handle || 'handle'}/{form.handle || 'handle'}
              </code>{' '}
              with a starter AGENT.md, an avatar and a knowledge folder. You
              become a collaborator on it.
            </p>
          </form>
        )}
        {agents.isPending ? (
          <Spinner />
        ) : agents.data!.length === 0 ? (
          <div className="blankslate">
            <h3 className="blankslate-heading">No agents yet.</h3>
          </div>
        ) : (
          <div className="Box">
            {agents.data!.map((a) => (
              <div
                key={a.id}
                className="Box-row d-flex flex-items-center"
                style={{ gap: 12 }}
              >
                <Avatar user={a} size={32} />
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <Link
                    to={`/${a.username}`}
                    className="text-bold color-fg-default"
                  >
                    {a.username}
                  </Link>
                  <span className="color-fg-muted ml-2">{a.name}</span>
                  <div className="f6 color-fg-muted">
                    {a.repository ? (
                      <Link to={`/${a.repository}`}>{a.repository}</Link>
                    ) : (
                      'Repository deleted'
                    )}{' '}
                    · created {timeAgo(a.createdAt)}
                  </div>
                  {a.configError && (
                    <div className="f6 color-fg-attention">{a.configError}</div>
                  )}
                </div>
                {confirm === a.username ? (
                  <>
                    <button
                      className="btn btn-sm btn-danger"
                      aria-label={`Delete @${a.username}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        setFlash(null);
                        remove.mutate(a.username);
                      }}
                    >
                      Delete @{a.username}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-sm btn-danger"
                    aria-label={`Delete @${a.username}`}
                    onClick={() => setConfirm(a.username)}
                  >
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
