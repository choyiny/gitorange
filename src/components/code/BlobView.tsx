import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Contents, type RepoDetail } from '@/lib/uiApi';
import { formatBytes } from '@/lib/format';
import {
  inLineRange,
  isMarkdownPath,
  nextLineHash,
  parseLineHash,
  splitLines,
} from '@/lib/codeView';
import { languageFor } from '@/lib/languages';
import { useHighlighter } from '@/lib/useHighlight';
import { CopyButton } from '@/components/CopyButton';
import { Seg } from '@/components/ui/Seg';
import { LatestCommit } from './LatestCommit';
import { MarkdownFile } from './MarkdownFile';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
/** What a browser draws from the raw bytes of a binary file. */
const RAW_IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

/** A file's text with line numbers (click one to link to it, Shift-click for a range) and syntax colours. */
function CodeTable({
  lines,
  highlighted,
}: {
  lines: string[];
  highlighted: (string | undefined)[] | null;
}) {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const range = useMemo(() => parseLineHash(hash), [hash]);

  // Opened from a link to a range (#L5-L9), which names no element for the shell to scroll to: bring its first line
  // into view, once. Clicking a line number later never moves the page.
  useEffect(() => {
    const first = parseLineHash(window.location.hash);
    if (first)
      document
        .getElementById(`L${first.start}`)
        ?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div className="codeview">
      <table className="code-t">
        <tbody>
          {lines.map((line, i) => {
            const n = i + 1;
            return (
              <tr
                key={n}
                id={`L${n}`}
                className={inLineRange(range, n) ? 'hit' : undefined}
              >
                <td className="ln">
                  <a
                    href={`#L${n}`}
                    aria-label={`Line ${n}`}
                    // A long file has thousands of these; they are for the pointer, and the URL for everyone else.
                    tabIndex={-1}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(
                        { hash: nextLineHash(range, n, e.shiftKey) },
                        { replace: true }
                      );
                    }}
                  >
                    {n}
                  </a>
                </td>
                {highlighted?.[i] !== undefined ? (
                  <td
                    className="lc"
                    dangerouslySetInnerHTML={{ __html: highlighted[i]! }}
                  />
                ) : (
                  <td className="lc">{line}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A file: its latest commit, size and actions, then its content (or why there is none to show). */
export function BlobView({ repo, data }: { repo: RepoDetail; data: Contents }) {
  const f = data.file!;
  const o = repo.owner.username;
  const raw = api.rawUrl(o, repo.name, data.ref, data.path);
  const lines = useMemo(
    () => (f.text === null ? [] : splitLines(f.text)),
    [f.text]
  );
  const isMarkdown = isMarkdownPath(f.path) && f.text !== null;
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const showCode = !isMarkdown || view === 'code';
  const language = languageFor(f.path);
  const highlighted = useHighlighter(
    !!language && f.text !== null && showCode,
    (h) => h.highlightLines(f.text!, language!),
    [f.text, language, showCode]
  );
  return (
    <div className="filebox panel">
      <LatestCommit repo={repo} data={data} />
      <div className="fb-bar">
        <span className="small fb-stat">
          {f.text !== null && (
            <>
              <b>{lines.length}</b> {lines.length === 1 ? 'line' : 'lines'}{' '}
              ·{' '}
            </>
          )}
          {formatBytes(f.size)}
        </span>
        <span className="grow" />
        {isMarkdown && (
          <Seg<'preview' | 'code'>
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'code', label: 'Code' },
            ]}
          />
        )}
        <a href={raw} className="btn small" target="_blank" rel="noreferrer">
          Raw
        </a>
        {f.text !== null && (
          <CopyButton
            text={f.text}
            className="btn small"
            label="Copy raw content"
          >
            Copy
          </CopyButton>
        )}
      </div>
      {isMarkdown && !showCode ? (
        <MarkdownFile
          text={f.text!}
          repo={repo}
          refName={data.ref}
          path={f.path}
        />
      ) : f.text === null ? (
        <div className="fb-note">
          {f.binary ? (
            RAW_IMAGE_RE.test(f.path) ? (
              <img src={raw} alt={f.path} className="fb-image" />
            ) : (
              <>
                Binary file not shown. <a href={raw}>View raw</a>
              </>
            )
          ) : (
            <>
              (Sorry about that, but we can't show files that are this big right
              now.) <a href={raw}>View raw</a>
            </>
          )}
        </div>
      ) : lines.length === 0 ? (
        <div className="fb-note">This file is empty.</div>
      ) : (
        <CodeTable lines={lines} highlighted={highlighted} />
      )}
    </div>
  );
}

/** A file whose content lives in Git LFS: show the real file, not the pointer text. */
export function LfsFileView({
  repo,
  data,
}: {
  repo: RepoDetail;
  data: Contents;
}) {
  const f = data.file!;
  const lfs = f.lfs!;
  const o = repo.owner.username;
  const name = f.path.split('/').pop()!;
  const download = api.lfsUrl(o, repo.name, lfs.oid, name);
  const preview = api.lfsUrl(o, repo.name, lfs.oid);
  return (
    <div className="filebox panel">
      <LatestCommit repo={repo} data={data} />
      <div className="fb-bar">
        <span className="small fb-stat">
          {formatBytes(lfs.size)}
          <span className="lfs-label">Stored with Git LFS</span>
        </span>
        <span className="grow" />
        {lfs.stored && (
          <a href={download} className="btn small">
            Download
          </a>
        )}
      </div>
      <div className="fb-note">
        {!lfs.stored ? (
          <>
            This file is tracked with Git LFS, but its content hasn't been
            uploaded to this server. Push it with{' '}
            <code>git lfs push --all origin</code>.
          </>
        ) : IMAGE_RE.test(name) ? (
          <img src={preview} alt={name} className="fb-image" />
        ) : (
          <>
            This file is stored with Git LFS. <a href={download}>Download it</a>{' '}
            to view it.
          </>
        )}
      </div>
    </div>
  );
}
