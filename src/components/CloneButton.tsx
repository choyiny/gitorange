import { CodeIcon, TriangleDownIcon } from '@primer/octicons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { RepoDetail } from '@/lib/uiApi';
import { Seg } from './ui/Seg';
import { AgentPrompt } from './AgentPrompt';
import { Dropdown } from './Dropdown';
import { CopyButton } from './CopyButton';

/** The "Code" button: a menu with the HTTPS clone URL, or a prompt to paste into a coding agent. */
export function CloneButton({ repo }: { repo: RepoDetail }) {
  const url = repo.cloneUrl;
  const [tab, setTab] = useState<'https' | 'agent'>('https');
  return (
    <Dropdown
      align="right"
      width={tab === 'agent' ? 520 : 400}
      className="clone-menu"
      trigger={(open, toggle) => (
        <button
          type="button"
          className="btn primary small"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={toggle}
        >
          <CodeIcon /> Code <TriangleDownIcon />
        </button>
      )}
    >
      {() => (
        <div className="clone-body">
          <div className="clone-head">
            <b>Clone</b>
            <Seg<'https' | 'agent'>
              label="Clone with"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'https', label: 'HTTPS' },
                { value: 'agent', label: 'AI agent' },
              ]}
            />
          </div>
          {tab === 'agent' ? (
            <AgentPrompt repo={repo} compact />
          ) : (
            <>
              <div className="clone-url">
                <input
                  className="form-control input-monospace input-sm"
                  readOnly
                  aria-label="HTTPS clone URL"
                  value={url}
                  onFocus={(e) => e.target.select()}
                />
                <CopyButton
                  text={url}
                  className="btn small"
                  label="Copy clone URL"
                />
              </div>
              <p className="small muted">
                Use a <Link to="/settings/tokens">personal access token</Link>{' '}
                as your password. Large files use Git LFS.
              </p>
            </>
          )}
        </div>
      )}
    </Dropdown>
  );
}
