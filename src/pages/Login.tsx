import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/uiApi';
import { signIn, useSession } from '@/lib/auth';
import { Spinner } from '@/components/Spinner';
import { AuthShell, FlashError } from './AuthShell';

export default function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const returnTo = params.get('return_to')?.startsWith('/')
    ? params.get('return_to')!
    : '/';
  const status = useQuery({ queryKey: qk.setup, queryFn: api.setupStatus });
  const { data: session, isPending } = useSession();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.isPending || isPending) return <Spinner />;
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  // Part of an OAuth sign-in (e.g. an MCP client) but already signed in, say in another tab:
  // resume the authorization request instead of going home.
  if (session && params.has('sig') && params.has('client_id')) {
    window.location.replace(`/api/auth/oauth2/authorize?${params.toString()}`);
    return <Spinner />;
  }
  if (session) return <Navigate to={returnTo} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = login.includes('@')
      ? await signIn.email({ email: login, password })
      : await signIn.username({ username: login, password });
    setBusy(false);
    if (res.error) {
      setError('Incorrect username or password.');
      return;
    }
    // During an OAuth sign-in the server answers with where the flow continues (consent).
    const next = (res.data as { url?: string } | null)?.url;
    if (next) {
      window.location.href = next;
      return;
    }
    await qc.invalidateQueries();
    navigate(returnTo);
  };

  return (
    <AuthShell title="Sign in to GitOrange">
      <FlashError message={error} />
      <form className="auth-form-body" onSubmit={submit}>
        <label htmlFor="login_field">Username or email address</label>
        <input
          id="login_field"
          className="form-control input-block mt-1 mb-3"
          autoFocus
          autoComplete="username"
          required
          value={login}
          onChange={(e) => setLogin(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          className="form-control input-block mt-1 mb-3"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-3 p-3 text-center f6 color-fg-muted border rounded-2">
        New to this instance? Ask an administrator for an invitation.
      </p>
    </AuthShell>
  );
}
