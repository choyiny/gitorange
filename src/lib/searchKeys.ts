/**
 * Global search (top band): where results come from, how they group, and what the keys do. Pure, so the rules are
 * unit-tested; `src/components/shell/GlobalSearch.tsx` draws it.
 *
 * Results always take the shape of `GET /api/search` (`SearchResults`, the lane B/C contract). Until that endpoint
 * exists, `localResults` builds the same shape from data the app already loads (repositories, agents, people, the
 * current repository's branches); swapping in `api.search(q, repo)` changes only the data source.
 */
import { agentColor } from './agentLook';

/** `GET /api/search?q=&repo=o/n` (each list ≤ 8; branches and files only when `repo` is given). */
export interface SearchResults {
  repos: { name: string; description: string | null }[];
  pulls: { repo: string; number: number; title: string; state: string }[];
  agents: { handle: string; name: string; color: string }[];
  people: { login: string; name: string | null }[];
  branches: { repo: string; name: string }[];
  files: { repo: string; path: string }[];
}

export type SearchKind =
  'repo' | 'pull' | 'agent' | 'person' | 'branch' | 'file' | 'page';

/** One row of the results list. */
export interface SearchHit {
  kind: SearchKind;
  label: string;
  sub: string | null;
  /** Where Enter or a click goes. */
  to: string;
  /** An agent's colour, for its icon. */
  color?: string | null;
}

/** Group order in the results (spec: Repositories, Pull requests, Agents, People, Branches, Files), then Pages. */
export const SEARCH_GROUPS: readonly { kind: SearchKind; title: string }[] = [
  { kind: 'repo', title: 'Repositories' },
  { kind: 'pull', title: 'Pull requests' },
  { kind: 'agent', title: 'Agents' },
  { kind: 'person', title: 'People' },
  { kind: 'branch', title: 'Branches' },
  { kind: 'file', title: 'Files' },
  { kind: 'page', title: 'Pages' },
];

export interface SearchSection {
  title: string;
  hits: SearchHit[];
}

/** Rows shown per group while typing. */
export const PER_GROUP = 5;
/** Rows in the "Jump to" list shown before anything is typed. */
export const JUMP_MAX = 8;
/** The API's cap per list, kept by the local source too. */
export const RESULT_MAX = 8;

/** Hits grouped in `SEARCH_GROUPS` order, each group capped, empty groups dropped. A blank query is "Jump to". */
export function searchSections(
  q: string,
  hits: SearchHit[],
  opts: { perGroup?: number } = {}
): SearchSection[] {
  if (!q.trim())
    return hits.length
      ? [{ title: 'Jump to', hits: hits.slice(0, JUMP_MAX) }]
      : [];
  const per = opts.perGroup ?? PER_GROUP;
  return SEARCH_GROUPS.map((g) => ({
    title: g.title,
    hits: hits.filter((h) => h.kind === g.kind).slice(0, per),
  })).filter((s) => s.hits.length > 0);
}

/** The rows in the order the arrow keys move through them. */
export function flattenSections(sections: SearchSection[]): SearchHit[] {
  return sections.flatMap((s) => s.hits);
}

/* ---------- Keys ---------- */

export interface SearchState {
  q: string;
  /** Index into the flattened rows. */
  sel: number;
}

export const CLEARED: SearchState = Object.freeze({ q: '', sel: 0 });

export interface SearchKeyResult {
  state: SearchState;
  /** Navigate here (Enter on a row). */
  go: string | null;
  /** Close the results (and leave the input). */
  close: boolean;
  /** The key was ours: prevent its default. */
  handled: boolean;
}

/** Arrow keys move the selection and wrap; Enter opens the selected row; Escape clears and closes. */
export function searchKey(
  state: SearchState,
  key: string,
  hits: SearchHit[]
): SearchKeyResult {
  const n = hits.length;
  const sel = n ? Math.min(Math.max(state.sel, 0), n - 1) : 0;
  const move = (next: number): SearchKeyResult => ({
    state: { ...state, sel: next },
    go: null,
    close: false,
    handled: true,
  });
  switch (key) {
    case 'ArrowDown':
      return move(n ? (sel + 1) % n : 0);
    case 'ArrowUp':
      return move(n ? (sel - 1 + n) % n : 0);
    case 'Enter':
      return n
        ? { state: CLEARED, go: hits[sel].to, close: true, handled: true }
        : { state, go: null, close: false, handled: false };
    case 'Escape':
      return { state: CLEARED, go: null, close: true, handled: true };
    default:
      return { state, go: null, close: false, handled: false };
  }
}

/**
 * Whether the search box closes (and clears) when focus leaves it. Only a real move elsewhere in the page (Tab out)
 * closes it: not the window losing focus (switching apps), not a press inside the box (the results' scrollbar),
 * not focus landing on something inside it. A press outside is the shell's to handle.
 */
export function blurCloses({
  windowFocused,
  pressedInside,
  focusInside,
}: {
  windowFocused: boolean;
  pressedInside: boolean;
  focusInside: boolean;
}): boolean {
  return windowFocused && !pressedInside && !focusInside;
}

/* ---------- Matching ---------- */

const WORD_BREAK = /[^a-z0-9]+/;

/**
 * How well `q` (lower-cased) matches: 0 a name starts with it, 1 a word in a name does, 2 a name contains it,
 * 3 a word of the extra text (a description, a page's keywords) starts with it, -1 no match.
 */
function rank(
  q: string,
  names: (string | null | undefined)[],
  extra: (string | null | undefined)[] = []
): number {
  let best = -1;
  for (const raw of names) {
    if (!raw) continue;
    const s = raw.toLowerCase();
    if (s.startsWith(q)) return 0;
    const r = s.split(WORD_BREAK).some((w) => w.startsWith(q))
      ? 1
      : s.includes(q)
        ? 2
        : -1;
    if (r >= 0 && (best < 0 || r < best)) best = r;
  }
  if (best >= 0) return best;
  const startsAWord = (t: string | null | undefined) =>
    !!t &&
    (t.toLowerCase().startsWith(q) ||
      t
        .toLowerCase()
        .split(WORD_BREAK)
        .some((w) => w.startsWith(q)));
  return extra.some(startsAWord) ? 3 : -1;
}

/** The items that match, best first (stable within a rank), at most `max`. */
function pick<T>(
  items: readonly T[],
  q: string,
  score: (item: T) => number,
  max: number
): T[] {
  return items
    .map((item, i) => ({ item, i, r: score(item) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, max)
    .map((x) => x.item);
}

/** What the app already has loaded that search can look through. */
export interface LocalSearchData {
  repos: readonly { fullName: string; description: string | null }[];
  agents: readonly { username: string; name: string; color?: string | null }[];
  people: readonly { username: string; name: string | null }[];
  /** The repository being viewed, for its branches. */
  repo?: { fullName: string; branches: readonly string[] } | null;
}

/** The client-side stand-in for `GET /api/search`: same shape, no pull requests or files. */
export function localResults(q: string, data: LocalSearchData): SearchResults {
  const needle = q.trim().toLowerCase();
  const out: SearchResults = {
    repos: [],
    pulls: [],
    agents: [],
    people: [],
    branches: [],
    files: [],
  };
  if (!needle) return out;
  out.repos = pick(
    data.repos,
    needle,
    (r) =>
      rank(needle, [r.fullName.split('/')[1], r.fullName], [r.description]),
    RESULT_MAX
  ).map((r) => ({ name: r.fullName, description: r.description }));
  out.agents = pick(
    data.agents,
    needle,
    (a) => rank(needle, [a.username, a.name]),
    RESULT_MAX
  ).map((a) => ({
    handle: a.username,
    name: a.name,
    color: agentColor(a.username, a.color),
  }));
  out.people = pick(
    data.people,
    needle,
    (p) => rank(needle, [p.username, p.name]),
    RESULT_MAX
  ).map((p) => ({ login: p.username, name: p.name }));
  if (data.repo) {
    const repo = data.repo.fullName;
    out.branches = pick(
      data.repo.branches,
      needle,
      (b) => rank(needle, [b]),
      RESULT_MAX
    ).map((name) => ({ repo, name }));
  }
  return out;
}

/** A ref or path in a URL: each segment encoded, slashes kept. */
const pathSegments = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

/** Rows for every result, linked to its page. Files open on `defaultBranch` (the scoped repository's). */
export function hitsFromResults(
  r: SearchResults,
  opts: { defaultBranch?: string | null } = {}
): SearchHit[] {
  const ref = pathSegments(opts.defaultBranch || 'HEAD');
  return [
    ...r.repos.map<SearchHit>((x) => ({
      kind: 'repo',
      label: x.name,
      sub: x.description,
      to: `/${x.name}`,
    })),
    ...r.pulls.map<SearchHit>((x) => ({
      kind: 'pull',
      label: `#${x.number} ${x.title}`,
      sub: x.repo,
      to: `/${x.repo}/pull/${x.number}`,
    })),
    ...r.agents.map<SearchHit>((x) => ({
      kind: 'agent',
      label: x.name,
      sub: `@${x.handle}`,
      to: `/${x.handle}`,
      color: x.color,
    })),
    ...r.people.map<SearchHit>((x) => ({
      kind: 'person',
      label: x.login,
      sub: x.name,
      to: `/${x.login}`,
    })),
    ...r.branches.map<SearchHit>((x) => ({
      kind: 'branch',
      label: x.name,
      sub: x.repo,
      to: `/${x.repo}/tree/${pathSegments(x.name)}`,
    })),
    ...r.files.map<SearchHit>((x) => ({
      kind: 'file',
      label: x.path,
      sub: x.repo,
      to: `/${x.repo}/blob/${ref}/${pathSegments(x.path)}`,
    })),
  ];
}

/** Before anything is typed: repositories, the recently visited ones first. */
export function jumpHits(
  repos: readonly { fullName: string; description: string | null }[],
  recent: readonly string[]
): SearchHit[] {
  const order = (fullName: string) => {
    const i = recent.findIndex(
      (r) => r.toLowerCase() === fullName.toLowerCase()
    );
    return i < 0 ? recent.length : i;
  };
  return repos
    .map((r, i) => ({ r, i, o: order(r.fullName) }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map(({ r }) => ({
      kind: 'repo',
      label: r.fullName,
      sub: r.description,
      to: `/${r.fullName}`,
    }));
}

/* ---------- Pages ---------- */

interface PageDef {
  label: string;
  to: string;
  keywords?: string;
  /** Site admins only. */
  admin?: boolean;
}

const PAGES: PageDef[] = [
  { label: 'Home', to: '/', keywords: 'dashboard' },
  { label: 'Repositories', to: '/repos' },
  { label: 'New repository', to: '/new', keywords: 'create' },
  { label: 'Approvals', to: '/approvals', keywords: 'inbox findings' },
  // Everyone once the Agents directory exists (crew redesign C10); until then it's Site admin → Agents.
  { label: 'Agents', to: '/agents', keywords: 'reviewers crew', admin: true },
  {
    label: 'Personal access tokens',
    to: '/settings/tokens',
    keywords: 'settings git password',
  },
  {
    label: 'MCP server',
    to: '/settings/mcp',
    keywords: 'settings connected apps claude cursor codex',
  },
  { label: 'Emails', to: '/settings/emails', keywords: 'settings addresses' },
  {
    label: 'Site admin',
    to: '/admin',
    keywords: 'people team members invite setup instance settings',
    admin: true,
  },
  {
    label: 'Usage and cost',
    to: '/admin/usage',
    keywords: 'billing',
    admin: true,
  },
];

interface RepoPageDef {
  label: string;
  path: string;
  keywords?: string;
  /** Needs admin rights on the repository. */
  repoAdmin?: boolean;
}

const REPO_PAGES: RepoPageDef[] = [
  { label: 'Code', path: '', keywords: 'files' },
  { label: 'Pull requests', path: 'pulls' },
  { label: 'New pull request', path: 'compare', keywords: 'compare' },
  { label: 'Commits', path: 'commits', keywords: 'history' },
  { label: 'Actions', path: 'actions', keywords: 'runs workflows ci' },
  { label: 'Insights', path: 'insights' },
  {
    label: 'Settings',
    path: 'settings',
    keywords: 'collaborators visibility',
    repoAdmin: true,
  },
];

/** App pages whose name (or a keyword) matches: the current repository's first, then the rest. */
export function pageHits(
  q: string,
  ctx: { admin: boolean; repo: string | null; repoAdmin?: boolean }
): SearchHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const repoPages: (SearchHit & { keywords?: string })[] = ctx.repo
    ? REPO_PAGES.filter((p) => !p.repoAdmin || ctx.repoAdmin).map((p) => ({
        kind: 'page',
        label: p.label,
        sub: ctx.repo,
        to: p.path ? `/${ctx.repo}/${p.path}` : `/${ctx.repo}`,
        keywords: p.keywords,
      }))
    : [];
  const pages: (SearchHit & { keywords?: string })[] = PAGES.filter(
    (p) => !p.admin || ctx.admin
  ).map((p) => ({
    kind: 'page',
    label: p.label,
    sub: null,
    to: p.to,
    keywords: p.keywords,
  }));
  return pick(
    [...repoPages, ...pages],
    needle,
    (p) => rank(needle, [p.label], [p.keywords]),
    Infinity
  ).map(({ kind, label, sub, to }) => ({ kind, label, sub, to }));
}
