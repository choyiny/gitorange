import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ClockIcon,
  DotFillIcon,
  HistoryIcon,
  InboxIcon,
  PersonAddIcon,
  PlusIcon,
  RepoIcon,
  ShieldLockIcon,
} from '@primer/octicons-react';
import { api, qk, type HealthReport } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { agentColor } from '@/lib/agentLook';
import {
  boardRows,
  boardTotals,
  crewActivity,
  type BoardRow,
} from '@/lib/board';
import {
  HOME_AUDIT_LIMIT,
  homeAuditKey,
  useAgentList,
  useRepoStats,
  BOARD_REFRESH_MS,
} from '@/lib/boardQueries';
import {
  brokenRepos,
  dateEyebrow,
  decisionsOf,
  homeHeadline,
  homeLede,
  mergeActivity,
  repoVerdict,
  sinceLastWeek,
  topByActivity,
  type Decision,
  type GlanceLine,
  type RepoHealth,
} from '@/lib/home';
import { usePageHead } from '@/components/ui/PageHead';
import { Section } from '@/components/ui/Section';
import { Chip } from '@/components/ui/Chip';
import { Verdict } from '@/components/ui/Verdict';
import { EmptyState } from '@/components/ui/EmptyState';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Avatar } from '@/components/Avatar';
import { AuditList } from '@/components/AuditEvents';
import { LoadError } from '@/components/Notice';
import { CrewAvatar, VisChip } from '@/components/RepoBoard';

/** Decisions shown as cards; the rest wait in Approvals. */
const MAX_DECISIONS = 3;
/** Repositories whose health, and log, Home reads. */
const HEALTH_REPOS = 3;
const ACTIVITY_LIMIT = 8;
const ASIDE_REPOS = 8;
const RECENT_REPOS = 6;
const REFRESH = {
  refetchInterval: BOARD_REFRESH_MS * 2,
  refetchOnWindowFocus: true,
} as const;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Home: the owner's answer first. A statement ("Nothing is broken. 1 decision needs you."), the decisions an agent
 * needs answered, what got better or worse since last week, how each busy repository is doing, and what happened.
 * Beside it: your repositories and your crew.
 */
export default function Home() {
  const user = useCurrentUser()!;
  usePageHead({ icon: 'home', crumbs: [{ label: 'Home' }], title: 'Home' });

  const stats = useRepoStats();
  const agents = useAgentList();
  const approvals = useQuery({
    queryKey: [...qk.approvals, 'home'],
    queryFn: () => api.approvals({ limit: 25 }),
    refetchOnWindowFocus: true,
  });

  const rows = useMemo(
    () => boardRows(stats.data ?? [], agents.data ?? []),
    [stats.data, agents.data]
  );
  const top = useMemo(() => topByActivity(rows, HEALTH_REPOS), [rows]);
  const totals = useMemo(() => boardTotals(rows), [rows]);
  const crew = useMemo(() => crewActivity(rows), [rows]);

  const healths = useQueries({
    queries: top.map((r) => {
      const [o, n] = r.repo.fullName.split('/');
      return {
        queryKey: qk.health(o, n),
        queryFn: () => api.health(o, n),
        ...REFRESH,
      };
    }),
  });
  const audits = useQueries({
    queries: top.map((r) => {
      const [o, n] = r.repo.fullName.split('/');
      return {
        queryKey: homeAuditKey(o, n),
        queryFn: () => api.repoAudit(o, n, undefined, HOME_AUDIT_LIMIT),
        ...REFRESH,
      };
    }),
  });

  const agentByHandle = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.username, a])),
    [agents.data]
  );
  const agentNames = useMemo(
    () =>
      Object.fromEntries((agents.data ?? []).map((a) => [a.username, a.name])),
    [agents.data]
  );

  const reports: RepoHealth[] = top.flatMap((r, i) =>
    healths[i]?.data
      ? [{ repo: r.repo.fullName, report: healths[i].data! }]
      : []
  );
  const healthSettled = healths.every((h) => !h.isPending);
  const anyHealthFailed = healths.some((h) => h.isError);
  const failing = brokenRepos(reports);
  // Nothing is "not broken" until every repository checked has answered, or when the repositories could not be read.
  const broken = stats.isError
    ? null
    : failing.length
      ? failing
      : healthSettled && !anyHealthFailed
        ? []
        : null;

  const decisions = useMemo(
    () => decisionsOf(approvals.data?.items ?? [], user.username ?? null),
    [approvals.data, user.username]
  );
  const waiting = approvals.data?.count ?? 0;
  const cards = decisions.slice(0, MAX_DECISIONS);
  const rest = Math.max(0, waiting - cards.length);

  const ready =
    !approvals.isPending &&
    !stats.isPending &&
    (top.length === 0 || healthSettled);
  const headline = approvals.isError
    ? 'We couldn’t check what needs you.'
    : homeHeadline({
        decisions: decisions.length,
        others: Math.max(0, waiting - decisions.length),
        broken,
      });

  const activity = useMemo(
    () =>
      mergeActivity(
        audits.map((a) => a.data?.events ?? []),
        ACTIVITY_LIMIT
      ),
    [audits]
  );
  const lines = useMemo(() => sinceLastWeek(reports), [reports]);

  const [find, setFind] = useState('');
  const mine = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            r.agent === null &&
            (r.repo.owner.id === user.id || r.repo.ownerType === 'team')
        )
        .sort((a, b) => b.repo.stats.updatedAt - a.repo.stats.updatedAt),
    [rows, user.id]
  );
  const foundMine = mine.filter((r) =>
    r.repo.fullName.toLowerCase().includes(find.trim().toLowerCase())
  );
  const recent = useMemo(
    () =>
      [...rows]
        .sort((a, b) => b.repo.stats.updatedAt - a.repo.stats.updatedAt)
        .slice(0, RECENT_REPOS),
    [rows]
  );
  const noRepos = stats.isSuccess && rows.length === 0;
  const codeRepos = rows.filter((r) => r.agent === null).length;

  return (
    <>
      <header className="home-head" aria-busy={!ready}>
        <span className="eyebrow">{dateEyebrow(new Date())}</span>
        {ready ? (
          <>
            <h2 className="ph-title">{headline}</h2>
            {stats.isSuccess && (
              <p className="lede">
                {homeLede({
                  merged7d: totals.merged7d,
                  automatic: totals.automatic,
                })}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="sk sk-title" />
            <div className="sk sk-line w50" />
          </>
        )}
      </header>

      <div className="cols">
        <div className="col">
          {/* What needs you */}
          {approvals.isPending ? (
            <div className="sk sk-block short" />
          ) : approvals.isError ? (
            <LoadError
              what="what needs you"
              error={approvals.error}
              onRetry={() => approvals.refetch()}
            />
          ) : (
            <>
              {cards.length > 0 ? (
                <div className="home-ask-stack">
                  {cards.map((d) => (
                    <DecisionCard
                      key={d.flag.id}
                      decision={d}
                      me={user.username ?? null}
                      color={agentByHandle.get(d.agent.agent.username)?.color}
                    />
                  ))}
                </div>
              ) : waiting === 0 ? (
                <div className="home-ask done">
                  <div className="home-ask-body">
                    <strong>Nothing is waiting on you.</strong>
                    <p>
                      When a reviewer needs an answer from you, it shows up here
                      first.
                    </p>
                  </div>
                  <Link className="btn small" to="/approvals">
                    Approvals
                  </Link>
                </div>
              ) : null}
              {rest > 0 && (
                <Link className="home-strip" to="/approvals">
                  <InboxIcon size={16} />
                  <span>
                    <b>
                      {rest} {cards.length ? 'more ' : ''}
                      {rest === 1 ? 'item' : 'items'}
                    </b>{' '}
                    waiting in Approvals
                    {(approvals.data?.assignedToMe ?? 0) > 0 &&
                      ` · ${approvals.data!.assignedToMe} assigned to you`}
                  </span>
                  <ArrowRightIcon size={16} />
                </Link>
              )}
            </>
          )}

          {noRepos && (
            <section className="panel">
              <EmptyState
                picture={<RepoIcon size={24} />}
                title="No repositories yet"
                body="Repositories created by anyone on this instance will show up here."
                action={
                  <Link className="btn primary" to="/new">
                    Create repository
                  </Link>
                }
              />
            </section>
          )}

          {stats.isError && (
            <LoadError
              what="your repositories"
              error={stats.error}
              onRetry={() => stats.refetch()}
            />
          )}

          {top.length > 0 && (
            <>
              <Section title="Since last week">
                {reports.length === 0 && !healthSettled ? (
                  <div className="home-glance">
                    <div className="sk sk-line w60" />
                    <div className="sk sk-line w50" />
                  </div>
                ) : reports.length === 0 ? (
                  <LoadError
                    what="the health report"
                    error={healths.find((h) => h.isError)?.error}
                    onRetry={() => healths.forEach((h) => h.refetch())}
                  />
                ) : (
                  <div className="home-glance">
                    {lines.map((l, i) => (
                      <Glance key={i} line={l} />
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title={
                  codeRepos > HEALTH_REPOS
                    ? 'Health of your busiest repositories'
                    : 'Health of each repository'
                }
                actions={
                  <Link className="small" to="/repos">
                    All repositories
                  </Link>
                }
              >
                <div className="home-proj-list">
                  {top.map((r, i) => (
                    <ProjCard key={r.repo.id} row={r} health={healths[i]} />
                  ))}
                </div>
              </Section>

              <Section title="Activity">
                {activity.length > 0 ? (
                  <div className="panel">
                    <AuditList
                      events={activity}
                      options={{ scope: 'instance', agentNames }}
                    />
                  </div>
                ) : audits.some((a) => a.isPending) ? (
                  <div className="sk-rows">
                    <div className="sk sk-row" />
                    <div className="sk sk-row" />
                  </div>
                ) : audits.every((a) => a.isError) ? (
                  <LoadError
                    what="the activity"
                    error={audits[0]?.error}
                    onRetry={() => audits.forEach((a) => a.refetch())}
                  />
                ) : (
                  <section className="panel">
                    <EmptyState
                      picture={<HistoryIcon size={20} />}
                      title="Nothing has happened yet."
                      body="Merges, decisions and changes to these repositories appear here as they happen."
                    />
                  </section>
                )}
              </Section>
            </>
          )}

          {recent.length > 0 && (
            <Section
              title="Recently updated"
              actions={
                <Link className="small" to="/repos">
                  All repositories
                </Link>
              }
            >
              <ul className="home-recent panel">
                {recent.map((r) => (
                  <li key={r.repo.id}>
                    {r.agent ? (
                      <AgentAvatar
                        handle={r.repo.name}
                        color={r.agent.color}
                        size={28}
                      />
                    ) : (
                      <Avatar
                        user={r.repo.owner}
                        size={28}
                        square={r.repo.ownerType === 'team'}
                      />
                    )}
                    <div className="home-recent-main">
                      <div className="home-recent-name">
                        <Link to={`/${r.repo.fullName}`}>
                          {r.repo.fullName}
                        </Link>
                        {r.agent ? (
                          <span className="vis">Agent instructions</span>
                        ) : (
                          <VisChip repo={r.repo} />
                        )}
                      </div>
                      {r.repo.description && (
                        <span className="home-recent-desc">
                          {r.repo.description}
                        </span>
                      )}
                    </div>
                    <span className="when">
                      Updated {timeAgo(new Date(r.repo.stats.updatedAt))}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {stats.isPending && (
            <div className="sk-rows" role="status" aria-label="Loading">
              <div className="sk sk-row tall" />
              <div className="sk sk-row tall" />
            </div>
          )}
        </div>

        <aside className="col side">
          <section className="panel pad">
            <div className="section-head">
              <h2>Repositories</h2>
              <Link className="btn small primary" to="/new">
                <PlusIcon size={14} />
                New
              </Link>
            </div>
            <input
              id="home-find"
              className="home-find"
              type="search"
              aria-label="Find a repository"
              placeholder="Find a repository…"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
            {stats.isPending ? (
              <div className="sk-rows">
                <div className="sk sk-line w60" />
                <div className="sk sk-line w50" />
                <div className="sk sk-line w60" />
              </div>
            ) : (
              <ul className="plain">
                {foundMine.slice(0, ASIDE_REPOS).map((r) => (
                  <li key={r.repo.id}>
                    <Link className="home-repo" to={`/${r.repo.fullName}`}>
                      <RepoIcon />
                      <span className="mono">{r.repo.fullName}</span>
                    </Link>
                  </li>
                ))}
                {stats.isSuccess && mine.length === 0 && (
                  <li className="muted small">
                    You don't have any repositories yet.
                  </li>
                )}
                {mine.length > 0 && foundMine.length === 0 && (
                  <li className="muted small">No repository matches.</li>
                )}
                {foundMine.length > ASIDE_REPOS && (
                  <li className="muted small">
                    {foundMine.length - ASIDE_REPOS} more. See all repositories.
                  </li>
                )}
              </ul>
            )}
            <Link className="small" to="/repos">
              All repositories
            </Link>
          </section>

          <section className="panel pad">
            <h2>Your crew</h2>
            {stats.isPending ? (
              <div className="sk sk-line w60" />
            ) : crew.length > 0 ? (
              <div className="crew-stack">
                {crew.map((m) => (
                  <CrewAvatar key={m.handle} member={m} size={44} />
                ))}
              </div>
            ) : (
              <p className="muted small">
                No reviewer agents are on your repositories yet.
              </p>
            )}
            <Link className="small" to="/agents">
              Agents
            </Link>
          </section>

          {user.role === 'admin' && (
            <section className="panel pad invite-panel">
              <div className="invite-head">
                <PersonAddIcon size={20} />
                <h2>Bring your team</h2>
              </div>
              <p className="muted small">
                Invite members to collaborate on repositories in this instance.
              </p>
              <Link className="btn small" to="/admin?invite=1">
                Invite member
              </Link>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

/** One decision: the agent that is asking, its plain question, and a way to answer it on its own page. */
function DecisionCard({
  decision,
  me,
  color,
}: {
  decision: Decision;
  me: string | null;
  color: string | undefined;
}) {
  const { item, agent, flag } = decision;
  const handle = agent.agent.username;
  const name = agent.agent.name;
  const n = item.pull.number;
  const assigned = flag.assignee;
  return (
    <div className="home-ask">
      <AgentAvatar
        handle={handle}
        color={agentColor(handle, color)}
        status="needs"
        size={56}
      />
      <div className="home-ask-body">
        <span className="home-ask-from">
          {name} is asking · {item.repo.fullName}
        </span>
        <strong>{flag.question}</strong>
        {flag.title && flag.title !== flag.question && <p>{flag.title}</p>}
        <span className="home-ask-meta">
          <span>
            <ClockIcon />
            Updated {timeAgo(item.pull.updatedAt)}
          </span>
          <span>
            <Link to={`/${item.repo.fullName}/pull/${n}`}>
              Pull request #{n}
            </Link>
            {item.pull.author && <>&nbsp;by {item.pull.author.username}</>}
          </span>
          {flag.guarded && (
            <span>
              <ShieldLockIcon />
              Needs your reason to approve
            </span>
          )}
          {assigned &&
            (assigned.login === me ? (
              <Chip tone="info">Assigned to you</Chip>
            ) : (
              <span>Assigned to {assigned.name || assigned.login}</span>
            ))}
        </span>
      </div>
      <Link className="btn primary" to={`/approvals/${flag.id}`}>
        Answer
      </Link>
    </div>
  );
}

const GLANCE = {
  better: { word: 'Better', icon: <ArrowUpIcon />, cls: ' good' },
  worse: { word: 'Worse', icon: <ArrowDownIcon />, cls: ' worse' },
  same: { word: 'Same', icon: <DotFillIcon />, cls: '' },
} as const;

function Glance({ line }: { line: GlanceLine }) {
  const g = GLANCE[line.trend];
  return (
    <span className={`home-glance-item${g.cls}`}>
      {g.icon}
      <span>
        <b>{g.word}</b>
        {line.text}
      </span>
    </span>
  );
}

/** A repository's health on Home: its verdict, its week in numbers and the reviewers that have something to say. */
function ProjCard({
  row,
  health,
}: {
  row: BoardRow;
  health: UseQueryResult<HealthReport>;
}) {
  const { repo } = row;
  const s = repo.stats;
  const verdict = health.data ? repoVerdict(health.data) : null;
  const busy = s.agents.filter(
    (a) =>
      a.status !== 'idle' &&
      a.status !== 'approved' &&
      a.status !== 'not_needed'
  );
  const quiet = s.agents.length - busy.length;
  return (
    <Link className="home-proj" to={`/${repo.fullName}/health`}>
      <div className="home-proj-head">
        <span className="home-proj-name mono">{repo.fullName}</span>
        {verdict ? (
          <Chip tone={verdict.tone}>{verdict.label}</Chip>
        ) : health.isError ? (
          <Chip tone="off">Health unavailable</Chip>
        ) : (
          <span className="sk home-sk-chip" />
        )}
      </div>
      <div className="home-proj-stats">
        <span>
          <b>{s.pulls.open}</b> open
        </span>
        <span>
          <b>{s.merged7d}</b> merged in 7 days
        </span>
        {s.mergedAutomaticallyPct !== null && (
          <span>
            <b>{s.mergedAutomaticallyPct}%</b> with no merge click
          </span>
        )}
      </div>
      <div className="home-proj-crew">
        {busy.map((a) => (
          <Verdict
            key={a.handle}
            handle={a.handle}
            name={a.name}
            color={a.color}
            status={a.status}
          />
        ))}
        <span className="muted small">
          {s.agents.length === 0
            ? 'No reviewer agents yet'
            : quiet === 0
              ? ''
              : `${plural(quiet, 'other reviewer')} ${quiet === 1 ? 'has' : 'have'} nothing to flag`}
        </span>
      </div>
    </Link>
  );
}
