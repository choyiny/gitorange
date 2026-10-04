import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, type AlternateEmail } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { Header } from '@/components/Header';
import { Spinner } from '@/components/Spinner';
import { SettingsNav } from '@/components/SettingsNav';

/** Settings → Emails: the addresses whose commits are linked to your profile. */
export default function SettingsEmails() {
  const qc = useQueryClient();
  const emails = useQuery({ queryKey: qk.emails, queryFn: api.emails });
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.emails });
  const sentNotice = (to: string, emailed: boolean) =>
    setNotice(
      emailed
        ? `We sent a verification link to ${to}. Open it while signed in to finish.`
        : `${to} was added, but the verification email could not be sent. Try "Resend" later.`
    );
  const add = useMutation({
    mutationFn: () =>
      api.addEmail({ email: email.trim(), label: label.trim() || null }),
    onSuccess: (r) => {
      setEmail('');
      setLabel('');
      setError(null);
      sentNotice(r.email.email, r.emailed);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEmail(id),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.resendEmailVerification(id),
    onSuccess: (r) => {
      setError(null);
      sentNotice(r.email.email, r.emailed);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const data = emails.data;
  return (
    <>
      <Header context={<span className="text-bold px-2">Settings</span>} />
      <div className="container-lg px-3 py-4 d-flex" style={{ gap: 24 }}>
        <SettingsNav />
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="Subhead">
            <h2 className="Subhead-heading">Emails</h2>
            <div className="Subhead-description">
              Commits whose author or committer email is one of these are linked
              to your profile. Add the addresses you set as{' '}
              <code>user.email</code> in git. Other addresses must be verified
              before they count.
            </div>
          </div>
          {data && !data.emailConfigured && (
            <div className="flash flash-warn mb-3">
              This instance cannot send email, so verification links can't be
              delivered and new addresses stay unverified. Ask a site admin to
              configure email sending.
            </div>
          )}
          {notice && <div className="flash mb-3">{notice}</div>}
          {error && <div className="flash flash-error mb-3">{error}</div>}
          {!data ? (
            <Spinner />
          ) : (
            <>
              <div className="Box mb-4">
                <div
                  className="Box-row d-flex flex-items-center flex-wrap"
                  style={{ gap: 8 }}
                >
                  <span className="text-bold text-break">{data.primary}</span>
                  <span className="Label Label--accent">Primary</span>
                  <span className="f6 color-fg-muted">Your account email.</span>
                </div>
                {data.alternates.map((e) => (
                  <EmailRow
                    key={e.id}
                    e={e}
                    onRemove={() => remove.mutate(e.id)}
                    onResend={() => resend.mutate(e.id)}
                    resending={resend.isPending && resend.variables === e.id}
                  />
                ))}
              </div>
              <form
                className="Box p-3"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  setNotice(null);
                  add.mutate();
                }}
              >
                <h3 className="f4 mb-3">Add email address</h3>
                <div
                  className="d-flex flex-wrap flex-items-end"
                  style={{ gap: 12 }}
                >
                  <div className="flex-1" style={{ minWidth: 220 }}>
                    <label
                      className="d-block f6 text-bold mb-1"
                      htmlFor="email-address"
                    >
                      Email address
                    </label>
                    <input
                      id="email-address"
                      type="email"
                      className="form-control width-full"
                      required
                      maxLength={254}
                      placeholder="you@work.example"
                      value={email}
                      onChange={(ev) => setEmail(ev.target.value)}
                    />
                  </div>
                  <div style={{ minWidth: 160 }}>
                    <label
                      className="d-block f6 text-bold mb-1"
                      htmlFor="email-label"
                    >
                      Label <span className="text-normal">(optional)</span>
                    </label>
                    <input
                      id="email-label"
                      className="form-control width-full"
                      maxLength={40}
                      placeholder="Work, Personal…"
                      value={label}
                      onChange={(ev) => setLabel(ev.target.value)}
                    />
                  </div>
                  <button className="btn btn-primary" disabled={add.isPending}>
                    Add
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function EmailRow({
  e,
  onRemove,
  onResend,
  resending,
}: {
  e: AlternateEmail;
  onRemove: () => void;
  onResend: () => void;
  resending: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(e.label ?? '');
  const save = useMutation({
    mutationFn: () => api.updateEmail(e.id, { label: label.trim() || null }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: qk.emails });
    },
  });
  const expired =
    !e.verified &&
    (!e.verificationExpiresAt ||
      new Date(e.verificationExpiresAt) < new Date());
  return (
    <div
      className="Box-row d-flex flex-items-center flex-wrap"
      style={{ gap: 8 }}
    >
      <span className="text-bold text-break">{e.email}</span>
      {e.verified ? (
        <span className="Label Label--success">Verified</span>
      ) : (
        <span
          className="Label Label--attention"
          title={
            expired
              ? 'The link expired; anyone may now claim this address. Resend to keep it.'
              : 'Open the link we emailed to verify'
          }
        >
          Unverified{expired ? ' · link expired' : ''}
        </span>
      )}
      {editing ? (
        <form
          className="d-flex flex-items-center"
          style={{ gap: 4 }}
          onSubmit={(ev) => {
            ev.preventDefault();
            save.mutate();
          }}
        >
          <input
            className="form-control input-sm"
            maxLength={40}
            placeholder="Label"
            aria-label="Label"
            value={label}
            autoFocus
            onChange={(ev) => setLabel(ev.target.value)}
          />
          <button className="btn btn-sm" disabled={save.isPending}>
            Save
          </button>
          <button
            type="button"
            className="btn-link f6"
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn-link f6 color-fg-muted"
          onClick={() => {
            setLabel(e.label ?? '');
            setEditing(true);
          }}
        >
          {e.label ? <span className="Label">{e.label}</span> : 'Add label'}
        </button>
      )}
      <span className="flex-1" />
      {!e.verified && (
        <button className="btn btn-sm" onClick={onResend} disabled={resending}>
          Resend
        </button>
      )}
      <button className="btn btn-sm btn-danger" onClick={onRemove}>
        Delete
      </button>
    </div>
  );
}

/** `/settings/emails/verify?token=…`, the link in the verification email. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.verifyEmail(token),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.emails }),
  });
  // Post the token once (StrictMode mounts effects twice in development).
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !token) return;
    sent.current = true;
    verify.mutate();
  }, [token, verify]);
  return (
    <>
      <Header context={<span className="text-bold px-2">Settings</span>} />
      <div className="container-md px-3 py-6">
        <div className="Box p-4">
          {!token ? (
            <p>This verification link is incomplete.</p>
          ) : verify.isSuccess ? (
            <p>
              <strong>{verify.data.email}</strong> is verified. Commits authored
              with it are now linked to your profile.
            </p>
          ) : verify.isError ? (
            <p className="color-fg-danger">{errorMessage(verify.error)}</p>
          ) : (
            <Spinner />
          )}
          <Link to="/settings/emails" className="btn btn-sm mt-2">
            Back to email settings
          </Link>
        </div>
      </div>
    </>
  );
}
