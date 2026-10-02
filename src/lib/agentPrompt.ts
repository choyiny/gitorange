import type { RepoDetail } from './uiApi';

/**
 * A prompt someone can paste into a coding agent (Claude Code, Cursor, …) to start working on a
 * repository without knowing git. The token is never pasted into the agent: the person runs the
 * clone themselves so git's own password prompt captures it and the system credential store
 * remembers it for later pushes.
 */
export function agentPrompt(
  repo: RepoDetail,
  origin = window.location.origin
): string {
  const web = `${origin}/${repo.fullName}`;
  const tokens = `${origin}/settings/tokens`;
  const branch = repo.defaultBranch;
  const start = repo.empty
    ? `5. This repository is empty. Help me add my first files (at least a README.md that says what the project is), commit them on the \`${branch}\` branch, and push.`
    : `5. Show me what's in the repository in plain language, then ask what I'd like to change.`;
  return `You're helping me work on a Git repository hosted on our team's GitOrange server (a self-hosted, GitHub-style site). I'm not a developer, so explain each step in plain language before you do it.

Repository: ${repo.cloneUrl}
Web page: ${web}

1. Check that git and Git LFS are installed (\`git --version\` and \`git lfs version\`). If either is missing, tell me how to install it on my computer and wait for me.
2. Run \`git lfs install\` (once per computer).
3. I'll clone the repository myself, so my access token never appears in this chat. Ask me to type this into the prompt, including the leading "!":
   ! git clone ${repo.cloneUrl}
   When git asks, my username is my GitOrange username, and the password is a personal access token, which I can create at ${tokens}. My computer will remember it after this.
4. In the cloned folder, make sure large files go through Git LFS: run \`git lfs track\` for the kinds of files I work with (for example "*.psd" "*.ai" "*.zip" "*.mp4" "*.mov" "*.pdf" "*.png" "*.jpg"), and commit the resulting .gitattributes file.
${start}

From then on:
- Before committing, summarize what changed and confirm with me. Use short, clear commit messages.
- Make each change on a new branch, push it, and give me this link to open a pull request: ${web}/compare/${branch}...<branch-name>
- Pull the latest changes before starting new work.
- Never force-push, never delete branches, and never commit passwords, tokens, or other secrets.`;
}
