import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  EyeIcon,
  PencilIcon,
  PersonIcon,
  PlugIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { apiFetch } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { Avatar } from '@/components/Avatar';
import { Notice } from '@/components/Notice';
import { PendingButton } from '@/components/ui/PendingButton';
import { RowsSkeleton } from '@/components/SetFrame';
import { useAppName } from '@/lib/appName';
import { AuthShell } from './AuthShell';

type PublicClient = {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
};

/** The host of a client's home page, or null when it is not a URL. */
function hostOf(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

/** OAuth consent: posts the decision with the signed query and follows the returned redirect. */
export default function OAuthConsent() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('client_id') ?? '';
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
  const user = useCurrentUser();
  const appName = useAppName();
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useQuery({
    queryKey: ['oauth-client', clientId],
    queryFn: () =>
      apiFetch<PublicClient>(
        `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`
      ),
    enabled: Boolean(clientId),
    retry: false,
  });
  const tools = useQuery({ queryKey: qk.mcp, queryFn: api.mcp });

  if (!params.has('sig') || !clientId)
    return (
      <AuthShell title="Authorization link" docTitle="Authorize">
        <Notice tone="bad">
          This authorization link is incomplete or has expired. Start the
          connection again from your app.
        </Notice>
      </AuthShell>
    );

  const name = client.data?.client_name || 'An application';

  async function decide(accept: boolean) {
    setBusy(accept ? 'allow' : 'deny');
    setError(null);
    try {
      const res = await fetch('/api/auth/oauth2/consent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accept,
          oauth_query: window.location.search.slice(1),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        message?: string;
        error_description?: string;
      };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError(
        data.error_description ||
          data.message ||
          'Something went wrong. Start the connection again from your app.'
      );
    } catch {
      setError('Network error. Try again.');
    }
    setBusy(null);
  }

  const readOnly = tools.data?.tools.filter((t) => t.annotations.readOnlyHint);
  const writes = tools.data?.tools.filter((t) => !t.annotations.readOnlyHint);

  return (
    <AuthShell
      title={
        <>
          <b>{name}</b> wants to access your {appName} account
        </>
      }
      docTitle="Authorize"
      hideBrand
      wide
    >
      <div className="consent-marks" aria-hidden="true">
        {client.data?.logo_uri ? (
          <img
            src={client.data.logo_uri}
            alt=""
            width={44}
            height={44}
            className="consent-logo"
          />
        ) : (
          <span className="consent-logo plug">
            <PlugIcon size={22} />
          </span>
        )}
        <SyncIcon className="muted" />
        <img src="/logo.png" alt="" width={44} height={44} />
      </div>
      {client.isLoading ? (
        <RowsSkeleton rows={3} />
      ) : client.isError ? (
        <Notice tone="bad">
          This app isn&apos;t registered with {appName}. Start the connection
          again from your app.
        </Notice>
      ) : (
        <ul className="rowlist perms">
          {user && (
            <li>
              <Avatar user={user as { username: string }} size={32} />
              <div className="grow">
                <span className="small">
                  Signed in as <b>{user.username}</b>. {name} will act as you.
                </span>
              </div>
            </li>
          )}
          <li className="top">
            <EyeIcon className="ic" />
            <div className="grow">
              <b>Read your repositories</b>
              <span className="small muted">
                {readOnly?.map((t) => t.title).join(', ') ||
                  'See the repositories you can see'}
                . Includes private repositories you have access to.
              </span>
            </div>
          </li>
          <li className="top">
            <PencilIcon className="ic" />
            <div className="grow">
              <b>Make changes</b>
              <span className="small muted">
                {writes?.map((t) => t.title).join(', ') ||
                  'Create repositories'}{' '}
                as you.
              </span>
            </div>
          </li>
          {(scopes.includes('profile') || scopes.includes('email')) && (
            <li className="top">
              <PersonIcon className="ic" />
              <div className="grow">
                <b>Know who you are</b>
                <span className="small muted">
                  Your name, username
                  {scopes.includes('email') ? ', and email address' : ''}.
                </span>
              </div>
            </li>
          )}
          {scopes.includes('offline_access') && (
            <li className="small muted">
              Stays connected until you disconnect it in Settings → MCP server.
            </li>
          )}
        </ul>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="consent-actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => decide(false)}
        >
          {busy === 'deny' ? 'Cancelling…' : 'Cancel'}
        </button>
        <PendingButton
          className="primary"
          pending={busy === 'allow'}
          pendingLabel="Authorizing…"
          disabled={busy !== null || client.isError || client.isLoading}
          onClick={() => decide(true)}
        >
          Authorize {name}
        </PendingButton>
      </div>
      {hostOf(client.data?.client_uri) && (
        <p className="auth-foot plain">
          From {hostOf(client.data?.client_uri)}
        </p>
      )}
    </AuthShell>
  );
}
