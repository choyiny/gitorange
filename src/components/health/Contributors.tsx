import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertIcon,
  ArrowUpIcon,
  DotFillIcon,
  PersonIcon,
} from '@primer/octicons-react';
import type { HealthReport, HealthTrend } from '@/lib/uiApi';
import { clientMark, contributorLine } from '@/lib/health';
import { Identicon } from '@/components/Identicon';
import { EmptyState } from '@/components/ui/EmptyState';
import { Section } from '@/components/ui/Section';

type Contributor = HealthReport['contributors'][number];

const DIR_ICON: Record<HealthTrend, ReactNode> = {
  better: <ArrowUpIcon size={14} />,
  same: <DotFillIcon size={14} />,
  worse: <AlertIcon size={14} />,
};

/** Who did the work: a person (their identicon) or a coding session (its app's monogram, never a robot). */
function Coder({
  who,
  to,
}: {
  who: Contributor['who'];
  /** Where the tile and name lead: the session's page, or the person's profile. */
  to: string;
}) {
  const session = who.kind === 'session';
  const { mark, codex } = clientMark(who.client);
  const inner = (
    <span className="coder">
      {session ? (
        <span
          className={codex ? 'mono-tile codex' : 'mono-tile'}
          aria-hidden="true"
        >
          {mark}
        </span>
      ) : (
        <Identicon login={who.login} size={22} />
      )}
      <span className="hl-coder-name">
        {who.label}{' '}
        <span className="muted">
          {session
            ? `${who.client && who.client !== who.label ? `${who.client} ` : ''}for ${who.login}`
            : 'by hand'}
        </span>
      </span>
    </span>
  );
  return (
    <Link className="hl-coder-link" to={to}>
      {inner}
    </Link>
  );
}

/**
 * "Who made things better or worse": the people and coding sessions that merged this week, most merged first, with
 * what the reviewers found on their changes against last week. A coding session links to its page by the id the report
 * gives it; a person links to their profile.
 */
export function Contributors({
  contributors,
  owner,
  name,
}: {
  contributors: Contributor[];
  owner: string;
  name: string;
}) {
  return (
    <Section
      title="Who made things better or worse"
      actions={<span className="muted small">This week</span>}
    >
      {contributors.length === 0 ? (
        <div className="panel">
          <EmptyState
            picture={<PersonIcon size={24} />}
            title="Nothing has merged this week"
            body="When changes merge, you will see who made them and whether your reviewers found anything."
          />
        </div>
      ) : (
        <ul className="list hl-movers">
          {contributors.map((c) => {
            const line = contributorLine(c);
            const to =
              c.who.kind === 'person'
                ? `/${c.who.login}`
                : `/${owner}/${name}/session/${c.who.sessionId}`;
            return (
              <li
                key={`${c.who.kind}:${c.who.login}:${c.who.client ?? ''}:${c.who.label}`}
              >
                <Coder who={c.who} to={to} />
                <span className="muted small hl-merged">
                  {c.merged === 1
                    ? '1 change merged'
                    : `${c.merged} changes merged`}
                </span>
                <span className={`hl-mover ${line.dir}`}>
                  {DIR_ICON[line.dir]}
                  <span>
                    <span className="sr">
                      {line.dir === 'better'
                        ? 'Better: '
                        : line.dir === 'worse'
                          ? 'Worse: '
                          : ''}
                    </span>
                    {line.text}
                    <span className="muted small hl-mover-detail">
                      {line.detail}
                    </span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
