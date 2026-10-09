import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { splitFrontmatter } from '@/lib/codeView';
import { Markdown } from '@/components/Markdown';
import { LoadError } from '@/components/Notice';
import { EmptyState } from '@/components/ui/EmptyState';

/** The agent's AGENT.md on its default branch, read from its instruction repository. */
export function useAgentFile(repository: string | null, branch: string) {
  const [owner = '', name = ''] = (repository ?? '').split('/');
  return useQuery({
    queryKey: qk.contents(owner, name, `${branch}/AGENT.md`),
    queryFn: () => api.contents(owner, name, `${branch}/AGENT.md`),
    enabled: !!repository,
  });
}

/** What AGENT.md says, without its settings block: the text a person reads, as on a profile README. */
export function agentBody(text: string | null | undefined): string {
  return text ? splitFrontmatter(text).body : '';
}

/**
 * The Overview's main panel: the agent's AGENT.md rendered, as GitHub shows a profile README. Its settings
 * (the front matter) are on the Configuration tab.
 */
export function AgentReadme({
  repository,
  branch,
  fallback,
}: {
  repository: string | null;
  branch: string;
  /** Said when there is no file to show (the agent's bio). */
  fallback: string;
}) {
  const file = useAgentFile(repository, branch);
  const [owner = '', name = ''] = (repository ?? '').split('/');
  const text = file.data?.file?.text;
  const body = useMemo(() => agentBody(text), [text]);

  if (!repository)
    return (
      <div className="panel">
        <EmptyState
          picture={<BookIcon size={20} />}
          title="Its instructions are not available"
          body={
            fallback ||
            'Its repository was deleted, or you can’t read it, so AGENT.md can’t be shown.'
          }
        />
      </div>
    );
  if (file.isError)
    return (
      <LoadError
        what="AGENT.md"
        error={file.error}
        onRetry={() => void file.refetch()}
      />
    );
  return (
    <section className="readme panel" aria-label="AGENT.md">
      <div className="readme-head">
        <BookIcon />
        <span className="mono small">
          {repository} / <b>AGENT.md</b>
        </span>
        <span style={{ flex: 1 }} />
        <Link className="btn small quiet" to={`/${repository}`}>
          Open repository
        </Link>
      </div>
      {file.isPending ? (
        <div
          className="sk-rows"
          role="status"
          aria-busy="true"
          aria-label="Loading AGENT.md"
          style={{ padding: 16 }}
        >
          <div className="sk sk-row" />
          <div className="sk sk-row tall" />
        </div>
      ) : body ? (
        <div className="md">
          <Markdown
            source={body}
            repo={{ owner, repo: name, ref: branch, dir: '' }}
          />
        </div>
      ) : (
        <EmptyState
          title="AGENT.md has no text yet"
          body="Add instructions below its settings and they show here."
        />
      )}
    </section>
  );
}
