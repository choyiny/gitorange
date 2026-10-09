import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BookIcon,
  CheckIcon,
  PersonIcon,
  ShieldIcon,
  SyncIcon,
  XIcon,
} from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { askCandidates } from '@/lib/approvalsInbox';
import { errorMessage } from '@/lib/api';
import { PendingButton } from '@/components/ui/PendingButton';

/** The server's limits for a note, a reason and a teach note. */
export const TEXT_MAX = 1000;

/** Escape inside an open panel closes it (the list's own shortcuts ignore keys typed in fields). */
const escapeCloses =
  (onCancel: () => void) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onCancel();
  };

export function PanelError({ error }: { error: string | null | undefined }) {
  return error ? (
    <p className="ap-error" role="alert">
      {error}
    </p>
  ) : null;
}

/**
 * "Remember this for next time": a rule in the person's words, which the agent learns when the pull request
 * closes. `label` is the checkbox's words.
 */
export function TeachField({
  agentName,
  pull,
  on,
  text,
  onToggle,
  onText,
  label,
}: {
  agentName: string;
  pull: number;
  on: boolean;
  text: string;
  onToggle(on: boolean): void;
  onText(text: string): void;
  label?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ap-teach">
      <label className="ap-check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {label ?? <>Save a rule so {agentName} doesn’t ask again</>}
      </label>
      {on && (
        <>
          <label className="ap-label" htmlFor={id}>
            The rule {agentName} learns
          </label>
          <textarea
            id={id}
            className="ap-input"
            rows={2}
            maxLength={TEXT_MAX}
            value={text}
            placeholder="For example: links marked public may skip sign-in."
            onChange={(e) => onText(e.target.value)}
          />
          <p className="ap-small">
            <BookIcon size={13} />
            {agentName} learns it when #{pull} closes. Undoing your answer drops
            it.
          </p>
        </>
      )}
    </div>
  );
}

/** A teach note as the API takes it: only when the box is ticked and something is written. */
export const teachText = (on: boolean, text: string) =>
  on && text.trim() ? text.trim() : null;

/** Request changes: a note for the pull request's author, and an optional rule. */
export function ChangesPanel({
  id,
  agentName,
  pull,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  id: string;
  agentName: string;
  pull: number;
  pending: boolean;
  error?: string | null;
  onSubmit(note: string, teach: string | null): void;
  onCancel(): void;
}) {
  const [note, setNote] = useState('');
  const [teachOn, setTeachOn] = useState(false);
  const [teach, setTeach] = useState('');
  return (
    <div className="ap-panel" id={id} onKeyDown={escapeCloses(onCancel)}>
      <label className="ap-label" htmlFor={`${id}-note`}>
        What should change? <span className="muted">(optional)</span>
      </label>
      <textarea
        id={`${id}-note`}
        className="ap-input"
        rows={2}
        maxLength={TEXT_MAX}
        value={note}
        autoFocus
        onChange={(e) => setNote(e.target.value)}
      />
      <p className="ap-small">
        The pull request’s author gets this with {agentName}’s finding.
      </p>
      <TeachField
        agentName={agentName}
        pull={pull}
        on={teachOn}
        text={teach}
        onToggle={setTeachOn}
        onText={setTeach}
      />
      <div className="ap-actions">
        <PendingButton
          className="primary small"
          pending={pending}
          pendingLabel="Sending…"
          disabled={teachOn && !teach.trim()}
          onClick={() => onSubmit(note, teachText(teachOn, teach))}
        >
          <SyncIcon size={14} />
          Request changes
        </PendingButton>
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <PanelError error={error} />
    </div>
  );
}

/**
 * Dismiss: the finding needs no change. A reason (required for a guarded agent, where it goes in the audit log)
 * and an optional rule so the agent doesn't ask again.
 */
export function DismissPanel({
  id,
  agentName,
  pull,
  guarded,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  id: string;
  agentName: string;
  pull: number;
  guarded: boolean;
  pending: boolean;
  error?: string | null;
  onSubmit(reason: string, teach: string | null): void;
  onCancel(): void;
}) {
  const [reason, setReason] = useState('');
  const [teachOn, setTeachOn] = useState(false);
  const [teach, setTeach] = useState('');
  const missing = (guarded && !reason.trim()) || (teachOn && !teach.trim());
  return (
    <div className="ap-panel" id={id} onKeyDown={escapeCloses(onCancel)}>
      <label className="ap-label" htmlFor={`${id}-why`}>
        Reason {!guarded && <span className="muted">(optional)</span>}
      </label>
      <textarea
        id={`${id}-why`}
        className="ap-input"
        rows={2}
        maxLength={TEXT_MAX}
        value={reason}
        autoFocus
        aria-required={guarded}
        placeholder="Why doesn’t this need a change?"
        onChange={(e) => setReason(e.target.value)}
      />
      {guarded && (
        <p className="ap-small">
          <ShieldIcon size={13} />
          {agentName} findings need a reason. It goes in the audit log with your
          name.
        </p>
      )}
      <TeachField
        agentName={agentName}
        pull={pull}
        on={teachOn}
        text={teach}
        onToggle={setTeachOn}
        onText={setTeach}
      />
      <div className="ap-actions">
        <PendingButton
          className="primary small"
          pending={pending}
          pendingLabel="Dismissing…"
          disabled={missing}
          onClick={() => onSubmit(reason, teachText(teachOn, teach))}
        >
          {teachOn ? <BookIcon size={14} /> : <XIcon size={14} />}
          {teachOn ? 'Dismiss and save a rule' : 'Dismiss'}
        </PendingButton>
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <PanelError error={error} />
    </div>
  );
}

const REASONS: [string, string][] = [
  ['False positive', 'The finding is wrong.'],
  ['Accepted risk', 'The risk is real and you accept it.'],
  ['Intended behaviour', 'It works this way on purpose.'],
];

/** The reason sent for a guarded approval: the choice, then the note. */
export const approvalReason = (choice: string, note: string) =>
  note.trim() ? `${choice}. ${note.trim()}` : choice;

/** Approve a guarded agent's finding: a reason is required and goes in the audit log. */
export function ApproveReasonPanel({
  id,
  agentName,
  pull,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  id: string;
  agentName: string;
  pull: number;
  pending: boolean;
  error?: string | null;
  onSubmit(reason: string, teach: string | null): void;
  onCancel(): void;
}) {
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [teachOn, setTeachOn] = useState(false);
  const [teach, setTeach] = useState('');
  return (
    <fieldset className="ap-panel" id={id} onKeyDown={escapeCloses(onCancel)}>
      <legend className="ap-label">Reason for approving</legend>
      {REASONS.map(([r, help], i) => (
        <label className="ap-radio" key={r}>
          <input
            type="radio"
            name={`${id}-reason`}
            value={r}
            checked={choice === r}
            autoFocus={i === 0}
            onChange={() => setChoice(r)}
          />
          <span>
            <b>{r}</b>
            <small>{help}</small>
          </span>
        </label>
      ))}
      <label className="ap-label" htmlFor={`${id}-note`}>
        Note for the audit log <span className="muted">(optional)</span>
      </label>
      <textarea
        id={`${id}-note`}
        className="ap-input"
        rows={2}
        maxLength={TEXT_MAX - 40}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <p className="ap-small">
        <ShieldIcon size={13} />
        Recorded in the audit log with your name and reason.
      </p>
      <TeachField
        agentName={agentName}
        pull={pull}
        on={teachOn}
        text={teach}
        onToggle={setTeachOn}
        onText={setTeach}
      />
      <div className="ap-actions">
        <PendingButton
          className="primary small"
          pending={pending}
          pendingLabel="Approving…"
          disabled={!choice || (teachOn && !teach.trim())}
          onClick={() =>
            onSubmit(approvalReason(choice, note), teachText(teachOn, teach))
          }
        >
          <CheckIcon size={14} />
          Approve
        </PendingButton>
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <PanelError error={error} />
    </fieldset>
  );
}

/** The people who can push to a repository (and so decide its findings), for "Ask someone". */
export function useAskCandidates(
  owner: string,
  name: string,
  me: string | null
) {
  const members = useQuery({ queryKey: qk.members, queryFn: api.members });
  const collaborators = useQuery({
    queryKey: qk.collaborators(owner, name),
    queryFn: () => api.collaborators(owner, name),
  });
  return {
    people:
      members.data && collaborators.data
        ? askCandidates({
            members: members.data,
            collaborators: collaborators.data,
            owner,
            me,
          })
        : null,
    error: members.error ?? collaborators.error,
    retry: () => {
      void members.refetch();
      void collaborators.refetch();
    },
  };
}

/** Ask someone with push rights to decide; or take the question back from whoever has it. */
export function AskPanel({
  id,
  owner,
  name,
  me,
  assignee,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  id: string;
  owner: string;
  name: string;
  me: string | null;
  /** Who has it now. */
  assignee: { login: string; name: string | null } | null;
  pending: boolean;
  error?: string | null;
  onSubmit(login: string | null): void;
  onCancel(): void;
}) {
  const { people, error: loadError, retry } = useAskCandidates(owner, name, me);
  const [pick, setPick] = useState('');
  const chosen = people?.find((p) => p.login === pick);
  return (
    <fieldset className="ap-panel" id={id} onKeyDown={escapeCloses(onCancel)}>
      <legend className="ap-label">Who should decide?</legend>
      <p className="ap-small">
        <PersonIcon size={13} />
        Anyone who can push to {owner}/{name} can decide its findings.
      </p>
      {loadError ? (
        <p className="ap-error" role="alert">
          {errorMessage(loadError)}{' '}
          <button type="button" className="btn quiet small" onClick={retry}>
            Retry
          </button>
        </p>
      ) : !people ? (
        <div className="sk sk-row" role="status" aria-label="Loading people" />
      ) : !people.length ? (
        <p className="ap-small">Nobody else can push to this repository.</p>
      ) : (
        <div className="ap-people">
          {people.map((p, i) => (
            <label className="ap-radio" key={p.login}>
              <input
                type="radio"
                name={`${id}-who`}
                value={p.login}
                checked={pick === p.login}
                autoFocus={i === 0}
                onChange={() => setPick(p.login)}
              />
              <span>
                <b>{p.name}</b>
                <small>
                  @{p.login}
                  {assignee?.login === p.login ? ' · has it now' : ''}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="ap-actions">
        <PendingButton
          className="primary small"
          pending={pending}
          pendingLabel="Asking…"
          disabled={!chosen || chosen.login === assignee?.login}
          onClick={() => chosen && onSubmit(chosen.login)}
        >
          <PersonIcon size={14} />
          {chosen ? `Ask ${chosen.name}` : 'Ask'}
        </PendingButton>
        {assignee && (
          <button
            type="button"
            className="btn small"
            disabled={pending}
            onClick={() => onSubmit(null)}
          >
            {assignee.login === me
              ? 'Unassign yourself'
              : `Take it back from ${assignee.name || assignee.login}`}
          </button>
        )}
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <PanelError error={error} />
    </fieldset>
  );
}
