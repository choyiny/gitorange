import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  FileIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  RepoIcon,
  SearchIcon,
} from '@primer/octicons-react';
import { Identicon } from '@/components/Identicon';
import { useAppName } from '@/lib/appName';
import { useCurrentUser } from '@/lib/auth';
import type { RecentRepo } from '@/lib/recentRepos';
import {
  CLEARED,
  EMPTY_RESULTS,
  SEARCH_DEBOUNCE_MS,
  blurCloses,
  flattenSections,
  hitsFromResults,
  jumpHits,
  pageHits,
  searchKey,
  searchSections,
  searchTerm,
  type SearchHit,
  type SearchResults,
  type SearchState,
} from '@/lib/searchKeys';
import { searchQueryOptions } from '@/lib/searchQuery';
import { api, qk } from '@/lib/uiApi';
import type { ShellRepo } from './AppShell';
import { CrewIcon } from './icons';

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Where results come from: `GET /api/search`, scoped to the current repository when inside one (which also finds
 * its branches and files). The query is debounced; the previous results stay up while the next ones load (within
 * the same scope only), and a superseded request is aborted through the query's signal.
 */
function useSearchResults(
  q: string,
  repo: ShellRepo | null,
  enabled: boolean
): { results: SearchResults; pending: boolean; failed: boolean } {
  const wanted = searchTerm(q);
  const term = useDebounced(wanted, SEARCH_DEBOUNCE_MS);
  const scope = repo?.fullName ?? null;
  const search = useQuery(searchQueryOptions(term, scope, enabled));
  return {
    results: search.data ?? EMPTY_RESULTS,
    pending: wanted !== '' && (wanted !== term || search.isFetching),
    failed: search.isError,
  };
}

function HitIcon({ hit }: { hit: SearchHit }) {
  switch (hit.kind) {
    case 'repo':
      return <RepoIcon />;
    case 'pull':
      return <GitPullRequestIcon />;
    case 'agent':
      return <CrewIcon color={hit.color} />;
    case 'person':
      return <Identicon login={hit.label} size={16} />;
    case 'branch':
      return <GitBranchIcon />;
    case 'file':
      return <FileIcon />;
    default:
      return <ArrowRightIcon />;
  }
}

const optionId = (i: number) => `gsearch-opt-${i}`;
const groupId = (title: string) =>
  `gsearch-group-${title.toLowerCase().replace(/\s+/g, '-')}`;

const isField = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || !!el.closest('input, textarea, select'));

/**
 * Global search in the top band. `/` focuses it; results are grouped (Repositories, Pull requests, Agents, People,
 * Branches, Files, then Pages); arrow keys move (and wrap), Enter opens, Escape clears. Pressing outside closes and
 * clears it (the shell's outside-press handling), as does leaving it with Tab. Typing redraws only this component.
 */
export function GlobalSearch({
  open,
  onOpen,
  onClose,
  repo,
  recent,
}: {
  open: boolean;
  onOpen(): void;
  onClose(): void;
  repo: ShellRepo | null;
  recent: RecentRepo[];
}) {
  const navigate = useNavigate();
  const appName = useAppName();
  const admin = useCurrentUser()?.role === 'admin';
  const [state, setState] = useState<SearchState>(CLEARED);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pressedInside = useRef(false);

  const repos = useQuery({
    queryKey: qk.repos,
    queryFn: api.repos,
    enabled: open,
  });
  const { results, pending, failed } = useSearchResults(state.q, repo, open);
  const recentNames = recent.map((r) => r.fullName).join('\n');
  const hits = useMemo(
    () =>
      state.q.trim()
        ? [
            ...hitsFromResults(results, {
              defaultBranch: repo?.defaultBranch,
            }),
            ...pageHits(state.q, {
              admin,
              repo: repo?.fullName ?? null,
              repoAdmin: repo?.admin,
            }),
          ]
        : jumpHits(
            repos.data ?? [],
            recentNames ? recentNames.split('\n') : []
          ),
    [state.q, results, repo, admin, repos.data, recentNames]
  );
  const sections = useMemo(
    () => searchSections(state.q, hits),
    [state.q, hits]
  );
  const flat = useMemo(() => flattenSections(sections), [sections]);
  const sel = flat.length ? Math.min(state.sel, flat.length - 1) : 0;

  // Closed from outside (a press elsewhere, a new page, Escape): forget the query.
  useEffect(() => {
    if (!open) setState(CLEARED);
  }, [open]);

  // `/` anywhere but a field focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.defaultPrevented || isField(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Keep the selected row in view while arrowing through a long list.
  useEffect(() => {
    if (open)
      document
        .getElementById(optionId(sel))
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, sel]);

  const close = () => {
    setState(CLEARED);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const r = searchKey({ ...state, sel }, e.key, flat);
    if (!r.handled) return;
    e.preventDefault();
    setState(r.state);
    if (r.close) {
      onClose();
      inputRef.current?.blur();
    }
    if (r.go) navigate(r.go);
  };

  const showMenu = open && (sections.length > 0 || !!state.q.trim());
  let index = -1;

  return (
    <div
      ref={boxRef}
      className={`gsearch${open ? ' open' : ''}`}
      role="search"
      data-menu-root="search"
      onPointerDown={() => {
        // A press inside (the results' scrollbar, the padding) may blur the input; that isn't leaving.
        pressedInside.current = true;
        const release = () => {
          setTimeout(() => (pressedInside.current = false));
          window.removeEventListener('pointerup', release, true);
        };
        window.addEventListener('pointerup', release, true);
      }}
      onBlur={(e) => {
        // Tabbing out closes it; a press elsewhere is handled by the shell.
        if (
          open &&
          blurCloses({
            windowFocused: document.hasFocus(),
            pressedInside: pressedInside.current,
            focusInside: !!boxRef.current?.contains(
              e.relatedTarget as Node | null
            ),
          })
        )
          close();
      }}
    >
      <label className="sr" htmlFor="gsearch">
        Search {appName}
      </label>
      <SearchIcon className="gs-ic" />
      <input
        ref={inputRef}
        id="gsearch"
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder="Type / to search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showMenu}
        aria-controls="gsearch-results"
        aria-activedescendant={
          showMenu && flat.length ? optionId(sel) : undefined
        }
        value={state.q}
        onFocus={() => {
          if (!open) onOpen();
        }}
        onChange={(e) => {
          setState({ q: e.target.value, sel: 0 });
          if (!open) onOpen();
        }}
        onKeyDown={onKeyDown}
      />
      <kbd className="gs-kbd" aria-hidden="true">
        /
      </kbd>
      {showMenu && (
        <div
          className="ws-menu gs-menu"
          id="gsearch-results"
          role="listbox"
          aria-label="Search results"
        >
          {sections.length === 0 ? (
            <p className="gs-empty" role="status">
              {pending
                ? 'Searching…'
                : failed
                  ? 'Search isn’t available right now.'
                  : `No results for “${state.q.trim()}”.`}
            </p>
          ) : (
            sections.map((s) => (
              <div
                key={s.title}
                role="group"
                aria-labelledby={groupId(s.title)}
              >
                <div className="dd-label" id={groupId(s.title)}>
                  {s.title}
                </div>
                {s.hits.map((h) => {
                  index += 1;
                  const i = index;
                  return (
                    <Link
                      key={`${h.kind}:${h.to}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === sel}
                      tabIndex={-1}
                      className={`ws-item gs-item${i === sel ? ' sel' : ''}`}
                      to={h.to}
                      // Keep focus in the input so a click is never lost to the blur that closes the list.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => {
                        if (i !== sel) setState((st) => ({ ...st, sel: i }));
                      }}
                      onClick={() => {
                        close();
                        inputRef.current?.blur();
                      }}
                    >
                      <HitIcon hit={h} />
                      <span>
                        <b
                          className={
                            h.kind === 'file' || h.kind === 'branch'
                              ? 'mono'
                              : undefined
                          }
                        >
                          {h.label}
                        </b>
                        {h.sub && <span className="sub">{h.sub}</span>}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
