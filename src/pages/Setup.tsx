import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/uiApi';
import { signIn } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { PendingButton } from '@/components/ui/PendingButton';
import { AuthLoading, AuthShell, FlashError } from './AuthShell';
import { useAppName } from '@/lib/appName';

/** First run: create the first administrator account. */
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
  if (status.isPending) return <AuthLoading />;
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
    <AuthShell
      title={`Welcome to ${appName}`}
      docTitle="Set up"
      lede="Let’s set up your instance. Create the first administrator account. You can invite the rest of your team once you are in."
      wide
    >
      <FlashError message={error} />
      <form className="auth-fields" onSubmit={submit}>
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
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            className="form-control"
            required
            value={form.email}
            onChange={set('email')}
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
          Create admin account
        </PendingButton>
      </form>
    </AuthShell>
  );
}
