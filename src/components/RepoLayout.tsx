import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RepoIcon } from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { useLiveRepo } from '@/lib/live';
import { repoBand, repoRest, repoTabOf, repoTabs } from '@/lib/repoNav';
import {
  PageHeadContext,
  usePageHead,
  type PageHeadInfo,
} from '@/components/ui/PageHead';
import { useForgetRepo, useShellRepo } from '@/components/shell/AppShell';
import { CrewIcon, PageIcon } from '@/components/shell/icons';
import { Spinner } from './Spinner';
import { NOT_FOUND_HEAD, NotFound } from '@/pages/NotFound';

export function useRepoParams() {
  const { owner = '', repo = '' } = useParams();
  return { owner, repo };
}

/** The path after `/:owner/:repo/<section>/` (useParams()['*'] clashes with the outer route). */
export function useRepoSubPath(section: string) {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  if (parts[2] !== section) return '';
  return decodeURIComponent(parts.slice(3).join('/'));
}

export function useRepo() {
  const { owner, repo } = useRepoParams();
  return useQuery({
    queryKey: qk.repo(owner, repo),
    queryFn: () => api.repo(owner, repo),
  });
}

/**
 * The agent whose instructions live in `<handle>/<handle>`, if this is such a repository. Agent repositories
 * always have the owner's name, so other repositories never load the agent list.
 */
function useRepoAgent(owner: string, repo: string) {
  const isCandidate = owner.toLowerCase() === repo.toLowerCase();
  const agents = useQuery({
    queryKey: qk.agents,
    queryFn: api.agents,
    enabled: isCandidate,
  });
  if (!isCandidate) return null;
  return (
    agents.data?.find(
      (a) => a.username.toLowerCase() === owner.toLowerCase()
    ) ?? null
  );
}

const VISIBILITY_TITLE = {
  private: 'Only you, collaborators, and site admins can see this',
  internal: 'Every member can see this',
} as const;

/**
 * Every repository page: the repository header and its tabs at the top of the work panel, the repository in the
 * top band's trail, and the loaded `RepoDetail` for the page (Outlet context). Pages name themselves with
 * `usePageHead` (crumbs relative to the repository); until they do, the trail comes from the URL (`repoBand`).
 */
export function RepoLayout() {
  const { owner, repo } = useRepoParams();
  const q = useRepo();
  const data = q.data;
  // Subscribe only once the user is known to have access.
  useLiveRepo(data ? owner : '', data ? repo : '');
  const agent = useRepoAgent(owner, repo);
  const { pathname } = useLocation();
  const base = `/${owner}/${repo}`;
  const rest = repoRest(pathname);
  const isAgentRepo = !!agent;

  const missing = q.error instanceof ApiError && q.error.status === 404;

  // What the page published (null: it hasn't, so the trail comes from the URL).
  const [pageHead, setPageHead] = useState<PageHeadInfo | null>(null);
  const fallback = repoBand(rest, base, isAgentRepo);
  const own: PageHeadInfo = pageHead ?? fallback;
  const activeTab = pageHead?.tab ?? repoTabOf(rest, isAgentRepo);
  usePageHead(
    missing
      ? NOT_FOUND_HEAD
      : {
          icon: own.icon ?? fallback.icon,
          crumbs: [
            { label: owner, to: `/${owner}` },
            { label: repo, to: base },
            ...own.crumbs,
          ],
          title: own.title,
          tab: activeTab,
          documentTitle: `${own.documentTitle ?? own.title} · ${owner}/${repo}`,
        }
  );

  const shellRepo = useMemo(
    () =>
      data
        ? {
            fullName: data.fullName,
            defaultBranch: data.defaultBranch,
            branches: data.branches.map((b) => b.name),
            admin: data.permissions.admin,
            agent: agent
              ? {
                  handle: agent.username,
                  // Sent since crew redesign B1; typed in uiApi by C0.
                  color: (agent as { color?: string | null }).color ?? null,
                }
              : null,
          }
        : null,
    [data, agent]
  );
  useShellRepo(shellRepo);

  const forget = useForgetRepo();
  useEffect(() => {
    if (missing) forget(`${owner}/${repo}`);
  }, [missing, forget, owner, repo]);

  if (missing) return <NotFound />;

  const tabs = repoTabs(isAgentRepo, !!data?.permissions.admin);
  return (
    <>
      <div className="rhead">
        <div className="rhead-row">
          <span className="rhead-name">
            {isAgentRepo ? <CrewIcon /> : <RepoIcon />}
            <Link to={`/${owner}`}>{owner}</Link>
            <span className="sep">/</span>
            <Link to={base}>
              <b>{repo}</b>
            </Link>
          </span>
          {data && (
            <span className="vis" title={VISIBILITY_TITLE[data.visibility]}>
              {data.visibility === 'private' ? 'Private' : 'Internal'}
            </span>
          )}
          {agent && (
            <>
              <span className="vis">Agent instructions</span>
              <Link className="rhead-link" to={`/${agent.username}`}>
                {agent.name}&rsquo;s profile
              </Link>
            </>
          )}
        </div>
        <nav className="rtabs" aria-label="Repository">
          {tabs.map((t) => (
            <Link
              key={t.id}
              to={t.path ? `${base}/${t.path}` : base}
              aria-current={t.id === activeTab ? 'page' : undefined}
            >
              <PageIcon name={t.icon} />
              {t.label}
              {t.id === 'pulls' && !!data?.openPullCount && (
                <span className="count">{data.openPullCount}</span>
              )}
            </Link>
          ))}
        </nav>
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <PageHeadContext.Provider value={setPageHead}>
          <Outlet context={data satisfies RepoDetail} />
        </PageHeadContext.Provider>
      )}
    </>
  );
}
