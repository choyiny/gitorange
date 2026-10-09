import { BookIcon } from '@primer/octicons-react';
import { isMarkdownPath } from '@/lib/codeView';
import type { RepoDetail } from '@/lib/uiApi';
import { MarkdownFile } from './MarkdownFile';

/** The directory's README below its files: Markdown rendered, anything else as plain text. */
export function Readme({
  repo,
  refName,
  readme,
}: {
  repo: RepoDetail;
  refName: string;
  readme: { path: string; text: string };
}) {
  return (
    <section className="readme panel" aria-label="README">
      <div className="readme-head">
        <BookIcon />
        <b>{readme.path.split('/').pop()}</b>
      </div>
      {isMarkdownPath(readme.path) ? (
        <MarkdownFile
          text={readme.text}
          repo={repo}
          refName={refName}
          path={readme.path}
        />
      ) : (
        <pre className="readme-text">{readme.text}</pre>
      )}
    </section>
  );
}
