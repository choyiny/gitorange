import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { useSession } from '@/lib/auth';
import { api, qk } from '@/lib/uiApi';
import { Spinner } from '@/components/Spinner';
import { RepoLayout } from '@/components/RepoLayout';
import Setup from './pages/Setup';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import Dashboard from './pages/Dashboard';
import NewRepo from './pages/NewRepo';
import Profile from './pages/Profile';
import RepoCode from './pages/RepoCode';
import RepoCommits from './pages/RepoCommits';
import CommitView from './pages/CommitView';
import Pulls from './pages/Pulls';
import PullNew from './pages/PullNew';
import PullView from './pages/PullView';
import RepoSettings from './pages/RepoSettings';
import RepoActions from './pages/RepoActions';
import SettingsMcp from './pages/SettingsMcp';
import OAuthConsent from './pages/OAuthConsent';
import RunView from './pages/RunView';
import SettingsTokens from './pages/SettingsTokens';
import Admin from './pages/Admin';
import { NotFound } from './pages/NotFound';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (n, e: any) => e?.status !== 404 && n < 2,
      refetchOnWindowFocus: false,
    },
  },
});

/** First run → /setup; afterwards every page needs a session. */
function Gate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const setup = useQuery({ queryKey: qk.setup, queryFn: api.setupStatus });
  const { data: session, isPending } = useSession();
  if (setup.isPending || isPending) return <Spinner />;
  if (setup.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (!session)
    return (
      <Navigate
        to={`/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  return <>{children}</>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { data } = useSession();
  if ((data?.user as any)?.role !== 'admin') return <NotFound />;
  return <>{children}</>;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route
          path="*"
          element={
            <Gate>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/new" element={<NewRepo />} />
                <Route path="/settings/tokens" element={<SettingsTokens />} />
                <Route path="/settings/mcp" element={<SettingsMcp />} />
                <Route path="/oauth/consent" element={<OAuthConsent />} />
                <Route
                  path="/admin"
                  element={
                    <AdminOnly>
                      <Admin />
                    </AdminOnly>
                  }
                />
                <Route path="/:owner" element={<Profile />} />
                <Route path="/:owner/:repo" element={<RepoLayout />}>
                  <Route index element={<RepoCode />} />
                  <Route path="tree/*" element={<RepoCode />} />
                  <Route path="blob/*" element={<RepoCode />} />
                  <Route path="commits/*" element={<RepoCommits />} />
                  <Route path="commit/:sha" element={<CommitView />} />
                  <Route path="pulls" element={<Pulls />} />
                  <Route path="compare" element={<PullNew />} />
                  <Route path="compare/*" element={<PullNew />} />
                  <Route path="pull/:number" element={<PullView />} />
                  <Route path="pull/:number/:tab" element={<PullView />} />
                  <Route path="actions" element={<RepoActions />} />
                  <Route path="actions/runs/:number" element={<RunView />} />
                  <Route
                    path="actions/runs/:number/job/:jobId"
                    element={<RunView />}
                  />
                  <Route path="settings" element={<RepoSettings />} />
                  <Route path="*" element={<NotFound inline />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Gate>
          }
        />
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;
