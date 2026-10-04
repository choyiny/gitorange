import { useState } from 'react';
import { FileIcon } from '@primer/octicons-react';

/** Paths one per line, like GitHub's conflicting-files list; long directories truncate. */
export function FileList({
  paths,
  max = 6,
}: {
  paths: string[];
  max?: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? paths : paths.slice(0, max);
  return (
    <ul className="file-list list-style-none f6 mt-1">
      {shown.map((p) => {
        const slash = p.lastIndexOf('/');
        return (
          <li key={p} title={p} className="d-flex flex-items-center py-1">
            <FileIcon className="color-fg-muted mr-2 flex-shrink-0" />
            <span className="text-mono file-list-path">
              {slash >= 0 && (
                <span className="file-list-dir color-fg-muted">
                  {p.slice(0, slash + 1)}
                </span>
              )}
              <span className="file-list-name">{p.slice(slash + 1)}</span>
            </span>
          </li>
        );
      })}
      {paths.length > max && (
        <li>
          <button
            type="button"
            className="btn-link f6"
            onClick={() => setAll(!all)}
          >
            {all ? 'Show fewer' : `Show ${paths.length - max} more`}
          </button>
        </li>
      )}
    </ul>
  );
}
