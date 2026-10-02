import {
  CodeIcon,
  TriangleDownIcon,
  TerminalIcon,
} from '@primer/octicons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { RepoDetail } from '@/lib/uiApi';
import { AgentPrompt } from './AgentPrompt';
import { Dropdown } from './Dropdown';
import { CopyButton } from './CopyButton';

export function CloneButton({ repo }: { repo: RepoDetail }) {
  const url = repo.cloneUrl;
  const [tab, setTab] = useState<'https' | 'agent'>('https');
  return (
    <Dropdown
      align="right"
      width={tab === 'agent' ? 520 : 400}
      trigger={(_, toggle) => (
        <button
          className="btn btn-primary d-inline-flex flex-items-center"
          style={{ gap: 6 }}
          onClick={toggle}
        >
          <CodeIcon /> Code <TriangleDownIcon />
        </button>
      )}
    >
      {() => (
        <div className="p-3">
          <div
            className="d-flex flex-items-center mb-2 text-bold"
            style={{ gap: 6 }}
          >
            <TerminalIcon /> Clone
          </div>
          <div className="UnderlineNav mb-2" style={{ minHeight: 0 }}>
            <div className="UnderlineNav-body" role="tablist">
              {(
                [
                  ['https', 'HTTPS'],
                  ['agent', 'AI agent'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={`UnderlineNav-item py-1${tab === key ? ' selected' : ''}`}
                  style={{ background: 'none', border: 0, cursor: 'pointer' }}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {tab === 'agent' ? (
            <AgentPrompt repo={repo} compact />
          ) : (
            <>
              <div className="input-group">
                <input
                  className="form-control input-monospace input-sm"
                  readOnly
                  value={url}
                  onFocus={(e) => e.target.select()}
                />
                <div className="input-group-button">
                  <CopyButton text={url} />
                </div>
              </div>
              <p className="f6 color-fg-muted mt-2 mb-0">
                Use a <Link to="/settings/tokens">personal access token</Link>{' '}
                as your password.
              </p>
            </>
          )}
        </div>
      )}
    </Dropdown>
  );
}
