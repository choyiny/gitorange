import { Fragment, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
} from '@primer/octicons-react';
import type { FileDiff } from '@/lib/uiApi';
import { languageFor } from '@/lib/languages';
import { useHighlighter } from '@/lib/useHighlight';

function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const total = additions + deletions;
  // Five blocks split by ratio; a non-zero side always gets at least one block.
  let greens = total === 0 ? 0 : Math.round((additions / total) * 5);
  if (additions && !greens) greens = 1;
  if (deletions && greens === 5) greens = 4;
  const reds = deletions
    ? Math.max(1, Math.min(5 - greens, Math.round((deletions / total) * 5)))
    : 0;
  return (
    <span className="d-inline-flex flex-items-center" style={{ gap: 4 }}>
      <span className="color-fg-success text-bold">+{additions}</span>
      <span className="color-fg-danger text-bold">−{deletions}</span>
      <span className="d-none d-sm-inline">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className="diffstat-block"
            style={{
              background:
                i < greens
                  ? 'var(--diffStat-addition-bgColor, #1f883d)'
                  : i < greens + reds
                    ? 'var(--diffStat-deletion-bgColor, #cf222e)'
                    : 'var(--diffStat-neutral-bgColor, #d1d9e0)',
            }}
          />
        ))}
      </span>
    </span>
  );
}

export function DiffTotals({ files }: { files: FileDiff[] }) {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return <DiffStat additions={add} deletions={del} />;
}

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
      <tr key={`h${hi}`} className="diff-hunk">
        <td className="blob-num" colSpan={2} />
        <td className="blob-code">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</td>
      </tr>
    );
    h.lines.forEach((line, li) => {
      if (line.startsWith('\\')) return;
      const kind = line[0];
      const cls = kind === '+' ? 'diff-add' : kind === '-' ? 'diff-del' : '';
      rows.push(
        <tr key={`${hi}-${li}`} className={cls}>
          <td className="blob-num">{kind === '+' ? '' : o++}</td>
          <td className="blob-num">{kind === '-' ? '' : n++}</td>
          <td className="blob-code">
            <span className="user-select-none color-fg-muted mr-1">
              {kind === ' ' ? ' ' : kind}
            </span>
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
  return (
    <div className="Box mb-3" id={`diff-${file.path}`}>
      <div className="file-header">
        <button
          className="btn-octicon m-0 p-0"
          onClick={() => setOpen(!open)}
          aria-label="Toggle diff contents"
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </button>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <span
          className="text-bold"
          style={{ overflowWrap: 'anywhere', minWidth: 0 }}
        >
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
        {file.status !== 'modified' && (
          <span
            className={`Label ${file.status === 'added' ? 'Label--success' : 'Label--danger'}`}
          >
            {file.status}
          </span>
        )}
      </div>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          {file.binary ? (
            <div className="p-3 text-center color-fg-muted f6">
              Binary file not shown.
            </div>
          ) : file.tooLarge ? (
            <div className="p-3 text-center color-fg-muted f6">
              Large diffs are not rendered by default.
            </div>
          ) : rows.length === 0 ? (
            <div className="p-3 text-center color-fg-muted f6">
              {file.status === 'added'
                ? 'File added without changes.'
                : 'Empty file or mode change only.'}
            </div>
          ) : (
            <table className="blob-table">
              <tbody>{rows}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffView({ files }: { files: FileDiff[] }) {
  if (!files.length) {
    return (
      <div className="blankslate">
        <FileIcon size={24} className="color-fg-muted mb-2" />
        <h3 className="blankslate-heading">No changes to show</h3>
      </div>
    );
  }
  return (
    <div>
      {files.map((f) => (
        <FileBlock key={f.path} file={f} />
      ))}
    </div>
  );
}
