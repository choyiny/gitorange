import { SparkleFillIcon } from '@primer/octicons-react';
import type { RepoDetail } from '@/lib/uiApi';
import { agentPrompt } from '@/lib/agentPrompt';
import { CopyButton } from './CopyButton';

/** The copy-paste prompt for working on a repository through a coding agent. */
export function AgentPrompt({
  repo,
  compact = false,
}: {
  repo: RepoDetail;
  compact?: boolean;
}) {
  const prompt = agentPrompt(repo);
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
          or another coding agent, and it will set up the repository on your
          computer, including Git LFS for large files, then help you make
          changes and open pull requests.
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
