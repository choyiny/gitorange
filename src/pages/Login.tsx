import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/uiApi';
import { signIn, useSession } from '@/lib/auth';
import { PendingButton } from '@/components/ui/PendingButton';
import { AuthLoading, AuthShell, FlashError } from './AuthShell';

export default function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const returnTo = params.get('return_to')?.startsWith('/')
    ? params.get('return_to')!
    : '/';
  const status = useQuery({ queryKey: qk.setup, queryFn: api.setupStatus });
  const appName = status.data?.appName || 'GitOrange';
  const { data: session, isPending } = useSession();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.isPending || isPending) return <AuthLoading />;
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  // Already signed in during an OAuth flow: resume the authorization request.
  if (session && params.has('sig') && params.has('client_id')) {
    window.location.replace(`/api/auth/oauth2/authorize?${params.toString()}`);
    return <AuthLoading />;
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
    // During an OAuth flow the response says where it continues.
    const next = (res.data as { url?: string } | null)?.url;
    if (next) {
      window.location.href = next;
      return;
    }
    await qc.invalidateQueries();
    navigate(returnTo);
  };

  return (
    <AuthShell title={`Sign in to ${appName}`} docTitle="Sign in">
      <FlashError message={error} />
      <form className="auth-fields" onSubmit={submit}>
        <div className="fld">
          <label htmlFor="login_field">Username or email address</label>
          <input
            id="login_field"
            className="form-control"
            autoFocus
            autoComplete="username"
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </div>
        <div className="fld">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="form-control"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <PendingButton
          type="submit"
          className="primary block"
          pending={busy}
          pendingLabel="Signing in…"
        >
          Sign in
        </PendingButton>
      </form>
      <p className="auth-foot">
        New to this instance? Ask an administrator for an invitation.
      </p>
    </AuthShell>
  );
}
