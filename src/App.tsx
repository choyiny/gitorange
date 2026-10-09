import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { useSession } from '@/lib/auth';
import { api, qk } from '@/lib/uiApi';
import { Spinner } from '@/components/Spinner';
import { LiveUpdates } from '@/lib/live';
import { RepoLayout } from '@/components/RepoLayout';
import { AppShell } from '@/components/shell/AppShell';
import { PageHeadProvider, useCurrentPageHead } from '@/components/ui/PageHead';
import Setup from './pages/Setup';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import Home from './pages/Home';
import Repositories from './pages/Repositories';
import Approvals from './pages/Approvals';
import Finding from './pages/Finding';
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
import RepoInsights from './pages/RepoInsights';
import { useDocumentTitle } from './lib/appName';
import SettingsMcp from './pages/SettingsMcp';
import OAuthConsent from './pages/OAuthConsent';
import RunView from './pages/RunView';
import AgentRunView from './pages/AgentRuns';
import SettingsTokens from './pages/SettingsTokens';
import SettingsEmails, { VerifyEmail } from './pages/SettingsEmails';
import Admin from './pages/Admin';
import AdminUsage from './pages/AdminUsage';
import AdminAudit from './pages/AdminAudit';
import AdminAgents from './pages/AdminAgents';
import Agents from './pages/Agents';
import AgentNew from './pages/AgentNew';
import AgentBuiltin from './pages/AgentBuiltin';
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
  return <LiveUpdates>{children}</LiveUpdates>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { data } = useSession();
  if ((data?.user as any)?.role !== 'admin') return <NotFound />;
  return <>{children}</>;
}

/** Sets the tab title: the page's name (from the top band) and the instance name. */
function DocumentTitle() {
  const head = useCurrentPageHead();
  useDocumentTitle(head ? (head.documentTitle ?? head.title) : null);
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <PageHeadProvider>
      <DocumentTitle />
      <BrowserRouter>
        <Routes>
          {/* Public and auth pages: no rail. */}
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/invite/:token" element={<AcceptInvite />} />
          <Route
            element={
              <Gate>
                <Outlet />
              </Gate>
            }
          >
            {/* Signed in, but an authorization page of its own: no rail. */}
            <Route path="/oauth/consent" element={<OAuthConsent />} />
            <Route element={<AppShell />}>
              <Route path="/" element={<Home />} />
              <Route path="/repos" element={<Repositories />} />
              {/* Every member reads the agents; creating them is for site admins (the page says so). */}
              <Route path="/agents" element={<Agents />} />
              <Route path="/agents/new" element={<AgentNew />} />
              <Route path="/agents/:id" element={<AgentBuiltin />} />
              <Route path="/new" element={<NewRepo />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/approvals/:flagId" element={<Finding />} />
              <Route path="/settings/tokens" element={<SettingsTokens />} />
              <Route path="/settings/mcp" element={<SettingsMcp />} />
              <Route path="/settings/emails" element={<SettingsEmails />} />
              <Route path="/settings/emails/verify" element={<VerifyEmail />} />
              <Route
                path="/admin"
                element={
                  <AdminOnly>
                    <Admin />
                  </AdminOnly>
                }
              />
              <Route
                path="/admin/usage"
                element={
                  <AdminOnly>
                    <AdminUsage />
                  </AdminOnly>
                }
              />
              <Route
                path="/admin/audit"
                element={
                  <AdminOnly>
                    <AdminAudit />
                  </AdminOnly>
                }
              />
              <Route
                path="/admin/agents"
                element={
                  <AdminOnly>
                    <AdminAgents />
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
                <Route path="actions/agent/:id" element={<AgentRunView />} />
                <Route
                  path="actions/runs/:number/job/:jobId"
                  element={<RunView />}
                />
                <Route path="insights" element={<RepoInsights />} />
                <Route path="settings" element={<RepoSettings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </PageHeadProvider>
  </QueryClientProvider>
);

export default App;
