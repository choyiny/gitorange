import { useMemo } from 'react';
import { Markdown } from '@/components/Markdown';
import { dirOf, type RepoMarkdownContext } from '@/lib/repoUrls';
import { splitFrontmatter } from '@/lib/codeView';
import type { RepoDetail } from '@/lib/uiApi';

/** Lets a repository Markdown file resolve its relative links and images. */
export const markdownContext = (
  repo: RepoDetail,
  ref: string,
  path: string
): RepoMarkdownContext => ({
  owner: repo.owner.username,
  repo: repo.name,
  ref,
  dir: dirOf(path),
});

/**
 * A repository Markdown file, rendered. A leading YAML block (an agent's AGENT.md starts with its settings) is
 * shown as a quiet block of its own above the text, not as Markdown.
 */
export function MarkdownFile({
  text,
  repo,
  refName,
  path,
}: {
  text: string;
  repo: RepoDetail;
  refName: string;
  path: string;
}) {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(text), [text]);
  return (
    <div className="md">
      {frontmatter !== null && (
        <details className="frontmatter" open>
          <summary>Front matter</summary>
          <pre>{frontmatter}</pre>
        </details>
      )}
      <Markdown source={body} repo={markdownContext(repo, refName, path)} />
    </div>
  );
}
