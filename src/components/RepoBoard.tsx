import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileIcon, GitBranchIcon, RepoIcon } from '@primer/octicons-react';
import { api, qk, type Repo, type RepoStats } from '@/lib/uiApi';
import {
  dayLabels,
  flightSegments,
  languageColor,
  pullChip,
  type BoardRow,
  type CrewMember,
} from '@/lib/board';
import { agentColor, agentState, STATE_LOOK } from '@/lib/agentLook';
import { timeAgo } from '@/lib/format';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Chip } from '@/components/ui/Chip';
import { Spark } from '@/components/ui/Spark';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "Private", "Internal", or "Team · internal" (team repositories are always internal), with what that means on hover. */
export function VisChip({
  repo,
}: {
  repo: Pick<Repo, 'visibility' | 'ownerType'>;
}) {
  const team = repo.ownerType === 'team';
  return (
    <span
      className="vis"
      title={
        repo.visibility === 'private'
          ? 'Only you, collaborators, and site admins can see this'
          : 'Every member can see this'
      }
    >
      {team
        ? 'Team · internal'
        : repo.visibility === 'private'
          ? 'Private'
          : 'Internal'}
    </span>
  );
}

/** "In flight": one segment per bucket of open pull requests, with a key (words as well as colour). */
export function FlightBar({ pulls }: { pulls: RepoStats['pulls'] }) {
  const segments = flightSegments(pulls);
  if (!segments.length) return null;
  return (
    <>
      <div
        className="flight-bar"
        role="img"
        aria-label={segments.map((s) => `${s.count} ${s.label}`).join(', ')}
      >
        {segments.map((s) => (
          <i
            key={s.key}
            className={`fl-${s.key}`}
            style={{ flex: s.count }}
            title={`${s.count} ${s.label}`}
          />
        ))}
      </div>
      <div className="flight-key">
        {segments.map((s) => (
          <span key={s.key}>
            <i className={`fl-${s.key}`} />
            {s.count} {s.label}
          </span>
        ))}
      </div>
    </>
  );
}

/** A reviewer's avatar as a link to its profile, with its name and state for hover and assistive tech. */
export function CrewAvatar({
  member,
  size,
}: {
  member: CrewMember;
  size: number;
}) {
  const state = STATE_LOOK[agentState(member.status)].label;
  return (
    <Link
      to={`/${member.handle}`}
      title={`${member.name}: ${state}`}
      aria-label={`${member.name}: ${state}`}
    >
      <AgentAvatar
        handle={member.handle}
        color={member.color}
        status={member.status}
        size={size}
      />
    </Link>
  );
}

/** One code repository on the board: what it is, what is in flight, what merged, who reviews it, what needs a look. */
export function CodeRow({ row }: { row: BoardRow }) {
  const { repo } = row;
  const s = repo.stats;
  const chip = pullChip(s.pulls);
  const days = dayLabels(7, Date.now());
  const [owner, name] = repo.fullName.split('/');
  return (
    <li className="board-row">
      <div className="board-id">
        <div className="board-title">
          <Link className="board-name" to={`/${repo.fullName}`}>
            <RepoIcon size={16} />
            <span>
              <span className="mono">{owner}/</span>
              <b>{name}</b>
            </span>
          </Link>
          <VisChip repo={repo} />
        </div>
        {repo.description && <p className="muted">{repo.description}</p>}
        <p className="board-meta">
          {s.language && (
            <span>
              <i
                className="board-lang"
                style={{ '--lc': languageColor(s.language) } as CSSProperties}
              />
              {s.language}
            </span>
          )}
          {s.branchCount !== null && (
            <span>
              <GitBranchIcon />
              {plural(s.branchCount, 'branch', 'branches')}
            </span>
          )}
          <span>Updated {timeAgo(new Date(s.updatedAt))}</span>
        </p>
        <div className="board-crew">
          {s.agents.map((a) => (
            <CrewAvatar key={a.handle} member={a} size={40} />
          ))}
          <span className="muted small">
            {s.agents.length
              ? plural(s.agents.length, 'reviewer')
              : 'No reviewer agents yet'}
          </span>
        </div>
      </div>
      <div className="board-flow">
        <span className="eyebrow">In flight</span>
        <b className="board-big">
          {s.pulls.open}{' '}
          <span>open pull {s.pulls.open === 1 ? 'request' : 'requests'}</span>
        </b>
        <FlightBar pulls={s.pulls} />
      </div>
      <div className="board-week">
        <span className="eyebrow">Merged, last 7 days</span>
        <b className="board-big">
          {s.merged7d}{' '}
          <span>pull {s.merged7d === 1 ? 'request' : 'requests'}</span>
        </b>
        {s.merged7d > 0 && (
          <Spark
            values={s.mergedByDay}
            width={150}
            height={34}
            label="Pull requests merged per day, last 7 days"
            labels={days}
            unit=" merged"
            trend="better"
          />
        )}
        <span className="muted small">
          {s.mergedAutomaticallyPct === null
            ? 'Nothing merged this week'
            : `${s.mergedAutomaticallyPct}% merged with no merge click`}
        </span>
      </div>
      <div className="board-health">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        {s.pulls.needsPerson > 0 && (
          <Link
            className="small"
            to="/approvals"
            aria-label={`Decide in Approvals: ${repo.fullName}`}
          >
            Decide in Approvals
          </Link>
        )}
        <span className="board-actions">
          <Link
            className="btn small"
            to={`/${repo.fullName}/branches`}
            aria-label={`Branch map of ${repo.fullName}`}
          >
            <GitBranchIcon size={14} />
            Branch map
          </Link>
          <Link
            className="btn small primary"
            to={`/${repo.fullName}`}
            aria-label={`Open ${repo.fullName}`}
          >
            Open
          </Link>
        </span>
      </div>
    </li>
  );
}

/** A reviewer agent's instruction repository: the agent, what it reviews and what it has learned. */
export function AgentRow({
  row,
  status,
  repos,
}: {
  row: BoardRow;
  /** What it is doing across the repositories it reviews. */
  status: CrewMember['status'];
  /** The repositories it reviews. */
  repos: string[];
}) {
  const { repo, agent } = row;
  const handle = repo.name;
  const record = useQuery({
    queryKey: qk.agentStats(handle),
    queryFn: () => api.agentStats(handle),
    staleTime: 60_000,
  });
  const r = record.data;
  const color = agentColor(handle, agent?.color);
  const onDuty = repos.length > 0;
  return (
    <li className="board-row" style={{ '--agent': color } as CSSProperties}>
      <div className="board-id board-agent">
        <Link
          to={`/${handle}`}
          aria-label={`${agent?.name ?? handle}'s profile`}
        >
          <AgentAvatar
            handle={handle}
            color={color}
            status={onDuty ? status : 'off'}
            size={56}
          />
        </Link>
        <span>
          <span className="board-title">
            <Link className="board-name" to={`/${repo.fullName}`}>
              <span>
                <span className="mono">{handle}/</span>
                <b>{handle}</b>
              </span>
            </Link>
            <span className="vis">Agent instructions</span>
          </span>
          {(agent?.bio || repo.description) && (
            <p className="muted">{agent?.bio || repo.description}</p>
          )}
          <p className="board-meta">
            <span>
              <FileIcon />
              AGENT.md and knowledge/
            </span>
            <span>Updated {timeAgo(new Date(repo.stats.updatedAt))}</span>
          </p>
        </span>
      </div>
      <div className="board-flow">
        <span className="eyebrow">Reviews</span>
        {record.isPending ? (
          <>
            <div className="sk sk-line w50" />
            <div className="sk sk-line w60" />
          </>
        ) : r ? (
          <>
            <b className="board-big">
              {r.raised}{' '}
              <span>{r.raised === 1 ? 'finding' : 'findings'} raised</span>
            </b>
            <span className="small">
              {r.keptPct === null
                ? r.raised
                  ? 'None decided yet'
                  : 'No reviews yet'
                : `${r.keptPct}% kept · ${r.dismissed} dismissed`}
            </span>
          </>
        ) : (
          <span className="small muted">Its record is not available.</span>
        )}
        <span className="small muted">
          {repos.length ? `On ${repos.join(', ')}` : 'Not on a repository'}
        </span>
      </div>
      <div className="board-week">
        <span className="eyebrow">Learned</span>
        {r ? (
          <>
            <b className="board-big">
              {r.rules} <span>{r.rules === 1 ? 'rule' : 'rules'}</span>
            </b>
            <span className="small">
              {r.rules
                ? 'Saved from requests a person dismissed.'
                : 'Nothing yet. Rules appear when a person dismisses a request.'}
            </span>
          </>
        ) : (
          record.isPending && <div className="sk sk-line w50" />
        )}
      </div>
      <div className="board-health">
        {onDuty ? (
          <Chip tone="good">On duty</Chip>
        ) : (
          <Chip tone="off">Off</Chip>
        )}
        <span className="board-actions">
          <Link
            className="btn small"
            to={`/${handle}`}
            aria-label={`${agent?.name ?? handle}'s profile`}
          >
            Profile
          </Link>
          <Link
            className="btn small primary"
            to={`/${repo.fullName}`}
            aria-label={`Open ${repo.fullName}`}
          >
            Open
          </Link>
        </span>
      </div>
    </li>
  );
}
