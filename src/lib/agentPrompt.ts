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

/**
 * A prompt for moving a GitHub repository into an empty GitOrange repository: every branch, tag,
 * and Git LFS file, then optional ongoing sync. As with agentPrompt, the person runs every
 * command that needs a password (GitHub's or GitOrange's), so no token passes through the agent.
 */
export function importFromGitHubPrompt(
  repo: RepoDetail,
  origin = window.location.origin
): string {
  const web = `${origin}/${repo.fullName}`;
  const url = repo.cloneUrl;
  const mirror = `${repo.name}-github.git`;
  return `You're helping me move a Git repository from GitHub to our team's GitOrange server (a self-hosted, GitHub-style site). I'm not a developer, so explain each step in plain language before you do it.

Destination (an empty GitOrange repository): ${url}
Its web page: ${web}

1. Check that git and Git LFS are installed (\`git --version\` and \`git lfs version\`). If either is missing, tell me how to install it on my computer and wait for me. Then run \`git lfs install\`.
2. Ask me for the GitHub repository's address (it looks like https://github.com/OWNER/REPO).
3. I'll download it myself, so my GitHub password never appears in this chat. Ask me to type this into the prompt, including the leading "!", with the address filled in:
   ! git clone --mirror <GitHub address> ${mirror}
   If the repository is private, git will ask for my GitHub username and a GitHub personal access token as the password.
4. Fetch every Git LFS file from GitHub: \`git -C ${mirror} lfs fetch --all\`. If the repository doesn't use Git LFS, that's fine; skip ahead.
5. I'll upload it myself the first time, so my GitOrange password never appears in this chat either. Ask me to run:
   ! git -C ${mirror} push --all ${url}
   When git asks, my username is my GitOrange username, and the password is a personal access token I can create at ${origin}/settings/tokens. My computer will remember it after this.
6. Then push the tags and the Git LFS files yourself: \`git -C ${mirror} push --tags ${url}\` and \`git -C ${mirror} lfs push --all ${url}\`.
7. Check that nothing was missed: compare \`git -C ${mirror} branch --list\` with \`git ls-remote --heads ${url}\`, and tell me the result in plain language. Remind me I can change the default branch at ${web}/settings if it isn't the one I expect.

Then ask me which of these I want:
- Keep the GitHub copy as the main one for now, and sync it here regularly. If so, write a small script called sync-from-github in the ${mirror} folder that runs \`git fetch --prune origin\`, \`git lfs fetch --all origin\`, \`git push --all ${url}\`, \`git push --tags ${url}\`, and \`git lfs push --all ${url}\`, and show me how to run it. Pushes are normal (not forced), so if someone changed a branch here in the meantime, the script stops and I'll ask you for help instead of losing work.
- Switch to GitOrange for everyday work. If so, in my existing working copy of the project, change the remote to this server (\`git remote set-url origin ${url}\`), and from then on make each change on a new branch, push it, and give me the link to open a pull request at ${web}/compare.

Never force-push, never delete branches on either server, and never commit passwords, tokens, or other secrets.`;
}
