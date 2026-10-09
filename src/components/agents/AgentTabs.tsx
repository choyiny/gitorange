import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { BookIcon, HistoryIcon } from '@primer/octicons-react';
import { dismissedText, LESSON_STATUS, lessonNote } from '@/lib/lessons';
import {
  engineText,
  latestNote,
  lessonTone,
  thresholdText,
} from '@/lib/agentPage';
import { splitFrontmatter } from '@/lib/codeView';
import { timeAgo, fullDate } from '@/lib/format';
import type { Namespace } from '@/lib/uiApi';
import { useAgentFile } from '@/components/agents/AgentReadme';
import { LoadError } from '@/components/Notice';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';

type Agent = NonNullable<Namespace['agent']>;

/**
 * Its latest reviews, newest first: which pull request, what it decided, when. The list holds the newest ten; `total`
 * is the record's count of all of them (absent until the record loads).
 */
export function ReviewsTab({ agent, total }: { agent: Agent; total?: number }) {
  const rows = agent.recentReviews;
  if (rows.length === 0)
    return (
      <div className="panel">
        <EmptyState
          picture={<HistoryIcon size={20} />}
          title="No reviews yet"
          body="When Clef wakes it for a pull request in a repository you can see, the review shows up here."
        />
      </div>
    );
  return (
    <>
      <p className="small muted">{latestNote(rows.length, total, 'review')}</p>
      <ul className="list revlist">
        {rows.map((r) => (
          <li key={`${r.repository}#${r.number}@${r.headSha}`}>
            <Chip status={r.status} />
            <span>
              <Link to={`/${r.repository}/pull/${r.number}`}>
                <b>{r.title}</b>
              </Link>
              <br />
              <span className="muted small">
                {r.repository}#{r.number}
              </span>
            </span>
            <span className="when" title={fullDate(r.createdAt)}>
              {timeAgo(r.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What it learned from change requests people dismissed, newest first: each lesson with its status, the findings
 * that taught it, and (once saved) the commit in its own repository.
 */
export function RulesTab({ agent, rules }: { agent: Agent; rules?: number }) {
  const lessons = agent.lessons;
  if (lessons.length === 0)
    return (
      <div className="panel">
        <EmptyState
          picture={<BookIcon size={20} />}
          title="No rules learned yet"
          body="When a person dismisses one of its change requests as wrong, it proposes a rule in its own repository, and it shows up here."
        />
      </div>
    );
  return (
    <div className="ag-config">
      <p className="small muted">
        {latestNote(lessons.length, undefined, 'lesson')}
        {rules !== undefined &&
          ` · ${rules} ${rules === 1 ? 'rule' : 'rules'} saved in all`}
      </p>
      {lessons.map((l) => {
        const note = lessonNote(l);
        const sha = note?.kind === 'commit' ? note.sha : null;
        return (
          <article key={l.id} className="panel ag-lesson">
            <div className="ag-lesson-top">
              <Chip tone={lessonTone(l.status)}>
                {LESSON_STATUS[l.status].label}
              </Chip>
              <Link to={`/${l.repository}/pull/${l.number}`}>
                {l.repository}#{l.number}
              </Link>
              <span
                className="when"
                title={fullDate(l.finishedAt ?? l.createdAt)}
              >
                {timeAgo(l.finishedAt ?? l.createdAt)}
              </span>
            </div>
            {l.status === 'committed' && (
              <p className="ag-rule">
                <b>{l.summary?.trim() || 'It saved a rule from this.'}</b>
              </p>
            )}
            <div className="muted small">{dismissedText(l.findings)}</div>
            {note?.kind === 'text' && <div className="small">{note.text}</div>}
            {sha &&
              (agent.repository ? (
                <Link
                  className="small"
                  to={`/${agent.repository}/commit/${sha}`}
                >
                  Saved in <code>{sha.slice(0, 7)}</code>
                </Link>
              ) : (
                <span className="small">
                  Saved in <code>{sha.slice(0, 7)}</code>
                </span>
              ))}
          </article>
        );
      })}
    </div>
  );
}

/** How it wakes and how it is set up, with AGENT.md's settings block as written. */
export function ConfigTab({ agent, branch }: { agent: Agent; branch: string }) {
  const file = useAgentFile(agent.repository, branch);
  const front = file.data?.file?.text
    ? splitFrontmatter(file.data.file.text).frontmatter
    : null;
  return (
    <div
      className="ag-config"
      style={{ '--agent': agent.color } as CSSProperties}
    >
      <section className="panel pad">
        <h2>How it wakes</h2>
        <p className="small muted">
          Clef asks this about every change, over a one-line summary of each
          changed file. When the answer is yes with enough probability, the
          agent reviews.
        </p>
        <dl className="ag-facts">
          <dt>Clef asks</dt>
          <dd>{agent.trigger.ask}</dd>
          <dt>Wakes when</dt>
          <dd>{thresholdText(agent.trigger)}</dd>
          <dt>Engine</dt>
          <dd>{engineText(agent.engine)}</dd>
          <dt>Covers</dt>
          <dd>{agent.facet ?? 'A custom area'}</dd>
          <dt>Guarded</dt>
          <dd>
            {agent.guarded
              ? 'Yes. Its findings are never approved in bulk, by one key or by GitOrange AI, and approving one needs a reason.'
              : 'No'}
          </dd>
          <dt>Colour</dt>
          <dd>
            <span className="ag-swatch" />
            <span className="mono">{agent.color}</span>
          </dd>
        </dl>
      </section>
      <section className="panel pad">
        <h2>Where it is defined</h2>
        {agent.repository ? (
          <>
            <dl className="ag-facts">
              <dt>Repository</dt>
              <dd>
                <Link to={`/${agent.repository}`} className="mono">
                  {agent.repository}
                </Link>
              </dd>
              <dt>Instructions</dt>
              <dd>
                <Link
                  to={`/${agent.repository}/blob/${branch}/AGENT.md`}
                  className="mono"
                >
                  AGENT.md
                </Link>
              </dd>
              {agent.configSha && (
                <>
                  <dt>Version</dt>
                  <dd>
                    <Link
                      to={`/${agent.repository}/commit/${agent.configSha}`}
                      className="mono"
                    >
                      {agent.configSha.slice(0, 7)}
                    </Link>
                  </dd>
                </>
              )}
            </dl>
            <p className="small muted">
              To change how it reviews, change AGENT.md in its repository. Edits
              are pull requests like any other.
            </p>
          </>
        ) : (
          <p className="small muted">
            Its repository was deleted, or you can’t read it, so its settings
            can’t be shown.
          </p>
        )}
        {agent.configError && (
          <p className="small color-fg-attention">
            AGENT.md has an error, so this shows its last valid version:{' '}
            {agent.configError}
          </p>
        )}
      </section>
      {agent.repository && (
        <section className="panel pad">
          <h2>Settings as written</h2>
          {file.isError ? (
            <LoadError
              what="AGENT.md"
              error={file.error}
              onRetry={() => void file.refetch()}
            />
          ) : file.isPending ? (
            <div
              className="sk-rows"
              role="status"
              aria-busy="true"
              aria-label="Loading AGENT.md"
            >
              <div className="sk sk-row tall" />
            </div>
          ) : front !== null ? (
            <pre className="ag-raw">{front}</pre>
          ) : (
            <p className="small muted">AGENT.md has no settings block.</p>
          )}
        </section>
      )}
    </div>
  );
}
