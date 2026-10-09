/**
 * The Pull requests page's URL: which view (`?view=board|list|graph`), and on the list the state filter
 * (`?state=closed|agent_followup|human_review|waiting|ready`), the search text (`?q=`) and the page (`?page=`).
 */
import type { Pull, PullStateName } from './uiApi';
import { coderOf } from './coder';

export type PullsView = 'board' | 'list' | 'graph';
export const PULLS_VIEWS: readonly PullsView[] = ['board', 'list', 'graph'];

/** The list's states: every open one (the default), the closed and merged ones, or one of whose move it is. */
export type ListState = 'open' | 'closed' | PullStateName;

/** The filters in the order the list's menu shows them. */
export const OPEN_FILTERS: readonly PullStateName[] = [
  'human_review',
  'agent_followup',
  'waiting',
  'ready',
];

export const PULLS_PAGE_SIZE = 25;

export interface PullsParams {
  view: PullsView;
  state: ListState;
  q: string;
  page: number;
}

const isView = (v: string | null): v is PullsView =>
  PULLS_VIEWS.includes(v as PullsView);

/**
 * Reads the page's URL. `?view=` wins; without it a state filter (the links older versions of the page made) means
 * the list, and otherwise the view the person last chose (`stored`), else the board.
 */
export function parsePullsView(
  params: URLSearchParams,
  stored: string | null
): PullsParams {
  const raw = params.get('state');
  const state: ListState =
    raw === 'closed'
      ? 'closed'
      : (OPEN_FILTERS.find((f) => f === raw) ?? 'open');
  const asked = params.get('view');
  const view: PullsView = isView(asked)
    ? asked
    : state !== 'open'
      ? 'list'
      : isView(stored)
        ? stored
        : 'board';
  const page = Number(params.get('page'));
  return {
    view,
    state,
    q: (params.get('q') ?? '').trim(),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The page's address for a view, leaving out whatever is the default. Filters only travel with the list. */
export function pullsHref(base: string, next: Partial<PullsParams>): string {
  const query = new URLSearchParams();
  const view = next.view ?? 'board';
  if (view !== 'board') query.set('view', view);
  if (view === 'list') {
    if (next.state && next.state !== 'open') query.set('state', next.state);
    if (next.q?.trim()) query.set('q', next.q.trim());
    if (next.page && next.page > 1) query.set('page', String(next.page));
  }
  const qs = query.toString();
  return `${base}/pulls${qs ? `?${qs}` : ''}`;
}

/** Everything a search can match on one pull request, lower-cased. */
function haystack(p: Pull): string {
  const coder = coderOf(p.createdVia, p.sessionLabel);
  return [
    `#${p.number}`,
    p.title,
    p.author.username,
    p.author.name,
    p.headRef,
    coder.label,
    coder.name,
    coder.title,
    p.sessionLabel ?? '',
    // The word the chip says for a pull request nobody's app opened.
    coder.kind === 'person' ? 'by hand' : '',
  ]
    .join('\n')
    .toLowerCase();
}

/** The pull requests every word of `query` matches: number (with or without #), title, author, branch, session. */
export function filterPulls(pulls: Pull[], query: string): Pull[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return pulls;
  // "by hand" is two words in a search box and one phrase on the chip.
  const phrase = query.trim().toLowerCase().includes('by hand');
  return pulls.filter((p) => {
    const text = haystack(p);
    if (phrase && !text.includes('by hand')) return false;
    const rest = phrase
      ? words.filter((w) => w !== 'by' && w !== 'hand')
      : words;
    return rest.every((w) => {
      // "#11" is that pull request; plain digits are its number's start, or any text that has them.
      if (/^#\d+$/.test(w)) return String(p.number) === w.slice(1);
      if (/^\d+$/.test(w))
        return String(p.number).startsWith(w) || text.includes(w);
      return text.includes(w);
    });
  });
}

/** One page of `items` (1-based), the page clamped into range, and how many there are. */
export function paginate<T>(
  items: T[],
  page: number,
  size = PULLS_PAGE_SIZE
): { items: T[]; page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((at - 1) * size, at * size),
    page: at,
    pages,
    total: items.length,
  };
}
