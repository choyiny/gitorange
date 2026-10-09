import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  BookIcon,
  CheckIcon,
  FileIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  InboxIcon,
  PeopleIcon,
  PersonIcon,
  ShieldIcon,
  SyncIcon,
  UndoIcon,
  XIcon,
} from '@primer/octicons-react';
import { api, qk, type Finding as FindingData } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { useApprovalPages } from '@/lib/approvals';
import {
  dedupeItems,
  inboxRows,
  isDecided,
  splitFindingDetail,
} from '@/lib/approvalsInbox';
import {
  AI_NAME,
  decidedByText,
  findingEventText,
  possessive,
} from '@/lib/claudeLog';
import { shortSha, timeAgo } from '@/lib/format';
import { agentColor, type AgentStatus } from '@/lib/agentLook';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Markdown } from '@/components/Markdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePageHead } from '@/components/ui/PageHead';
import { PendingButton } from '@/components/ui/PendingButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { Verdict } from '@/components/ui/Verdict';
import { QueryError } from '@/components/actions/states';
import { failure, useRefresh } from '@/components/approvals/actions';
import { ClaudeTile } from '@/components/approvals/ClaudePanel';
import { agentName as userAgentName } from '@/components/approvals/InboxRow';
import {
  ApproveReasonPanel,
  AskPanel,
  ChangesPanel,
  DismissPanel,
  PanelError,
  TEXT_MAX,
  TeachField,
  teachText,
  useAskCandidates,
} from '@/components/approvals/Panels';

const nameOf = (f: FindingData) => f.agent?.name ?? 'A removed agent';
const handleOf = (f: FindingData) => f.agent?.login ?? 'agent';
/** An owner question: a plain yes/no for the person, answered with Yes / No, fix it / Ask someone. */
const isQuestion = (f: FindingData) =>
  f.kind === 'needs_person' && !!f.question;

/** The agent's face for the finding's state. */
function statusOf(f: FindingData): AgentStatus {
  if (f.state === 'open') return 'needs';
  if (f.state === 'changes_requested') return 'changes_requested';
  return f.teach ? 'learned' : 'approved';
}

/** One finding (`/approvals/:flagId`): an owner question or a developer finding, its decision, teaching, asking
 * someone, letting Claude decide, and its history. */
export default function Finding() {
  const { flagId = '' } = useParams();
  const q = useQuery({
    queryKey: qk.approvalFlag(flagId),
    queryFn: () => api.approvalFlag(flagId),
  });
  const f = q.data;
  const notFound = !f && q.error instanceof ApiError && q.error.status === 404;
  usePageHead({
    icon: 'inbox',
    crumbs: [
      { label: 'Approvals', to: '/approvals' },
      {
        label: f
          ? `${nameOf(f)} on #${f.pull.number}`
          : notFound
            ? 'Not found'
            : 'Finding',
      },
    ],
    title: f
      ? isQuestion(f)
        ? f.question!
        : f.title
      : notFound
        ? 'Finding not found'
        : 'Finding',
    documentTitle: f ? `${nameOf(f)} on #${f.pull.number}` : undefined,
  });

  if (notFound)
    return (
      <div className="ap">
        <div className="panel">
          <EmptyState
            picture={<InboxIcon size={24} />}
            title="Finding not found"
            body="This finding doesn’t exist, or you can’t see its repository."
            action={
              <Link className="btn small" to="/approvals">
                Back to Approvals
              </Link>
            }
          />
        </div>
      </div>
    );
  if (q.isError && !f)
    return (
      <div className="ap">
        <div className="panel">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            title="This finding did not load"
          />
        </div>
      </div>
    );
  if (!f) return <Skeleton kind="detail" />;
  return <FindingView f={f} />;
}

function FindingView({ f }: { f: FindingData }) {
  const me = useCurrentUser()?.username ?? null;
  const name = nameOf(f);
  const handle = handleOf(f);
  const color = agentColor(handle, f.agent?.color);
  const question = isQuestion(f);
  const parts = splitFindingDetail(f.detail);
  const n = f.pull.number;
  const repo = f.repo.fullName;
  const prLink = (
    <Link to={`/${repo}/pull/${n}`} className="mono">
      #{n}
    </Link>
  );
  const sha = <span className="mono">{shortSha(f.headSha)}</span>;
  const waiting = f.state === 'open' || f.state === 'changes_requested';
  const md = (source: string | null) =>
    source ? <Markdown source={source} className="ap-md" /> : null;

  return (
    <div className="ap" style={{ '--agent': color } as CSSProperties}>
      <header className="ap-fhead">
        <AgentAvatar
          handle={handle}
          color={color}
          status={statusOf(f)}
          size={56}
        />
        <div className="ap-fhead-main">
          <span className="eyebrow">
            {f.kind === 'change_requested'
              ? `${name} asked for a change`
              : `${name} is asking`}{' '}
            · {repo} · #{n}
          </span>
          <h2 className="ph-title">{question ? f.question : f.title}</h2>
          <p className="lede">
            {question ? (
              <>
                {name} is asking about {prLink} {f.pull.title}. You’re answering
                for commit {sha}.
              </>
            ) : (
              <>
                {name} raised this on {prLink} {f.pull.title}, at commit {sha}.
              </>
            )}
          </p>
        </div>
      </header>

      <div className="ap-cols">
        <div className="ap-col">
          {(parts.sentence || question) && (
            <p className="ap-plain">{parts.sentence ?? f.title}</p>
          )}
          <div className="ap-advice">
            {f.guarded ? <ShieldIcon size={16} /> : <PersonIcon size={16} />}
            <span>
              {question ? (
                <>
                  <b>{possessive(name)} finding.</b> {f.title}
                </>
              ) : f.kind === 'change_requested' ? (
                <>
                  <b>{name} asked for a change.</b>
                  {waiting &&
                    ' The pull request’s author makes it, or you can dismiss it.'}
                </>
              ) : (
                <>
                  <b>{name} wants a person to decide.</b>
                  {waiting &&
                    ' Approve it if this is intended. Otherwise request changes.'}
                </>
              )}
            </span>
          </div>
          {md(parts.table)}
          {md(parts.diagram)}
          {/* A developer reads the cited lines first: excerpts start open here. */}
          {!question &&
            parts.excerpts.map((x, i) => (
              <div key={i}>{md(x.replace(/^<details>/, '<details open>'))}</div>
            ))}
          {md(parts.rest)}
          {!f.detail && (
            <p className="ap-small">
              No further detail: the review model didn’t answer.
            </p>
          )}
          {f.state !== 'open' && <Outcome f={f} me={me} />}
          {waiting && f.can.decide ? (
            question ? (
              <OwnerAnswer f={f} me={me} />
            ) : (
              <DevAnswer f={f} me={me} />
            )
          ) : waiting ? (
            <p className="ap-small ap-cant">
              <ShieldIcon size={13} />
              {f.pull.state !== 'open'
                ? `#${n} is ${f.pull.state}, so its findings can’t be decided any more.`
                : `Only people who can push to ${repo} decide its findings.`}
            </p>
          ) : null}
        </div>
        <aside className="ap-col ap-aside" aria-label="About this finding">
          <Facts f={f} me={me} />
          <details className="ap-box ap-tech" open={!question}>
            <summary>Technical details</summary>
            <div className="ap-tech-body">
              {f.agent && (
                <p>
                  <Verdict
                    handle={handle}
                    name={name}
                    color={f.agent.color}
                    status={statusOf(f)}
                  />
                </p>
              )}
              {question &&
                parts.excerpts.map((x, i) => <div key={i}>{md(x)}</div>)}
              {f.paths.length > 0 && (
                <ul className="ap-files" aria-label="Files">
                  {f.paths.map((p) => (
                    <li key={p}>
                      <FileIcon size={14} />
                      <Link to={`/${repo}/pull/${n}/files#diff-${p}`}>{p}</Link>
                    </li>
                  ))}
                </ul>
              )}
              {f.agentSha && f.agent?.repository && (
                <p className="ap-small">
                  <BookIcon size={13} />
                  <span>
                    {name} reviewed with its instructions at{' '}
                    <Link
                      className="mono"
                      to={`/${f.agent.repository}/commit/${f.agentSha}`}
                    >
                      {shortSha(f.agentSha)}
                    </Link>
                    .
                  </span>
                </p>
              )}
              {f.detailModel && (
                <p className="ap-small">Written by {f.detailModel}.</p>
              )}
              <div className="ap-actions">
                <Link className="btn small" to={`/${repo}/pull/${n}`}>
                  Open #{n}
                </Link>
                {f.agent && (
                  <Link className="btn small quiet" to={`/${handle}`}>
                    About {name}
                  </Link>
                )}
              </div>
            </div>
          </details>
          <History f={f} me={me} />
        </aside>
      </div>
    </div>
  );
}

function Facts({ f, me }: { f: FindingData; me: string | null }) {
  const n = f.pull.number;
  const waiting = f.state === 'open' || f.state === 'changes_requested';
  const name = nameOf(f);
  const author = f.pull.author.name || `@${f.pull.author.login}`;
  const moved = f.pull.headSha && f.pull.headSha !== f.headSha;
  const items: [ReactNode, ReactNode][] = [
    [
      <GitPullRequestIcon size={14} />,
      <>
        <Link to={`/${f.repo.fullName}/pull/${n}`}>
          #{n} {f.pull.title}
        </Link>{' '}
        by {f.pull.author.login === me ? 'you' : author}, in {f.repo.fullName}
        {f.pull.state !== 'open' ? ` (${f.pull.state})` : ''}.
      </>,
    ],
    [
      <GitCommitIcon size={14} />,
      <>
        Raised on commit <span className="mono">{shortSha(f.headSha)}</span>.
        {moved && (
          <>
            {' '}
            The branch has moved on to{' '}
            <span className="mono">{shortSha(f.pull.headSha!)}</span> since.
          </>
        )}
      </>,
    ],
  ];
  if (f.guarded)
    items.push([
      <ShieldIcon size={14} />,
      `${f.kind === 'change_requested' ? 'Dismissing' : 'Approving'} needs a reason. It goes in the audit log with your name. ${AI_NAME} never decides ${name} findings.`,
    ]);
  if (f.assignee)
    items.push([
      <PeopleIcon size={14} />,
      `Assigned to ${f.assignee.login === me ? 'you' : f.assignee.name || `@${f.assignee.login}`}${
        f.assignedBy
          ? ` by ${f.assignedBy.login === me ? 'you' : f.assignedBy.name || `@${f.assignedBy.login}`}`
          : ''
      }${f.assignedAt ? `, ${timeAgo(new Date(f.assignedAt))}` : ''}.`,
    ]);
  if (f.delegated)
    items.push([
      <ClaudeTile />,
      `You let ${AI_NAME} decide ${possessive(name)} findings on your pull requests.`,
    ]);
  if (f.pull.state === 'open' && waiting)
    items.push([
      <UndoIcon size={14} />,
      `You can change your answer while #${n} is open.`,
    ]);
  return (
    <section className="ap-box" aria-labelledby="ap-facts-h">
      <div className="ap-box-head">
        <h2 id="ap-facts-h">
          {waiting ? 'Before you answer' : 'About this finding'}
        </h2>
      </div>
      <ul className="ap-facts">
        {items.map(([icon, text], i) => (
          <li key={i}>
            {icon}
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ f, me }: { f: FindingData; me: string | null }) {
  return (
    <section className="ap-box" aria-labelledby="ap-hist-h">
      <div className="ap-box-head">
        <h2 id="ap-hist-h">History</h2>
      </div>
      <ol className="ap-log">
        <li>
          <time
            className="ap-time"
            dateTime={new Date(f.createdAt).toISOString()}
          >
            {timeAgo(new Date(f.createdAt))}
          </time>
          <div className="ap-log-body">
            <p>{nameOf(f)} raised it.</p>
          </div>
        </li>
        {f.history.map((e) => (
          <li key={e.id}>
            <time className="ap-time" dateTime={new Date(e.at).toISOString()}>
              {timeAgo(new Date(e.at))}
            </time>
            <div className="ap-log-body">
              <p>{findingEventText(e, { me, agentName: nameOf(f) })}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The next finding waiting on you, from the Approvals list. */
function useNextFinding(id: string) {
  const q = useApprovalPages();
  const next = inboxRows(dedupeItems(q.data?.pages ?? [])).find(
    (r) => r.type === 'finding' && r.flag.id !== id && !isDecided(r.flag)
  );
  return next && next.type === 'finding'
    ? {
        to: `/approvals/${encodeURIComponent(next.flag.id)}`,
        label: `Next: ${userAgentName(next.agent)} on #${next.pull.number}`,
      }
    : null;
}

function NextLink({ id }: { id: string }) {
  const next = useNextFinding(id);
  return next ? (
    <Link className="btn primary small" to={next.to}>
      {next.label}
      <ArrowRightIcon size={14} />
    </Link>
  ) : (
    <Link className="btn primary small" to="/approvals">
      Back to Approvals
    </Link>
  );
}

/** Runs one answer: pending state, the toast (with Undo when it can be undone), the refresh, and the refusal. */
function useAnswer(f: FindingData) {
  const toast = useToast();
  const refresh = useRefresh();
  const [owner, repo] = f.repo.fullName.split('/');
  const n = f.pull.number;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (
    key: string,
    fn: () => Promise<unknown>,
    done: { toast: string; undo?: () => Promise<unknown> },
    opts: { sendingNote?: boolean } = {}
  ) => {
    if (pending) return false;
    setPending(key);
    setError(null);
    try {
      await fn();
      const undo = done.undo;
      toast(
        done.toast,
        undo
          ? {
              undo: () =>
                void undo()
                  .catch((e) => toast(failure(e)))
                  .finally(() => void refresh(owner, repo)),
            }
          : undefined
      );
      return true;
    } catch (e) {
      setError(failure(e, opts));
      return false;
    } finally {
      // Also after a refusal (409: the branch moved): the page shows the new state.
      await refresh(owner, repo);
      setPending(null);
    }
  };
  return { owner, repo, n, pending, error, setError, act };
}

function Outcome({ f, me }: { f: FindingData; me: string | null }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner, repo] = f.repo.fullName.split('/');
  const undo = async () => {
    setUndoing(true);
    setError(null);
    try {
      await api.undoFlag(owner, repo, f.pull.number, f.id);
      toast('Answer withdrawn. The finding is open again.', {
        icon: <UndoIcon size={16} />,
      });
    } catch (e) {
      setError(failure(e));
    } finally {
      await refresh(owner, repo);
      setUndoing(false);
    }
  };
  const name = nameOf(f);
  const n = f.pull.number;
  const by = decidedByText(f.decidedBy, f.decidedVia, me);
  const ai = by.startsWith(AI_NAME);
  const head =
    f.state === 'approved'
      ? 'Approved'
      : f.state === 'dismissed'
        ? 'Dismissed'
        : 'Changes requested';
  const next =
    f.state === 'changes_requested'
      ? `The pull request’s author makes the change, and ${name} reviews the new commit.`
      : f.pull.state === 'open'
        ? `#${n} no longer waits for this finding.`
        : f.pull.state === 'merged'
          ? `#${n} merged, so this decision stays. Revert it from the pull request if you need to.`
          : `#${n} is closed, so this decision stays.`;
  return (
    <section
      className={`panel ap-outcome ap-${f.state}`}
      aria-labelledby="ap-out-h"
    >
      {f.state === 'changes_requested' ? (
        <SyncIcon size={16} />
      ) : f.state === 'dismissed' ? (
        <XIcon size={16} />
      ) : (
        <CheckIcon size={16} />
      )}
      <div>
        <h2 id="ap-out-h">
          {head} by {by}
          {f.decidedAt ? `, ${timeAgo(new Date(f.decidedAt))}` : ''}
        </h2>
        {ai && (
          <p className="ap-small">
            <ClaudeTile />
            {AI_NAME} answered this for{' '}
            {f.decidedBy?.login === me ? 'you' : f.decidedBy?.name || 'them'}.
          </p>
        )}
        {f.reason && (
          <p>
            <b>{ai ? `${possessive(AI_NAME)} reason.` : 'Reason.'}</b>{' '}
            {f.reason}
          </p>
        )}
        {f.note && (
          <p>
            <b>Note.</b> “{f.note}”
          </p>
        )}
        {f.teach && (
          <>
            <figure className="ap-diff ap-diff-compact">
              <figcaption className="ap-diff-path">
                <BookIcon size={13} />
                <span>{f.agent?.repository ?? name} · AGENT.md</span>
              </figcaption>
              <div className="ap-line ap-add">
                <span aria-hidden="true">+</span>
                <span>
                  <span className="sr">Rule: </span>
                  {f.teach}
                </span>
              </div>
            </figure>
            <p className="ap-small">
              {name} learns this when #{n} closes
              {f.teachBy
                ? `, from ${f.teachBy.login === me ? 'you' : f.teachBy.name || `@${f.teachBy.login}`}`
                : ''}
              .
            </p>
          </>
        )}
        <p className="ap-small">{next}</p>
        <div className="ap-actions">
          {f.state !== 'changes_requested' && <NextLink id={f.id} />}
          {f.can.undo && (
            <PendingButton
              className="small"
              pending={undoing}
              pendingLabel="Reopening…"
              onClick={() => void undo()}
            >
              <UndoIcon size={14} />
              Change answer
            </PendingButton>
          )}
        </div>
        <PanelError error={error} />
      </div>
    </section>
  );
}

/** "Let Claude decide this one": GitOrange AI answers as you, now. */
function DelegateOne({ f }: { f: FindingData }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [owner, repo] = f.repo.fullName.split('/');
  const n = f.pull.number;
  const [pending, setPending] = useState(false);
  const [left, setLeft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api.delegateFlag(owner, repo, n, f.id);
      if (!r.applied) setLeft(r.reason);
      else
        toast(
          r.decision === 'approve'
            ? `${AI_NAME} approved it for you`
            : `${AI_NAME} requested changes for you`,
          {
            icon: <ClaudeTile />,
            undo: () =>
              void api
                .undoFlag(owner, repo, n, f.id)
                .finally(() => void refresh(owner, repo)),
          }
        );
    } catch (e) {
      setError(failure(e));
    } finally {
      await refresh(owner, repo);
      setPending(false);
    }
  };
  return (
    <div className="ap-delegate">
      <PendingButton
        className="quiet small"
        pending={pending}
        pendingLabel={`${AI_NAME} is deciding…`}
        onClick={() => void go()}
      >
        <ClaudeTile />
        Let {AI_NAME} decide this one
      </PendingButton>
      <span className="ap-small">
        {AI_NAME} answers as you, and you can undo it while #{n} is open.
      </span>
      {left && (
        <p className="ap-small ap-left" role="status">
          <ClaudeTile />
          {AI_NAME} left this for you: {left}
        </p>
      )}
      <PanelError error={error} />
    </div>
  );
}

/** Who was asked to decide, shown above the answers. */
function AssignedLine({ f, me }: { f: FindingData; me: string | null }) {
  if (!f.assignee) return null;
  const who = (p: { login: string; name: string | null } | null) =>
    !p ? null : p.login === me ? 'you' : p.name || `@${p.login}`;
  const by = who(f.assignedBy);
  return (
    <p className="ap-assigned">
      <PeopleIcon size={14} />
      {f.assignee.login === me ? (
        <span>
          {by && by !== 'you'
            ? `${by} asked you to decide this.`
            : 'You have this one.'}
        </span>
      ) : (
        <span>
          {who(f.assignee)} has this question now
          {by ? `, asked by ${by}` : ''}. You can still answer it yourself.
        </span>
      )}
    </p>
  );
}

type Choice = 'yes' | 'no' | 'ask';

/** The owner question's answers: Yes / No, fix it / Ask someone, a rule for next time, and a guarded reason. */
function OwnerAnswer({ f, me }: { f: FindingData; me: string | null }) {
  const { owner, repo, n, pending, error, setError, act } = useAnswer(f);
  const name = nameOf(f);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [teachOn, setTeachOn] = useState(false);
  const [teach, setTeach] = useState('');
  const [ask, setAsk] = useState('');
  const asked = f.state === 'changes_requested';
  const people = useAskCandidates(owner, repo, me);
  const askName =
    people.people?.find((p) => p.login === ask)?.name ?? (ask || '');
  const undoDecision = () => api.undoFlag(owner, repo, n, f.id);
  const opts: [Choice, string, string][] = [
    [
      'yes',
      'Yes',
      f.guarded
        ? `Approve it. ${name} findings need your reason, recorded in the audit log.`
        : `Approve it. #${n} can merge when nothing else holds it up.`,
    ],
    ...(asked
      ? []
      : ([
          [
            'no',
            'No, fix it',
            `Ask for a change before #${n} merges. Its author gets your note.`,
          ],
        ] as [Choice, string, string][])),
    [
      'ask',
      'Ask someone',
      `Pass the question to someone who can push to ${f.repo.fullName}.`,
    ],
  ];
  const missing =
    !choice ||
    (choice === 'yes' && f.guarded && !reason.trim()) ||
    (choice === 'ask' && (!ask || ask === f.assignee?.login)) ||
    (choice !== 'ask' && teachOn && !teach.trim());
  const submit = () => {
    if (!choice || missing) return;
    const t = teachText(teachOn, teach);
    if (choice === 'yes')
      void act(
        'submit',
        () =>
          api.approveFlag(owner, repo, n, f.id, {
            reason: f.guarded ? reason : null,
            teach: t,
          }),
        { toast: 'Approved', undo: undoDecision }
      );
    else if (choice === 'no')
      void act(
        'submit',
        () => api.requestFlagChanges(owner, repo, n, f.id, note, t),
        { toast: 'Sent back for a change', undo: undoDecision },
        { sendingNote: true }
      );
    else {
      const before = f.assignee?.login ?? null;
      void act('submit', () => api.assignFlag(owner, repo, n, f.id, ask), {
        toast: `Asked ${askName}`,
        undo: () => api.assignFlag(owner, repo, n, f.id, before),
      }).then((ok) => {
        if (!ok) return;
        setChoice(null);
        setAsk('');
      });
    }
  };
  return (
    <section className="panel ap-answer" aria-labelledby="ap-ans-h">
      <h2 id="ap-ans-h">{asked ? 'Change your answer' : 'Your answer'}</h2>
      <AssignedLine f={f} me={me} />
      <fieldset className="ap-choices">
        <legend className="sr">Your answer</legend>
        {opts.map(([v, label, sub]) => (
          <label className={`ap-choice${choice === v ? ' on' : ''}`} key={v}>
            <input
              type="radio"
              name="ap-answer"
              value={v}
              checked={choice === v}
              onChange={() => {
                setChoice(v);
                setError(null);
              }}
            />
            <span>
              <b>{label}</b>
              <small>{sub}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {choice === 'yes' && f.guarded && (
        <div className="ap-teach">
          <label className="ap-label" htmlFor="ap-owner-reason">
            Why is this right? <span className="muted">(required)</span>
          </label>
          <textarea
            id="ap-owner-reason"
            className="ap-input"
            rows={2}
            maxLength={TEXT_MAX}
            value={reason}
            aria-required
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="ap-small">
            <ShieldIcon size={13} />
            {name} findings need a reason. It goes in the audit log with your
            name.
          </p>
        </div>
      )}
      {choice === 'no' && (
        <div className="ap-teach">
          <label className="ap-label" htmlFor="ap-owner-note">
            What should change? <span className="muted">(optional)</span>
          </label>
          <textarea
            id="ap-owner-note"
            className="ap-input"
            rows={2}
            maxLength={TEXT_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {choice === 'ask' && (
        <div className="ap-teach">
          <label className="ap-label" htmlFor="ap-owner-ask">
            Who should answer?
          </label>
          {people.error ? (
            <p className="ap-error" role="alert">
              The people who can answer did not load.{' '}
              <button
                type="button"
                className="btn quiet small"
                onClick={people.retry}
              >
                Retry
              </button>
            </p>
          ) : !people.people ? (
            <div
              className="sk sk-row"
              role="status"
              aria-label="Loading people"
            />
          ) : !people.people.length ? (
            <p className="ap-small">
              Nobody else can push to {f.repo.fullName}.
            </p>
          ) : (
            <select
              id="ap-owner-ask"
              className="ap-input ap-select"
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
            >
              <option value="">Choose someone</option>
              {people.people.map((p) => (
                <option key={p.login} value={p.login}>
                  {p.name} (@{p.login})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {(choice === 'yes' || choice === 'no') && (
        <TeachField
          agentName={name}
          pull={n}
          on={teachOn}
          text={teach}
          onToggle={setTeachOn}
          onText={setTeach}
          label="Remember this for next time"
        />
      )}
      <div className="ap-actions">
        <PendingButton
          className="primary"
          pending={pending === 'submit'}
          pendingLabel={
            choice === 'no'
              ? 'Sending…'
              : choice === 'ask'
                ? 'Asking…'
                : 'Approving…'
          }
          disabled={missing}
          onClick={submit}
        >
          {choice === 'no'
            ? 'Send'
            : choice === 'ask'
              ? askName
                ? `Ask ${askName}`
                : 'Ask'
              : 'Approve'}
        </PendingButton>
      </div>
      <PanelError error={error} />
      {f.can.delegate && <DelegateOne f={f} />}
    </section>
  );
}

type Mode = 'changes' | 'dismiss' | 'approve' | 'ask';

/** A developer finding's answers: Approve (with a reason when guarded), Request changes, Dismiss, Ask someone. */
function DevAnswer({ f, me }: { f: FindingData; me: string | null }) {
  const { owner, repo, n, pending, error, act } = useAnswer(f);
  const [mode, setMode] = useState<Mode | null>(null);
  const name = nameOf(f);
  const change = f.kind === 'change_requested';
  const asked = f.state === 'changes_requested';
  const undoDecision = () => api.undoFlag(owner, repo, n, f.id);
  const panelId = 'ap-answer-panel';
  const done = async (ok: Promise<boolean>) => {
    if (await ok) setMode(null);
  };
  const toggle = (m: Mode, label: ReactNode, primary = false) => (
    <button
      type="button"
      className={`btn small${primary ? ' primary' : ''}`}
      aria-expanded={mode === m}
      aria-controls={panelId}
      disabled={!!pending}
      onClick={() => setMode(mode === m ? null : m)}
    >
      {label}
    </button>
  );
  const approveDirect = (
    <PendingButton
      className="small primary"
      pending={pending === 'approve'}
      pendingLabel="Approving…"
      onClick={() =>
        void act('approve', () => api.approveFlag(owner, repo, n, f.id), {
          toast: `Approved #${n}`,
          undo: undoDecision,
        })
      }
    >
      <CheckIcon size={14} />
      {asked ? 'Approve instead' : 'Approve'}
    </PendingButton>
  );
  const changesBtn = toggle(
    'changes',
    <>
      <SyncIcon size={14} />
      Request changes
    </>,
    f.guarded
  );
  const dismissBtn = toggle(
    'dismiss',
    <>
      <XIcon size={14} />
      Dismiss
    </>,
    change
  );
  const askBtn = toggle(
    'ask',
    <>
      <PeopleIcon size={14} />
      Ask someone
    </>
  );
  return (
    <section className="panel ap-answer" aria-labelledby="ap-ans-h">
      <h2 id="ap-ans-h">{asked ? 'Change your answer' : 'Your answer'}</h2>
      <AssignedLine f={f} me={me} />
      {f.guarded && (
        <p className="ap-small">
          <ShieldIcon size={13} />
          <span>
            {change
              ? `Dismissing a ${possessive(name)} change request needs a reason.`
              : `${name} findings can’t be approved in bulk. Approving needs a reason.`}
          </span>
        </p>
      )}
      <div className="ap-actions">
        {change ? (
          <>
            {dismissBtn}
            {askBtn}
          </>
        ) : f.guarded ? (
          <>
            {!asked && changesBtn}
            {toggle(
              'approve',
              <>
                <CheckIcon size={14} />
                Approve with a reason
              </>,
              asked
            )}
            {dismissBtn}
            {askBtn}
          </>
        ) : (
          <>
            {approveDirect}
            {!asked && changesBtn}
            {dismissBtn}
            {askBtn}
          </>
        )}
      </div>
      {mode === 'changes' && (
        <ChangesPanel
          id={panelId}
          agentName={name}
          pull={n}
          pending={pending === 'changes'}
          onCancel={() => setMode(null)}
          onSubmit={(note, teach) =>
            void done(
              act(
                'changes',
                () => api.requestFlagChanges(owner, repo, n, f.id, note, teach),
                { toast: `Changes requested on #${n}`, undo: undoDecision },
                { sendingNote: true }
              )
            )
          }
        />
      )}
      {mode === 'dismiss' && (
        <DismissPanel
          id={panelId}
          agentName={name}
          pull={n}
          guarded={f.guarded}
          pending={pending === 'dismiss'}
          onCancel={() => setMode(null)}
          onSubmit={(reason, teach) =>
            void done(
              act(
                'dismiss',
                () => api.approveFlag(owner, repo, n, f.id, { reason, teach }),
                {
                  toast: teach
                    ? `Dismissed. ${name} learns your rule`
                    : 'Dismissed',
                  undo: undoDecision,
                }
              )
            )
          }
        />
      )}
      {mode === 'approve' && (
        <ApproveReasonPanel
          id={panelId}
          agentName={name}
          pull={n}
          pending={pending === 'approve-reason'}
          onCancel={() => setMode(null)}
          onSubmit={(reason, teach) =>
            void done(
              act(
                'approve-reason',
                () => api.approveFlag(owner, repo, n, f.id, { reason, teach }),
                {
                  toast: 'Approved. Reason recorded in the audit log.',
                  undo: undoDecision,
                }
              )
            )
          }
        />
      )}
      {mode === 'ask' && (
        <AskPanel
          id={panelId}
          owner={owner}
          name={repo}
          me={me}
          assignee={f.assignee}
          pending={pending === 'ask'}
          onCancel={() => setMode(null)}
          onSubmit={(login) => {
            const before = f.assignee?.login ?? null;
            void done(
              act('ask', () => api.assignFlag(owner, repo, n, f.id, login), {
                toast: login ? `Asked @${login}` : 'Taken back',
                undo: () => api.assignFlag(owner, repo, n, f.id, before),
              })
            );
          }}
        />
      )}
      <PanelError error={error} />
      {f.can.delegate && <DelegateOne f={f} />}
    </section>
  );
}
