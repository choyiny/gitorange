import { SparkleFillIcon } from '@primer/octicons-react';
import type { RepoDetail } from '@/lib/uiApi';
import { agentPrompt, importFromGitHubPrompt } from '@/lib/agentPrompt';
import { CopyButton } from './CopyButton';
import { useAppName } from '@/lib/appName';

/** Copy-paste coding-agent prompt: `work` on the repository, or `import` one from GitHub. */
export function AgentPrompt({
  repo,
  compact = false,
  kind = 'work',
}: {
  repo: RepoDetail;
  compact?: boolean;
  kind?: 'work' | 'import';
}) {
  const appName = useAppName();
  const origin = window.location.origin;
  const prompt =
    kind === 'import'
      ? importFromGitHubPrompt(repo, origin, appName)
      : agentPrompt(repo, origin, appName);
  return (
    <div className="agent-prompt">
      {!compact && (
        <p className="small muted">
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
      <div className="promptbox">
        <div className="promptbox-head">
          <span className="small muted mono">Prompt</span>
          <CopyButton
            text={prompt}
            label="Copy prompt"
            className="btn small quiet"
          />
        </div>
        <pre
          className={compact ? 'promptbox-text compact' : 'promptbox-text'}
          tabIndex={0}
        >
          {prompt}
        </pre>
      </div>
      {compact && (
        <p className="small muted agent-prompt-hint">
          <SparkleFillIcon size={12} /> Paste into Claude Code or another coding
          agent.
        </p>
      )}
    </div>
  );
}
