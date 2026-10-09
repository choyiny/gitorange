import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircleIcon, MailIcon } from '@primer/octicons-react';
import { api, qk, type AlternateEmail } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { PageHead } from '@/components/ui/PageHead';
import { Chip } from '@/components/ui/Chip';
import { PendingButton } from '@/components/ui/PendingButton';
import { InlineConfirm } from '@/components/InlineConfirm';
import { LoadError, Notice } from '@/components/Notice';
import { RowsSkeleton, SettingsFrame } from '@/components/SetFrame';

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
      return refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEmail(id),
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.resendEmailVerification(id),
    onSuccess: (r) => {
      setError(null);
      sentNotice(r.email.email, r.emailed);
      return refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const data = emails.data;

  return (
    <>
      <PageHead
        icon="mail"
        crumbs={[
          { label: 'Settings', to: '/settings/tokens' },
          { label: 'Emails' },
        ]}
        title="Emails"
        lede={
          <>
            Commits whose author or committer email is one of these are linked
            to your profile. Add the addresses you set as{' '}
            <code>user.email</code> in git. Other addresses must be verified
            before they count.
          </>
        }
      />
      <SettingsFrame>
        {data && !data.emailConfigured && (
          <Notice tone="warn">
            This instance cannot send email, so verification links can&apos;t be
            delivered and new addresses stay unverified. Ask a site admin to
            configure email sending.
          </Notice>
        )}
        {notice && <Notice tone="info">{notice}</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        <section className="panel" aria-label="Your email addresses">
          <div className="pad">
            <h2>Email addresses</h2>
          </div>
          {emails.isPending ? (
            <div className="pad">
              <RowsSkeleton rows={2} />
            </div>
          ) : emails.isError ? (
            <div className="pad">
              <LoadError
                what="your email addresses"
                error={emails.error}
                onRetry={() => emails.refetch()}
              />
            </div>
          ) : (
            <ul className="rowlist">
              <li>
                <MailIcon className="ic" />
                <div className="grow">
                  <b className="wrap">{data!.primary}</b>
                  <span className="muted small">Your account email.</span>
                </div>
                <div className="ctl">
                  <Chip tone="info">Primary</Chip>
                </div>
              </li>
              {data!.alternates.map((e) => (
                <EmailRow
                  key={e.id}
                  e={e}
                  onRemove={() => remove.mutate(e.id)}
                  removing={remove.isPending && remove.variables === e.id}
                  onResend={() => resend.mutate(e.id)}
                  resending={resend.isPending && resend.variables === e.id}
                />
              ))}
            </ul>
          )}
          <form
            className="formpad"
            onSubmit={(ev) => {
              ev.preventDefault();
              setNotice(null);
              add.mutate();
            }}
          >
            <h3 className="formtitle">Add an email address</h3>
            <div className="frow">
              <div className="fld grow2">
                <label htmlFor="email-address">Email address</label>
                <input
                  id="email-address"
                  type="email"
                  className="form-control"
                  required
                  maxLength={254}
                  placeholder="you@work.example"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                />
              </div>
              <div className="fld">
                <label htmlFor="email-label">
                  Label <span className="muted">(optional)</span>
                </label>
                <input
                  id="email-label"
                  className="form-control"
                  maxLength={40}
                  placeholder="Work, Personal…"
                  value={label}
                  onChange={(ev) => setLabel(ev.target.value)}
                />
              </div>
              <PendingButton
                type="submit"
                className="primary"
                pending={add.isPending}
                pendingLabel="Adding…"
              >
                Add
              </PendingButton>
            </div>
            <p className="small muted">
              We send a link to verify it. Open the link while you are signed
              in.
            </p>
          </form>
        </section>
      </SettingsFrame>
    </>
  );
}

function EmailRow({
  e,
  onRemove,
  removing,
  onResend,
  resending,
}: {
  e: AlternateEmail;
  onRemove: () => void;
  removing: boolean;
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
      return qc.invalidateQueries({ queryKey: qk.emails });
    },
  });
  const expired =
    !e.verified &&
    (!e.verificationExpiresAt ||
      new Date(e.verificationExpiresAt) < new Date());
  return (
    <li>
      <MailIcon className="ic" />
      <div className="grow">
        <b className="wrap">{e.email}</b>
        <div className="muted small">
          {editing ? (
            <form
              className="labelform"
              onSubmit={(ev) => {
                ev.preventDefault();
                save.mutate();
              }}
            >
              <input
                className="form-control input-sm"
                maxLength={40}
                placeholder="Label"
                aria-label={`Label for ${e.email}`}
                value={label}
                autoFocus
                onChange={(ev) => setLabel(ev.target.value)}
              />
              <PendingButton
                type="submit"
                className="small"
                pending={save.isPending}
                error={save.isError ? errorMessage(save.error) : null}
              >
                Save
              </PendingButton>
              <button
                type="button"
                className="btn small quiet"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setLabel(e.label ?? '');
                setEditing(true);
              }}
            >
              {e.label ? `Label: ${e.label}` : 'Add label'}
            </button>
          )}
        </div>
      </div>
      <div className="ctl">
        {e.verified ? (
          <Chip tone="good" icon={<CheckCircleIcon size={12} />}>
            Verified
          </Chip>
        ) : (
          <Chip
            tone="warn"
            title={
              expired
                ? 'The link expired; anyone may now claim this address. Resend to keep it.'
                : 'Open the link we emailed to verify'
            }
          >
            Unverified{expired ? ' · link expired' : ''}
          </Chip>
        )}
        {!e.verified && (
          <PendingButton
            className="small"
            pending={resending}
            pendingLabel="Sending…"
            onClick={onResend}
          >
            Resend
          </PendingButton>
        )}
        <InlineConfirm
          label="Delete"
          confirmLabel="Delete address"
          pendingLabel="Deleting…"
          accessibleName={`Delete ${e.email}`}
          pending={removing}
          onConfirm={onRemove}
        />
      </div>
    </li>
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
      <PageHead
        icon="mail"
        crumbs={[
          { label: 'Settings', to: '/settings/tokens' },
          { label: 'Emails', to: '/settings/emails' },
          { label: 'Verify email' },
        ]}
        title="Verify email"
      />
      <SettingsFrame>
        <section className="panel pad verify" aria-live="polite">
          {!token ? (
            <Notice tone="warn">This verification link is incomplete.</Notice>
          ) : verify.isSuccess ? (
            <Notice tone="ok">
              <b>{verify.data.email}</b> is verified. Commits authored with it
              are now linked to your profile.
            </Notice>
          ) : verify.isError ? (
            <Notice tone="bad">{errorMessage(verify.error)}</Notice>
          ) : (
            <RowsSkeleton rows={1} />
          )}
          <div className="actions">
            <Link to="/settings/emails" className="btn small">
              Back to email settings
            </Link>
          </div>
        </section>
      </SettingsFrame>
    </>
  );
}
