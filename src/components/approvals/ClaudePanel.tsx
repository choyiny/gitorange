import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldIcon, UndoIcon } from '@primer/octicons-react';
import { api, qk, type Delegations, type DelegatedEvent } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { AI_NAME, clockTime, delegatedText, possessive } from '@/lib/claudeLog';
import { AgentAvatar } from '@/components/AgentAvatar';
import { PendingButton } from '@/components/ui/PendingButton';
import { useToast } from '@/components/ui/Toast';
import { QueryError } from '@/components/actions/states';
import { useRefresh } from './actions';
import { PanelError } from './Panels';

/** Claude's tile, where an answer was Claude's. */
export function ClaudeTile() {
  return (
    <span className="mono-tile ap-tile-sm" aria-hidden="true">
      C
    </span>
  );
}

const andList = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Guarded agents last (they can't be handed to Claude), otherwise as the server lists them. */
const ordered = (agents: Delegations['agents']) => [
  ...agents.filter((a) => !a.guarded),
  ...agents.filter((a) => a.guarded),
];

/**
 * The aside on Approvals: which agents' findings Claude (GitOrange AI) answers for you on your pull requests, and
 * what it answered today, each with Undo while the pull request is open.
 */
export function ClaudePanel({ myName }: { myName: string }) {
  const q = useQuery({ queryKey: qk.delegations, queryFn: api.delegations });
  return (
    <aside className="ap-side" aria-label="Claude decisions">
      <DelegationBox q={q} myName={myName} />
      {/* The box above already says the list didn't load, with Retry. */}
      {!(q.isError && !q.data) && <TodayBox q={q} myName={myName} />}
    </aside>
  );
}

type Q = ReturnType<typeof useQuery<Delegations>>;

function DelegationBox({ q, myName }: { q: Q; myName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const noteId = useId();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = q.data;

  const toggle = async (handle: string, on: boolean) => {
    if (!data || saving) return;
    const agent = data.agents.find((a) => a.handle === handle);
    if (!agent || agent.guarded) return;
    const next = data.agents
      .filter((a) => !a.guarded && (a.handle === handle ? on : a.delegated))
      .map((a) => a.handle);
    setSaving(handle);
    setError(null);
    try {
      qc.setQueryData(qk.delegations, await api.setDelegations(next));
      toast(
        on
          ? `${AI_NAME} now answers ${possessive(agent.name)} findings`
          : `${possessive(agent.name)} findings come to you`
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const guarded = data?.agents.filter((a) => a.guarded).map((a) => a.name);
  return (
    <section className="ap-box" aria-labelledby={`${noteId}-h`}>
      <div className="ap-box-head">
        <h2 id={`${noteId}-h`}>
          <ClaudeTile />
          Let {AI_NAME} decide for you
        </h2>
      </div>
      <p className="ap-side-lede">
        {AI_NAME} can answer findings on your pull requests for you. Each answer
        is recorded as “by {AI_NAME} for {myName}”, and you can undo it while
        the pull request is open.
      </p>
      {q.isError && !data ? (
        <QueryError
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Your reviewers did not load"
        />
      ) : !data ? (
        <div
          className="ap-pad"
          role="status"
          aria-busy="true"
          aria-label="Loading"
        >
          <div className="sk sk-row" />
          <div className="sk sk-row" />
        </div>
      ) : !data.agents.length ? (
        <p className="ap-side-lede muted">
          No reviewer agents yet. A site admin adds them from Agents.
        </p>
      ) : (
        <ul
          className="ap-toggles"
          aria-label={`Reviewers ${AI_NAME} answers for`}
        >
          {ordered(data.agents).map((a) => {
            const on = !a.guarded && a.delegated;
            return (
              <li key={a.handle}>
                <label
                  className={`ap-toggle${a.guarded ? ' is-locked' : ''}`}
                  title={
                    a.guarded
                      ? `${possessive(a.name)} findings always come to a person: ${AI_NAME} never decides them.`
                      : undefined
                  }
                >
                  <AgentAvatar
                    handle={a.handle}
                    color={a.color}
                    status="idle"
                    size={24}
                  />
                  <span className="ap-toggle-txt">
                    <b>{a.name}</b>
                    <small>
                      {a.guarded ? (
                        <>
                          <ShieldIcon size={11} /> Always comes to you
                        </>
                      ) : on ? (
                        `${AI_NAME} answers`
                      ) : (
                        'You answer'
                      )}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={on}
                    disabled={a.guarded || saving !== null}
                    aria-busy={saving === a.handle || undefined}
                    aria-describedby={a.guarded ? noteId : undefined}
                    onChange={(e) => void toggle(a.handle, e.target.checked)}
                  />
                  <span className="ap-switch" aria-hidden="true" />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <PanelError error={error} />
      {!!guarded?.length && (
        <p className="ap-note" id={noteId}>
          {andList(guarded)} findings always come to you: {AI_NAME} never
          decides them, and approving one needs your reason.
        </p>
      )}
    </section>
  );
}

function TodayBox({ q, myName }: { q: Q; myName: string }) {
  const toast = useToast();
  const refresh = useRefresh();
  const headId = useId();
  const [undoing, setUndoing] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const data = q.data;
  const names = new Map(data?.agents.map((a) => [a.handle, a.name]));

  const undo = async (e: DelegatedEvent) => {
    if (!e.repo || e.pull === null || undoing) return;
    const [owner, name] = e.repo.split('/');
    setUndoing(e.id);
    setErrors((m) => ({ ...m, [e.id]: '' }));
    try {
      await api.undoFlag(owner, name, e.pull, e.data.finding);
      toast('Undone. It’s back in your list.', {
        icon: <UndoIcon size={16} />,
      });
    } catch (err) {
      setErrors((m) => ({ ...m, [e.id]: errorMessage(err) }));
    } finally {
      await refresh(owner, name);
      setUndoing(null);
    }
  };

  return (
    <section className="ap-box" aria-labelledby={headId}>
      <div className="ap-box-head">
        <h2 id={headId}>What {AI_NAME} did today</h2>
      </div>
      {!data ? (
        <div
          className="ap-pad"
          role="status"
          aria-busy="true"
          aria-label="Loading"
        >
          <div className="sk sk-row" />
        </div>
      ) : !data.today.length ? (
        <p className="ap-side-lede muted">
          {AI_NAME} hasn’t answered anything for you today.
        </p>
      ) : (
        <ol className="ap-log">
          {data.today.map((e) => {
            const agent =
              names.get(e.data.agent) ?? `@${e.data.agent || 'agent'}`;
            return (
              <li key={e.id}>
                <time
                  className="ap-time"
                  dateTime={new Date(e.at).toISOString()}
                >
                  {clockTime(e.at)}
                </time>
                <div className="ap-log-body">
                  <p>
                    <Link
                      to={`/approvals/${encodeURIComponent(e.data.finding)}`}
                    >
                      {delegatedText(e, agent)}
                    </Link>
                    {e.repo && <span className="ap-ctxt">{e.repo}</span>}
                  </p>
                  {e.data.reason && (
                    <p className="ap-small ap-why">{e.data.reason}</p>
                  )}
                  {e.data.undone ? (
                    <p className="ap-small">
                      <UndoIcon size={13} />
                      Undone. It’s back in your list.
                    </p>
                  ) : (
                    <p className="ap-log-foot">
                      <span className="who">
                        <ClaudeTile />
                        by {AI_NAME} for {myName}
                      </span>
                      {e.data.undoable ? (
                        <PendingButton
                          className="quiet small"
                          pending={undoing === e.id}
                          pendingLabel="Undoing…"
                          disabled={undoing !== null}
                          aria-label={`Undo: ${delegatedText(e, agent)}`}
                          onClick={() => void undo(e)}
                        >
                          <UndoIcon size={14} />
                          Undo
                        </PendingButton>
                      ) : e.data.decision === 'leave' ? (
                        <span className="ap-small">Waiting for you</span>
                      ) : null}
                    </p>
                  )}
                  <PanelError error={errors[e.id]} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
