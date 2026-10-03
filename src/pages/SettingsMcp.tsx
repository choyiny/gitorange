import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EyeIcon,
  PencilIcon,
  PlugIcon,
  ShieldCheckIcon,
} from '@primer/octicons-react';
import { api, qk, type McpTool } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { CopyButton } from '@/components/CopyButton';
import { SettingsNav } from '@/components/SettingsNav';
import { Spinner } from '@/components/Spinner';
import { useAppName } from '@/lib/appName';

type Client = 'claude-code' | 'claude' | 'cursor' | 'codex' | 'other';
const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude', label: 'Claude.ai & Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other clients' },
];

function Snippet({ text, label }: { text: string; label?: string }) {
  return (
    <div className="Box mb-3">
      <div className="Box-header d-flex flex-items-center flex-justify-between py-1 px-2">
        <span className="f6 color-fg-muted text-mono">
          {label ?? 'Terminal'}
        </span>
        <CopyButton text={text} className="btn btn-sm btn-invisible" />
      </div>
      <pre className="p-3 f6 text-mono m-0" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </pre>
    </div>
  );
}

function SetupSteps({
  client,
  url,
  serverName,
  appName,
}: {
  client: Client;
  url: string;
  serverName: string;
  appName: string;
}) {
  if (client === 'claude-code')
    return (
      <>
        <p className="mb-2">Add the server from your terminal:</p>
        <Snippet
          text={`claude mcp add --transport http ${serverName} ${url}`}
        />
        <p className="mb-0">
          Then start Claude Code, run <code>/mcp</code>, choose{' '}
          <strong>{serverName}</strong>, and select{' '}
          <strong>Authenticate</strong>. Your browser opens {appName}: sign in
          and allow access.
        </p>
      </>
    );
  if (client === 'claude')
    return (
      <ol className="pl-3 mb-0">
        <li className="mb-2">
          Open{' '}
          <a
            href="https://claude.ai/customize/connectors?modal=add-custom-connector"
            target="_blank"
            rel="noreferrer"
          >
            Settings → Connectors → Add custom connector
          </a>{' '}
          (in Claude.ai or the Claude desktop app).
        </li>
        <li className="mb-2">
          Name it <strong>{appName}</strong> and paste the server URL{' '}
          <code>{url}</code>.
        </li>
        <li>
          Select <strong>Connect</strong>, sign in to {appName}, and allow
          access. The connector then works in Claude on the web, desktop, and
          mobile.
        </li>
      </ol>
    );
  if (client === 'cursor') {
    const config = btoa(JSON.stringify({ url }));
    return (
      <>
        <p className="mb-2">
          <a
            className="btn btn-sm btn-primary"
            href={`cursor://anysphere.cursor-deeplink/mcp/install?name=${serverName}&config=${encodeURIComponent(config)}`}
          >
            Add to Cursor
          </a>
        </p>
        <p className="mb-2">
          Or add it to <code>~/.cursor/mcp.json</code> (or a project&apos;s{' '}
          <code>.cursor/mcp.json</code>):
        </p>
        <Snippet
          label="mcp.json"
          text={JSON.stringify(
            { mcpServers: { [serverName]: { url } } },
            null,
            2
          )}
        />
        <p className="mb-0">
          Cursor shows <strong>Needs login</strong> next to the server in
          Settings → MCP; select it to sign in to {appName}.
        </p>
      </>
    );
  }
  if (client === 'codex')
    return (
      <>
        <p className="mb-2">Add the server from your terminal, then sign in:</p>
        <Snippet
          text={`codex mcp add ${serverName} --url ${url}\ncodex mcp login ${serverName}`}
        />
        <p className="mb-0">
          Or add it to <code>~/.codex/config.toml</code> under{' '}
          <code>[mcp_servers.{serverName}]</code> with{' '}
          <code>url = &quot;{url}&quot;</code>.
        </p>
      </>
    );
  return (
    <p className="mb-0">
      Any MCP client that supports remote servers works. Add a{' '}
      <strong>Streamable HTTP</strong> server with the URL <code>{url}</code>.
      The client discovers {appName}&apos;s sign-in automatically (OAuth 2.1
      with PKCE and dynamic client registration), so there&apos;s no token to
      copy: you sign in and approve access in your browser.
    </p>
  );
}

function ToolRow({ tool }: { tool: McpTool }) {
  const params = Object.entries(tool.inputSchema.properties ?? {});
  const required = new Set(tool.inputSchema.required ?? []);
  return (
    <div className="Box-row">
      <div className="d-flex flex-items-center flex-wrap" style={{ gap: 8 }}>
        <span className="text-bold">{tool.title}</span>
        <code className="f6 color-fg-muted">{tool.name}</code>
        {tool.annotations.readOnlyHint ? (
          <span
            className="Label d-inline-flex flex-items-center"
            style={{ gap: 4 }}
          >
            <EyeIcon size={12} /> Read-only
          </span>
        ) : (
          <span
            className="Label Label--attention d-inline-flex flex-items-center"
            style={{ gap: 4 }}
          >
            <PencilIcon size={12} /> Makes changes
          </span>
        )}
      </div>
      <p className="f6 color-fg-muted mt-1 mb-0">{tool.description}</p>
      {params.length > 0 && (
        <ul className="f6 mt-2 mb-0 pl-3 color-fg-muted">
          {params.map(([name, p]) => (
            <li key={name}>
              <code>{name}</code>
              {required.has(name) ? ' (required)' : ''}
              {p.enum ? ` — one of ${p.enum.join(', ')}` : ''}
              {p.description ? `: ${p.description}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SettingsMcp() {
  const qc = useQueryClient();
  const appName = useAppName();
  const info = useQuery({ queryKey: qk.mcp, queryFn: api.mcp });
  const connections = useQuery({
    queryKey: qk.mcpConnections,
    queryFn: api.mcpConnections,
  });
  const [client, setClient] = useState<Client>('claude-code');
  const [error, setError] = useState<string | null>(null);
  const disconnect = useMutation({
    mutationFn: (clientId: string) => api.disconnectMcp(clientId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mcpConnections }),
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <>
      <Header context={<span className="text-bold px-2">Settings</span>} />
      <div className="container-lg px-3 py-4 d-flex" style={{ gap: 24 }}>
        <SettingsNav />
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="Subhead">
            <h2 className="Subhead-heading">MCP server</h2>
            <div className="Subhead-description">
              Connect Claude, Cursor, and other AI tools to {appName} through
              the Model Context Protocol. They act as you, so they see the
              repositories you can see, and they can create repositories for
              you.
            </div>
          </div>
          {!info.data ? (
            <Spinner />
          ) : (
            <>
              <label className="d-block text-bold f6 mb-1">Server URL</label>
              <div className="input-group mb-4" style={{ maxWidth: 560 }}>
                <input
                  className="form-control input-monospace"
                  readOnly
                  value={info.data.serverUrl}
                  aria-label="MCP server URL"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span className="input-group-button">
                  <CopyButton text={info.data.serverUrl} className="btn" />
                </span>
              </div>

              <h3 className="f4 mb-2">Set it up</h3>
              <div className="Box mb-4">
                <div className="Box-header p-0 border-bottom-0">
                  <nav
                    className="tabnav-tabs px-2 pt-2"
                    aria-label="MCP clients"
                  >
                    {CLIENTS.map((c) => (
                      <button
                        key={c.id}
                        className="tabnav-tab"
                        aria-selected={client === c.id}
                        aria-current={client === c.id ? 'page' : undefined}
                        onClick={() => setClient(c.id)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </nav>
                </div>
                <div className="Box-body border-top">
                  <SetupSteps
                    client={client}
                    url={info.data.serverUrl}
                    serverName={info.data.serverName}
                    appName={appName}
                  />
                </div>
                <div className="Box-footer f6 color-fg-muted">
                  To check it works, ask:{' '}
                  <em>
                    &ldquo;Which repositories do I have on {appName}? Use the{' '}
                    {info.data.serverName} MCP server.&rdquo;
                  </em>{' '}
                  Naming the server makes the AI call it instead of guessing.
                </div>
              </div>

              <h3 className="f4 mb-2">Tools</h3>
              <div className="Box mb-4">
                {info.data.tools.map((t) => (
                  <ToolRow key={t.name} tool={t} />
                ))}
              </div>
            </>
          )}

          <h3 className="f4 mb-2">Connected apps</h3>
          {error && <div className="flash flash-error mb-3">{error}</div>}
          <div className="Box">
            {!connections.data ? (
              <Spinner />
            ) : connections.data.length === 0 ? (
              <div className="Box-row color-fg-muted f6">
                No apps are connected yet. Apps appear here after you allow them
                access.
              </div>
            ) : (
              connections.data.map((c) => (
                <div
                  key={c.clientId}
                  className="Box-row d-flex flex-items-center"
                  style={{ gap: 12 }}
                >
                  <PlugIcon className="color-fg-muted" />
                  <div className="flex-1">
                    <div className="text-bold">{c.name}</div>
                    <div className="f6 color-fg-muted">
                      {c.connectedAt
                        ? `Connected ${timeAgo(c.connectedAt)}`
                        : 'Connected'}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate(c.clientId)}
                  >
                    Disconnect
                  </button>
                </div>
              ))
            )}
          </div>
          <p
            className="f6 color-fg-muted mt-2 d-flex flex-items-center"
            style={{ gap: 4 }}
          >
            <ShieldCheckIcon size={14} /> Disconnecting stops an app
            immediately; it has to ask for your approval again to reconnect.
          </p>
        </div>
      </div>
    </>
  );
}
