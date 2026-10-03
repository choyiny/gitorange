import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/uiApi';
import { signIn } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { Spinner } from '@/components/Spinner';
import { AuthShell, FlashError } from './AuthShell';
import { useAppName } from '@/lib/appName';

export default function Setup() {
  const appName = useAppName();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: qk.setup, queryFn: api.setupStatus });
  const [form, setForm] = useState({
    name: '',
    username: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.isPending) return <Spinner />;
  if (!status.data?.setupRequired) return <Navigate to="/login" replace />;

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup(form);
      const res = await signIn.email({
        email: form.email,
        password: form.password,
      });
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
    <AuthShell title={`Welcome to ${appName}`} wide>
      <p className="color-fg-muted text-center mb-3">
        Let's set up your instance. Create the first administrator account — you
        can invite the rest of your team once you're in.
      </p>
      <FlashError message={error} />
      <form className="auth-form-body" onSubmit={submit}>
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
          autoComplete="username"
        />
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          className="form-control input-block mt-1 mb-3"
          required
          value={form.email}
          onChange={set('email')}
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
          {busy ? 'Creating account…' : 'Create admin account'}
        </button>
      </form>
    </AuthShell>
  );
}
