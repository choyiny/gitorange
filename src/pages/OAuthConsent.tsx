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
import { Logo } from '@/components/Logo';
import { Spinner } from '@/components/Spinner';
import { useAppName } from '@/lib/appName';

type PublicClient = {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
};

/**
 * The OAuth consent page. better-auth's oauth-provider redirects here with a signed copy of the
 * authorization request; the decision is posted back with that same signed query, and the
 * response says where to send the browser (the app's callback, with a code or an error).
 */
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
      <div className="container-sm px-3 py-6">
        <div className="flash flash-error">
          This authorization link is incomplete or has expired. Start the
          connection again from your app.
        </div>
      </div>
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
    <div className="container-sm px-3 py-6" style={{ maxWidth: 480 }}>
      <div
        className="d-flex flex-items-center flex-justify-center mb-4"
        style={{ gap: 16 }}
      >
        {client.data?.logo_uri ? (
          <img
            src={client.data.logo_uri}
            alt=""
            width={48}
            height={48}
            className="rounded-2"
          />
        ) : (
          <span className="circle color-bg-subtle p-3 d-inline-flex">
            <PlugIcon size={24} />
          </span>
        )}
        <SyncIcon className="color-fg-muted" />
        <Logo size={48} />
      </div>
      <h1 className="f3 text-normal text-center mb-4">
        <strong>{name}</strong> wants to access your {appName} account
      </h1>
      {client.isLoading ? (
        <Spinner />
      ) : client.isError ? (
        <div className="flash flash-error mb-3">
          This app isn&apos;t registered with {appName}. Start the connection
          again from your app.
        </div>
      ) : (
        <div className="Box mb-3">
          {user && (
            <div
              className="Box-row d-flex flex-items-center"
              style={{ gap: 12 }}
            >
              <Avatar user={user as { username: string }} size={32} />
              <div className="f6">
                Signed in as <strong>{user.username}</strong>. {name} will act
                as you.
              </div>
            </div>
          )}
          <div className="Box-row d-flex" style={{ gap: 12 }}>
            <EyeIcon className="color-fg-muted mt-1" />
            <div>
              <div className="text-bold">Read your repositories</div>
              <div className="f6 color-fg-muted">
                {readOnly?.map((t) => t.title).join(', ') ||
                  'See the repositories you can see'}
                . Includes private repositories you have access to.
              </div>
            </div>
          </div>
          <div className="Box-row d-flex" style={{ gap: 12 }}>
            <PencilIcon className="color-fg-muted mt-1" />
            <div>
              <div className="text-bold">Make changes</div>
              <div className="f6 color-fg-muted">
                {writes?.map((t) => t.title).join(', ') ||
                  'Create repositories'}{' '}
                as you.
              </div>
            </div>
          </div>
          {(scopes.includes('profile') || scopes.includes('email')) && (
            <div className="Box-row d-flex" style={{ gap: 12 }}>
              <PersonIcon className="color-fg-muted mt-1" />
              <div>
                <div className="text-bold">Know who you are</div>
                <div className="f6 color-fg-muted">
                  Your name, username
                  {scopes.includes('email') ? ', and email address' : ''}.
                </div>
              </div>
            </div>
          )}
          {scopes.includes('offline_access') && (
            <div className="Box-row f6 color-fg-muted">
              Stays connected until you disconnect it in Settings → MCP server.
            </div>
          )}
        </div>
      )}
      {error && <div className="flash flash-error mb-3">{error}</div>}
      <div className="d-flex" style={{ gap: 8 }}>
        <button
          className="btn flex-1"
          disabled={busy !== null}
          onClick={() => decide(false)}
        >
          {busy === 'deny' ? 'Cancelling…' : 'Cancel'}
        </button>
        <button
          className="btn btn-primary flex-1"
          disabled={busy !== null || client.isError || client.isLoading}
          onClick={() => decide(true)}
        >
          {busy === 'allow' ? 'Authorizing…' : `Authorize ${name}`}
        </button>
      </div>
      {client.data?.client_uri && (
        <p className="f6 color-fg-muted text-center mt-3 mb-0">
          From {new URL(client.data.client_uri).host}
        </p>
      )}
    </div>
  );
}
