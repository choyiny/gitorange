import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/uiApi';
import { signIn, signOut, useSession } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { Spinner } from '@/components/Spinner';
import { AuthShell, FlashError } from './AuthShell';

export default function AcceptInvite() {
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

  if (invite.isPending) return <Spinner />;
  if (invite.error) {
    return (
      <AuthShell title="Invitation not found">
        <div className="flash flash-warn mb-3">
          This invitation is invalid, has expired, or was already used.
        </div>
        <Link to="/login" className="btn btn-block">
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
    <AuthShell title="Join GitOrange" wide>
      <p className="color-fg-muted text-center mb-3">
        {invite.data.inviter ? (
          <>
            <strong className="color-fg-default">@{invite.data.inviter}</strong>{' '}
            invited you to join.
          </>
        ) : (
          'You have been invited to join.'
        )}
      </p>
      <FlashError message={error} />
      <form className="auth-form-body" onSubmit={submit}>
        <label>Email address</label>
        <input
          className="form-control input-block mt-1 mb-3"
          value={invite.data.email}
          disabled
        />
        <label htmlFor="name">Full name</label>
        <input
          id="name"
          className="form-control input-block mt-1 mb-3"
          required
          value={form.name}
          onChange={set('name')}
          autoFocus
        />
        <label htmlFor="username">Username</label>
        <input
          id="username"
          className="form-control input-block mt-1 mb-3"
          required
          value={form.username}
          onChange={set('username')}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          minLength={8}
          className="form-control input-block mt-1 mb-1"
          required
          value={form.password}
          onChange={set('password')}
          autoComplete="new-password"
        />
        <p className="note mb-3">Make sure it's at least 8 characters.</p>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}
