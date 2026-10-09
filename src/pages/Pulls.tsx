import {
  Link,
  useNavigate,
  useOutletContext,
  useSearchParams,
} from 'react-router-dom';
import type { RepoDetail } from '@/lib/uiApi';
import { parsePullsView, pullsHref, type PullsView } from '@/lib/pullsView';
import { PageHead } from '@/components/ui/PageHead';
import { Seg } from '@/components/ui/Seg';
import { PullBoard } from '@/components/PullBoard';
import { PullGraph } from '@/components/PullGraph';
import { PullList } from '@/components/PullList';

const VIEW_KEY = 'gitorange.pulls.view';

/** The view a person last chose, so the page opens on it again. A convenience: never fails without storage. */
function storedView(): string | null {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

function rememberView(view: PullsView) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Remembering the view is a convenience only.
  }
}

const VIEWS = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
  { value: 'graph', label: 'Graph' },
] as const satisfies readonly { value: PullsView; label: string }[];

const count = (n: number) => `${n} open`;

/**
 * Pull requests: a board by whose move it is (`?view=board`, the default), a list with filters and search
 * (`?view=list`, `?state=`, `?q=`, `?page=`) and the graph of how they are slated to land (`?view=graph`).
 */
export default function Pulls() {
  const repo = useOutletContext<RepoDetail>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const base = `/${repo.fullName}`;
  const params = parsePullsView(search, storedView());
  const { view } = params;
  const open = repo.openPullCount;

  const lede =
    view === 'board'
      ? open
        ? `${count(open)}, sorted by who has to act next.`
        : 'Nothing is open. Merged pull requests are below.'
      : view === 'list'
        ? 'Every pull request, open or closed. Filter them or search by number, title, person, branch or session.'
        : 'How the open pull requests are slated to land, branch by branch.';

  return (
    <>
      <PageHead
        icon="pull"
        crumbs={[{ label: 'Pull requests' }]}
        title="Pull requests"
        tab="pulls"
        lede={lede}
        actions={
          repo.permissions.write ? (
            <Link to={`${base}/compare`} className="btn primary">
              New pull request
            </Link>
          ) : undefined
        }
      />
      <div className="pulls-bar">
        <Seg
          label="View"
          options={VIEWS}
          value={view}
          onChange={(next) => {
            rememberView(next);
            navigate(pullsHref(base, { view: next }));
          }}
        />
      </div>
      {view === 'board' && <PullBoard repo={repo} />}
      {view === 'list' && <PullList repo={repo} params={params} />}
      {view === 'graph' && <PullGraph repo={repo} />}
    </>
  );
}
