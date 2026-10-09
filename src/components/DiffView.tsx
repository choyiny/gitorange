import { Fragment, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
} from '@primer/octicons-react';
import type { FileDiff } from '@/lib/uiApi';
import { languageFor } from '@/lib/languages';
import { useHighlighter } from '@/lib/useHighlight';
import { EmptyState } from './ui/EmptyState';

/** Five blocks split by ratio; a non-zero side always gets at least one block. */
function blocks(additions: number, deletions: number): ('add' | 'del' | '')[] {
  const total = additions + deletions;
  let greens = total === 0 ? 0 : Math.round((additions / total) * 5);
  if (additions && !greens) greens = 1;
  if (deletions && greens === 5) greens = 4;
  const reds = deletions
    ? Math.max(1, Math.min(5 - greens, Math.round((deletions / total) * 5)))
    : 0;
  return Array.from({ length: 5 }, (_, i) =>
    i < greens ? 'add' : i < greens + reds ? 'del' : ''
  );
}

function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="diffstat">
      <span className="ds-add">+{additions}</span>
      <span className="ds-del">−{deletions}</span>
      <span className="ds-blocks" aria-hidden="true">
        {blocks(additions, deletions).map((k, i) => (
          <i key={i} className={k || undefined} />
        ))}
      </span>
    </span>
  );
}

/** Lines added and removed across the files, with GitHub's five blocks. */
export function DiffTotals({ files }: { files: FileDiff[] }) {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return <DiffStat additions={add} deletions={del} />;
}

const STATUS_CHIP: Record<
  Exclude<FileDiff['status'], 'modified'>,
  { tone: string; label: string }
> = {
  added: { tone: 'good', label: 'Added' },
  removed: { tone: 'critical', label: 'Deleted' },
};

function FileBlock({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  const language = languageFor(file.path);
  const highlighted = useHighlighter(
    !!language && open && file.hunks.length > 0,
    (h) =>
      file.hunks.map((hunk) => h.highlightHunkLines(hunk.lines, language!)),
    [file, language, open]
  );
  const rows: JSX.Element[] = [];
  file.hunks.forEach((h, hi) => {
    let o = h.oldStart;
    let n = h.newStart;
    rows.push(
      <tr key={`h${hi}`} className="dh">
        <td className="dn" colSpan={2} />
        <td className="dc">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</td>
      </tr>
    );
    h.lines.forEach((line, li) => {
      if (line.startsWith('\\')) return;
      const kind = line[0];
      const cls = kind === '+' ? 'da' : kind === '-' ? 'dd' : undefined;
      rows.push(
        <tr key={`${hi}-${li}`} className={cls}>
          <td className="dn">{kind === '+' ? '' : o++}</td>
          <td className="dn">{kind === '-' ? '' : n++}</td>
          <td className="dc">
            <span className="dsign">{kind === ' ' ? ' ' : kind}</span>
            {highlighted?.[hi]?.[li] != null ? (
              <span
                dangerouslySetInnerHTML={{ __html: highlighted[hi][li]! }}
              />
            ) : (
              line.slice(1)
            )}
          </td>
        </tr>
      );
    });
  });
  const status = file.status === 'modified' ? null : STATUS_CHIP[file.status];
  return (
    <section
      className={`diff-file${open ? '' : ' shut'}`}
      id={`diff-${file.path}`}
      aria-label={file.path}
    >
      <header className="diff-file-head">
        <button
          type="button"
          className="diff-toggle"
          aria-expanded={open}
          aria-label={open ? `Hide ${file.path}` : `Show ${file.path}`}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </button>
        <span className="diff-path mono">
          {/* Break long paths after a slash first, like GitHub. */}
          {file.path.split('/').map((part, i, all) => (
            <Fragment key={i}>
              {part}
              {i < all.length - 1 && (
                <>
                  /<wbr />
                </>
              )}
            </Fragment>
          ))}
        </span>
        {status && (
          <span className={`chip ${status.tone}`}>{status.label}</span>
        )}
        <span className="grow" />
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </header>
      {open &&
        (file.binary ? (
          <p className="diff-note">Binary file not shown.</p>
        ) : file.tooLarge ? (
          <p className="diff-note">Large diffs are not rendered by default.</p>
        ) : rows.length === 0 ? (
          <p className="diff-note">
            {file.status === 'added'
              ? 'File added without changes.'
              : 'Empty file or mode change only.'}
          </p>
        ) : (
          <div className="diff-scroll">
            <table className="diff-table">
              <tbody>{rows}</tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

/** Each file's diff, collapsible, with old and new line numbers and syntax highlighting. */
export function DiffView({ files }: { files: FileDiff[] }) {
  if (!files.length) {
    return (
      <div className="panel">
        <EmptyState
          picture={<FileDiffIcon size={20} />}
          title="No changes to show"
        />
      </div>
    );
  }
  return (
    <div className="diff-list">
      {files.map((f) => (
        <FileBlock key={f.path} file={f} />
      ))}
    </div>
  );
}
