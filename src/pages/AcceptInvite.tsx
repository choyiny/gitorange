import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/uiApi';
import { signIn, signOut, useSession } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { PendingButton } from '@/components/ui/PendingButton';
import { Notice } from '@/components/Notice';
import { AuthLoading, AuthShell, FlashError } from './AuthShell';
import { useAppName } from '@/lib/appName';

export default function AcceptInvite() {
  const appName = useAppName();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.validateInvite(token),
    retry: false,
  });
  const [form, setForm] = useState({ name: '', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (invite.isPending) return <AuthLoading />;
  if (invite.error) {
    return (
      <AuthShell title="Invitation not found" docTitle="Invitation not found">
        <Notice tone="warn">
          This invitation is invalid, has expired, or was already used.
        </Notice>
        <Link to="/login" className="btn block">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (session) await signOut();
      const { email } = await api.acceptInvite({ token, ...form });
      const res = await signIn.email({ email, password: form.password });
      if (res.error) throw new Error(res.error.message);
      await qc.invalidateQueries();
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title={`Join ${appName}`}
      docTitle="Join"
      lede={
        invite.data.inviter ? (
          <>
            <b>@{invite.data.inviter}</b> invited you to join.
          </>
        ) : (
          'You have been invited to join.'
        )
      }
      wide
    >
      <FlashError message={error} />
      <form className="auth-fields" onSubmit={submit}>
        <div className="fld">
          <label htmlFor="invite-email">Email address</label>
          <input
            id="invite-email"
            className="form-control"
            value={invite.data.email}
            disabled
          />
        </div>
        <div className="fld">
          <label htmlFor="name">Full name</label>
          <input
            id="name"
            className="form-control"
            required
            value={form.name}
            onChange={set('name')}
            autoFocus
          />
        </div>
        <div className="fld">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            className="form-control"
            required
            value={form.username}
            onChange={set('username')}
            autoComplete="username"
          />
        </div>
        <div className="fld">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            minLength={8}
            className="form-control"
            required
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="hint">
            Make sure it is at least 8 characters.
          </p>
        </div>
        <PendingButton
          type="submit"
          className="primary block"
          pending={busy}
          pendingLabel="Creating account…"
        >
          Create account
        </PendingButton>
      </form>
    </AuthShell>
  );
}
