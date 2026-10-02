import { apiFetch } from './api';

export type User = {
  id: string;
  username: string;
  name: string;
  image: string | null;
};
export type Member = User & { email: string; role: string; createdAt: string };
export type Perms = { read: boolean; write: boolean; admin: boolean };
export type Repo = {
  id: string;
  owner: User;
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};
export type RepoDetail = Repo & {
  permissions: Perms;
  cloneUrl: string;
  empty: boolean;
  branches: { name: string; sha: string }[];
  openPullCount: number;
};
export type Commit = {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number;
  committedAt: number;
};
export type Entry = {
  name: string;
  path: string;
  type: string;
  mode: string;
  hash: string;
};
export type Contents = {
  ref: string;
  path: string;
  commitSha: string | null;
  latestCommit: Commit | null;
  kind: 'tree' | 'blob' | 'empty';
  entries?: Entry[];
  readme?: { path: string; text: string } | null;
  file?: {
    path: string;
    size: number;
    binary: boolean;
    tooLarge: boolean;
    text: string | null;
  };
};
export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};
export type FileDiff = {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldHash: string | null;
  newHash: string | null;
  mode: string;
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  hunks: Hunk[];
};
export type Compare = {
  baseSha: string;
  headSha: string;
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  mergeable: boolean;
  conflicts: string[];
  commits: Commit[];
  files: FileDiff[];
};
export type Pull = {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  author: User;
  baseRef: string;
  headRef: string;
  mergeCommitSha: string | null;
  mergedBy: User | null;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
};
export type Comment = {
  id: string;
  author: User;
  body: string;
  createdAt: string;
  updatedAt: string;
};
export type PullDetail = {
  pull: Pull;
  comments: Comment[];
  baseSha: string | null;
  headSha: string | null;
  headBranchExists: boolean;
  commitCount: number;
  mergeable: boolean | null;
  conflicts: string[];
  canMerge: boolean;
};
export type Invitation = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
};
export type Token = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

const r = (owner: string, repo: string) =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const q = (params: Record<string, string | number>) =>
  new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();

export const api = {
  setupStatus: () => apiFetch<{ setupRequired: boolean }>('/api/setup/status'),
  setup: (body: {
    name: string;
    username: string;
    email: string;
    password: string;
  }) => apiFetch<{ ok: true }>('/api/setup', { method: 'POST', json: body }),

  validateInvite: (token: string) =>
    apiFetch<{ email: string; inviter: string | null }>(
      `/api/invites/token/${token}`
    ),
  acceptInvite: (body: {
    token: string;
    name: string;
    username: string;
    password: string;
  }) =>
    apiFetch<{ email: string }>('/api/invites/accept', {
      method: 'POST',
      json: body,
    }),
  invitations: () => apiFetch<Invitation[]>('/api/invites'),
  invite: (body: { email: string; role: 'admin' | 'user' }) =>
    apiFetch<{ invitation: Invitation; inviteUrl: string; emailed: boolean }>(
      '/api/invites',
      { method: 'POST', json: body }
    ),
  revokeInvite: (id: string) =>
    apiFetch(`/api/invites/manage/${id}`, { method: 'DELETE' }),

  members: () => apiFetch<Member[]>('/api/users'),
  profile: (username: string) =>
    apiFetch<{ user: User & { createdAt: string }; repositories: Repo[] }>(
      `/api/users/${encodeURIComponent(username)}`
    ),

  tokens: () => apiFetch<Token[]>('/api/tokens'),
  createToken: (body: { name: string; expiresInDays: number | null }) =>
    apiFetch<{ token: Token; plaintext: string }>('/api/tokens', {
      method: 'POST',
      json: body,
    }),
  deleteToken: (id: string) =>
    apiFetch(`/api/tokens/${id}`, { method: 'DELETE' }),

  repos: () => apiFetch<Repo[]>('/api/repos'),
  createRepo: (body: {
    name: string;
    description?: string;
    addReadme: boolean;
  }) => apiFetch<Repo>('/api/repos', { method: 'POST', json: body }),
  repo: (o: string, n: string) => apiFetch<RepoDetail>(r(o, n)),
  updateRepo: (
    o: string,
    n: string,
    body: { name?: string; description?: string | null; defaultBranch?: string }
  ) => apiFetch<Repo>(r(o, n), { method: 'PATCH', json: body }),
  deleteRepo: (o: string, n: string) => apiFetch(r(o, n), { method: 'DELETE' }),
  collaborators: (o: string, n: string) =>
    apiFetch<User[]>(`${r(o, n)}/collaborators`),
  addCollaborator: (o: string, n: string, u: string) =>
    apiFetch(`${r(o, n)}/collaborators/${u}`, { method: 'PUT' }),
  removeCollaborator: (o: string, n: string, u: string) =>
    apiFetch(`${r(o, n)}/collaborators/${u}`, { method: 'DELETE' }),
  deleteBranch: (o: string, n: string, name: string) =>
    apiFetch(`${r(o, n)}/branches?${q({ name })}`, { method: 'DELETE' }),

  contents: (o: string, n: string, refPath: string) =>
    apiFetch<Contents>(`${r(o, n)}/contents?${q({ refPath })}`),
  treeCommits: (o: string, n: string, ref: string, path: string) =>
    apiFetch<Record<string, Commit>>(
      `${r(o, n)}/tree-commits?${q({ ref, path })}`
    ),
  rawUrl: (o: string, n: string, ref: string, path: string) =>
    `${r(o, n)}/raw?${q({ ref, path })}`,
  commits: (o: string, n: string, ref: string, page: number) =>
    apiFetch<{ commits: Commit[]; hasMore: boolean }>(
      `${r(o, n)}/commits?${q({ ref, page })}`
    ),
  commit: (o: string, n: string, sha: string) =>
    apiFetch<{ commit: Commit; files: FileDiff[] }>(`${r(o, n)}/commit/${sha}`),
  compare: (o: string, n: string, base: string, head: string) =>
    apiFetch<Compare>(`${r(o, n)}/compare?${q({ base, head })}`),

  pulls: (o: string, n: string, state: 'open' | 'closed') =>
    apiFetch<{ pulls: Pull[]; openCount: number; closedCount: number }>(
      `${r(o, n)}/pulls?${q({ state })}`
    ),
  createPull: (
    o: string,
    n: string,
    body: { title: string; body: string; base: string; head: string }
  ) => apiFetch<Pull>(`${r(o, n)}/pulls`, { method: 'POST', json: body }),
  pull: (o: string, n: string, num: number) =>
    apiFetch<PullDetail>(`${r(o, n)}/pulls/${num}`),
  updatePull: (
    o: string,
    n: string,
    num: number,
    body: { title?: string; body?: string; state?: 'open' | 'closed' }
  ) => apiFetch(`${r(o, n)}/pulls/${num}`, { method: 'PATCH', json: body }),
  pullCommits: (o: string, n: string, num: number) =>
    apiFetch<Commit[]>(`${r(o, n)}/pulls/${num}/commits`),
  pullFiles: (o: string, n: string, num: number) =>
    apiFetch<FileDiff[]>(`${r(o, n)}/pulls/${num}/files`),
  mergePull: (
    o: string,
    n: string,
    num: number,
    body: { method: 'merge' | 'squash'; title?: string; message?: string }
  ) =>
    apiFetch<{ sha: string }>(`${r(o, n)}/pulls/${num}/merge`, {
      method: 'POST',
      json: body,
    }),
  comment: (o: string, n: string, num: number, body: string) =>
    apiFetch<Comment>(`${r(o, n)}/pulls/${num}/comments`, {
      method: 'POST',
      json: { body },
    }),
};

export const qk = {
  setup: ['setup'] as const,
  repos: ['repos'] as const,
  members: ['members'] as const,
  invitations: ['invitations'] as const,
  tokens: ['tokens'] as const,
  profile: (u: string) => ['profile', u] as const,
  repo: (o: string, n: string) => ['repo', o, n] as const,
  contents: (o: string, n: string, refPath: string) =>
    ['repo', o, n, 'contents', refPath] as const,
  treeCommits: (o: string, n: string, ref: string, path: string) =>
    ['repo', o, n, 'tree-commits', ref, path] as const,
  commits: (o: string, n: string, ref: string, page: number) =>
    ['repo', o, n, 'commits', ref, page] as const,
  commit: (o: string, n: string, sha: string) =>
    ['repo', o, n, 'commit', sha] as const,
  compare: (o: string, n: string, base: string, head: string) =>
    ['repo', o, n, 'compare', base, head] as const,
  collaborators: (o: string, n: string) =>
    ['repo', o, n, 'collaborators'] as const,
  pulls: (o: string, n: string, state: string) =>
    ['repo', o, n, 'pulls', state] as const,
  pull: (o: string, n: string, num: number) =>
    ['repo', o, n, 'pull', num] as const,
  pullCommits: (o: string, n: string, num: number) =>
    ['repo', o, n, 'pull', num, 'commits'] as const,
  pullFiles: (o: string, n: string, num: number) =>
    ['repo', o, n, 'pull', num, 'files'] as const,
};
