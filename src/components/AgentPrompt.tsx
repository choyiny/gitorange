import { SparkleFillIcon } from '@primer/octicons-react';
import type { RepoDetail } from '@/lib/uiApi';
import { agentPrompt, importFromGitHubPrompt } from '@/lib/agentPrompt';
import { CopyButton } from './CopyButton';

/**
 * A copy-paste prompt for a coding agent: `work` sets the repository up locally and helps make
 * changes; `import` brings an existing GitHub repository (all branches, tags, LFS files) in.
 */
export function AgentPrompt({
  repo,
  compact = false,
  kind = 'work',
}: {
  repo: RepoDetail;
  compact?: boolean;
  kind?: 'work' | 'import';
}) {
  const prompt =
    kind === 'import' ? importFromGitHubPrompt(repo) : agentPrompt(repo);
  return (
    <div>
      {!compact && (
        <p className="f5 color-fg-muted mb-2">
          No command line needed. Paste this into{' '}
          <a
            href="https://claude.com/claude-code"
            target="_blank"
            rel="noreferrer"
          >
            Claude Code
          </a>{' '}
          or another coding agent,{' '}
          {kind === 'import'
            ? 'and it will copy your GitHub repository here — every branch, tag, and Git LFS file — then either keep it in sync with GitHub or switch your everyday work over.'
            : 'and it will set up the repository on your computer, including Git LFS for large files, then help you make changes and open pull requests.'}
        </p>
      )}
      <div className="Box">
        <div className="Box-header d-flex flex-items-center flex-justify-between py-1 px-2">
          <span className="f6 color-fg-muted text-mono">Prompt</span>
          <CopyButton
            text={prompt}
            label="Copy prompt"
            className="btn btn-sm btn-invisible"
          />
        </div>
        <pre
          className="p-3 f6 text-mono m-0"
          style={{
            whiteSpace: 'pre-wrap',
            maxHeight: compact ? 220 : 320,
            overflowY: 'auto',
          }}
        >
          {prompt}
        </pre>
      </div>
      {compact && (
        <p
          className="f6 color-fg-muted mt-2 mb-0 d-flex flex-items-center"
          style={{ gap: 4 }}
        >
          <SparkleFillIcon size={12} /> Paste into Claude Code or another coding
          agent.
        </p>
      )}
    </div>
  );
}
