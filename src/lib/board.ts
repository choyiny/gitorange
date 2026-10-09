import type { Tone } from './agentLook';
import type { Agent, AgentActivity, RepoStats, RepoWithStats } from './uiApi';

// The Repositories board, and the repository lists on Home, as pure functions: which repository is an agent's
// instruction repository, what filters and sorts the board offers, and how a repository's numbers are told in words.

/** A repository on the board, and the reviewer agent whose instructions it holds (null for code). */
export interface BoardRow {
  repo: RepoWithStats;
  agent: Agent | null;
}

/**
 * Pairs each repository with its agent. An agent's repository is `<handle>/<handle>`; a deleted agent's repository
 * is an ordinary one again.
 */
export function boardRows(repos: RepoWithStats[], agents: Agent[]): BoardRow[] {
  const byHandle = new Map(
    agents.filter((a) => !a.deletedAt).map((a) => [a.username, a])
  );
  return repos.map((repo) => ({
    repo,
    agent:
      repo.owner.username === repo.name
        ? (byHandle.get(repo.name) ?? null)
        : null,
  }));
}

export type BoardFilter = 'all' | 'attention' | 'code' | 'agent';
export type BoardSort = 'updated' | 'name';

export const BOARD_FILTERS: { id: BoardFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'code', label: 'Code' },
  { id: 'agent', label: 'Agent instructions' },
];
export const BOARD_SORTS: { id: BoardSort; label: string }[] = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name' },
];

export interface BoardView {
  query: string;
  filter: BoardFilter;
  sort: BoardSort;
}

/** The board's view from the address (`?q=&filter=&sort=`): anything unknown falls back to the default. */
export function parseBoardParams(params: URLSearchParams): BoardView {
  const filter = params.get('filter');
  const sort = params.get('sort');
  return {
    query: params.get('q') ?? '',
    filter: BOARD_FILTERS.some((f) => f.id === filter)
      ? (filter as BoardFilter)
      : 'all',
    sort: BOARD_SORTS.some((s) => s.id === sort)
      ? (sort as BoardSort)
      : 'updated',
  };
}

/** A person has a move on one of its pull requests: approve it, answer a finding. */
export function needsAttention(row: BoardRow): boolean {
  return row.repo.stats.pulls.needsPerson > 0;
}

const matches = (row: BoardRow, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.repo.fullName} ${row.repo.description ?? ''}`
    .toLowerCase()
    .includes(q);
};

const inFilter = (row: BoardRow, filter: BoardFilter) =>
  filter === 'all' ||
  (filter === 'attention'
    ? needsAttention(row)
    : filter === 'agent'
      ? row.agent !== null
      : row.agent === null);

/** The rows the board shows: matching the search and the filter, in the chosen order. */
export function filterBoard(rows: BoardRow[], view: BoardView): BoardRow[] {
  const shown = rows.filter(
    (r) => matches(r, view.query) && inFilter(r, view.filter)
  );
  return shown.sort((a, b) =>
    view.sort === 'name'
      ? a.repo.name.localeCompare(b.repo.name) ||
        a.repo.fullName.localeCompare(b.repo.fullName)
      : b.repo.stats.updatedAt - a.repo.stats.updatedAt ||
        a.repo.fullName.localeCompare(b.repo.fullName)
  );
}

/** How many rows each filter would show for this search (the numbers on the filter pills). */
export function filterCounts(
  rows: BoardRow[],
  query: string
): Record<BoardFilter, number> {
  const found = rows.filter((r) => matches(r, query));
  return {
    all: found.length,
    attention: found.filter(needsAttention).length,
    code: found.filter((r) => r.agent === null).length,
    agent: found.filter((r) => r.agent !== null).length,
  };
}

export interface BoardTotals {
  repositories: number;
  /** Open pull requests. */
  open: number;
  /** Merged in the last seven days. */
  merged7d: number;
  /** Of those, how many GitOrange merged on its own. */
  automatic: number;
  /** `automatic` as a whole percentage; null when nothing merged. */
  automaticPct: number | null;
}

/** The tiles at the top of the board: every repository added up. */
export function boardTotals(rows: BoardRow[]): BoardTotals {
  let open = 0;
  let merged7d = 0;
  let automatic = 0;
  for (const { repo } of rows) {
    const s = repo.stats;
    open += s.pulls.open;
    merged7d += s.merged7d;
    // The server rounds the share to a whole percentage; undoing that gives the count back.
    automatic += Math.round(
      ((s.mergedAutomaticallyPct ?? 0) / 100) * s.merged7d
    );
  }
  return {
    repositories: rows.length,
    open,
    merged7d,
    automatic,
    automaticPct: merged7d ? Math.round((automatic / merged7d) * 100) : null,
  };
}

/** The segments of the "In flight" bar (`.sb-<key>`), in the order of whose move it is. */
export type FlightKey = 'needs' | 'asked' | 'reviewing' | 'clear';
export interface FlightSegment {
  key: FlightKey;
  /** Lower case, to follow its count: "2 checking". */
  label: string;
  count: number;
}

/**
 * What the open pull requests are waiting on. The buckets may add up to less than `open`: a pull request whose branch
 * is gone is in none of them. Empty buckets are left out.
 */
export function flightSegments(pulls: RepoStats['pulls']): FlightSegment[] {
  const all: FlightSegment[] = [
    { key: 'needs', label: 'needs a person', count: pulls.needsPerson },
    { key: 'asked', label: 'changes requested', count: pulls.changesRequested },
    { key: 'reviewing', label: 'checking', count: pulls.checking },
    { key: 'clear', label: 'queued', count: pulls.queued },
  ];
  return all.filter((s) => s.count > 0);
}

/** The board's one-line verdict on a repository's pull requests: what most needs a look first. */
export function pullChip(pulls: RepoStats['pulls']): {
  tone: Tone;
  label: string;
} {
  if (pulls.needsPerson > 0)
    return {
      tone: 'warn',
      label: `${pulls.needsPerson} ${pulls.needsPerson === 1 ? 'needs' : 'need'} a person`,
    };
  if (pulls.changesRequested > 0)
    return {
      tone: 'serious',
      label: `${pulls.changesRequested} with changes requested`,
    };
  if (pulls.checking > 0)
    return { tone: 'info', label: `${pulls.checking} being checked` };
  if (pulls.queued > 0)
    return { tone: 'good', label: `${pulls.queued} queued to merge` };
  if (pulls.open > 0) return { tone: 'off', label: `${pulls.open} open` };
  return { tone: 'off', label: 'No open pull requests' };
}

/** What blocks a merge, then what is in progress, then what is done: the order an agent's work is told in. */
const PRESSING: AgentActivity[] = [
  'failed',
  'changes_requested',
  'flagged',
  'reviewing',
  'approved',
];

/** The most pressing of several statuses (an agent across repositories); `idle` when none is pressing. */
export function mostPressing(statuses: AgentActivity[]): AgentActivity {
  let best = -1;
  for (const s of statuses) {
    const rank = PRESSING.indexOf(s);
    if (rank >= 0 && (best < 0 || rank < best)) best = rank;
  }
  return best < 0 ? 'idle' : PRESSING[best];
}

export interface CrewMember {
  handle: string;
  name: string;
  color: string;
  /** What it is doing across all the repositories it reviews. */
  status: AgentActivity;
}

/** The reviewers on these repositories, once each, in the order they first appear, with what each is doing. */
export function crewActivity(rows: BoardRow[]): CrewMember[] {
  const crew = new Map<string, CrewMember & { all: AgentActivity[] }>();
  for (const { repo } of rows)
    for (const a of repo.stats.agents) {
      const known = crew.get(a.handle);
      if (known) known.all.push(a.status);
      else crew.set(a.handle, { ...a, all: [a.status] });
    }
  return [...crew.values()].map(({ all, ...member }) => ({
    ...member,
    status: mostPressing(all),
  }));
}

const DAY_MS = 86_400_000;

/** Labels for the last `count` UTC days, oldest first, today last: "Fri, Oct 9". */
export function dayLabels(count: number, now: number): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Array.from({ length: count }, (_, i) =>
    new Date(today - (count - 1 - i) * DAY_MS).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })
  );
}

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Go: '#00add8',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  Ruby: '#701516',
  PHP: '#4f5d95',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Scala: '#c22d40',
  Dart: '#00b4ab',
  Lua: '#000080',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Clojure: '#db5855',
  Shell: '#89e051',
  SQL: '#e38c00',
  HTML: '#e34c26',
  CSS: '#663399',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Astro: '#ff5a03',
  Markdown: '#083fa1',
};

/** The dot beside a language's name; grey for one that has no colour here. */
export function languageColor(language: string | null): string {
  return (language && LANGUAGE_COLORS[language]) || '#8b949e';
}
