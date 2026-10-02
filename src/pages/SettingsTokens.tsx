import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { CopyButton } from '@/components/CopyButton';
import { Spinner } from '@/components/Spinner';
import { SettingsNav } from '@/components/SettingsNav';

export default function SettingsTokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: qk.tokens, queryFn: api.tokens });
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createToken({
        name,
        expiresInDays: days === 'never' ? null : Number(days),
      }),
    onSuccess: (r) => {
      setCreated(r.plaintext);
      setName('');
      qc.invalidateQueries({ queryKey: qk.tokens });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tokens }),
  });
  return (
    <>
      <Header context={<span className="text-bold px-2">Settings</span>} />
      <div className="container-lg px-3 py-4 d-flex" style={{ gap: 24 }}>
        <SettingsNav />
        <div className="flex-1">
          <div className="Subhead">
            <h2 className="Subhead-heading">Personal access tokens</h2>
            <div className="Subhead-description">
              Tokens you have generated that can be used to access git over
              HTTPS. Use a token as your password when you clone or push.
            </div>
          </div>
          {created && (
            <div className="flash flash-success mb-3">
              <p className="mb-2">
                Make sure to copy your personal access token now. You won't be
                able to see it again!
              </p>
              <div className="d-flex flex-items-center" style={{ gap: 8 }}>
                <code className="f5 text-mono">{created}</code>
                <CopyButton text={created} />
              </div>
            </div>
          )}
          {error && <div className="flash flash-error mb-3">{error}</div>}
          <form
            className="Box p-3 mb-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              create.mutate();
            }}
          >
            <h3 className="f4 mb-3">Generate new token</h3>
            <div
              className="d-flex flex-wrap flex-items-end"
              style={{ gap: 12 }}
            >
              <div className="flex-1">
                <label className="d-block f6 text-bold mb-1">Note</label>
                <input
                  className="form-control width-full"
                  required
                  placeholder="What's this token for?"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="d-block f6 text-bold mb-1">Expiration</label>
                <select
                  className="form-select"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                >
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="366">1 year</option>
                  <option value="never">No expiration</option>
                </select>
              </div>
              <button className="btn btn-primary" disabled={create.isPending}>
                Generate token
              </button>
            </div>
          </form>
          {tokens.isPending ? (
            <Spinner />
          ) : tokens.data!.length === 0 ? (
            <p className="color-fg-muted">
              You have no personal access tokens.
            </p>
          ) : (
            <div className="Box">
              {tokens.data!.map((t) => (
                <div
                  key={t.id}
                  className="Box-row d-flex flex-items-center"
                  style={{ gap: 12 }}
                >
                  <div className="flex-1">
                    <div className="text-bold">{t.name}</div>
                    <div className="f6 color-fg-muted">
                      {t.lastUsedAt
                        ? `Last used ${timeAgo(t.lastUsedAt)}`
                        : 'Never used'}{' '}
                      ·{' '}
                      {t.expiresAt
                        ? new Date(t.expiresAt) < new Date()
                          ? 'Expired'
                          : `Expires ${new Date(t.expiresAt).toLocaleDateString()}`
                        : 'No expiration'}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => remove.mutate(t.id)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
