import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyIcon } from '@primer/octicons-react';
import { api, qk, type Token } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { PendingButton } from '@/components/ui/PendingButton';
import { CopyButton } from '@/components/CopyButton';
import { InlineConfirm } from '@/components/InlineConfirm';
import { LoadError } from '@/components/Notice';
import { RowsSkeleton, SettingsFrame } from '@/components/SetFrame';

/** "Expires Nov 4, 2026", "Expired" or "No expiration". */
function expiryText(t: Token): string {
  if (!t.expiresAt) return 'No expiration';
  const at = new Date(t.expiresAt);
  return at < new Date() ? 'Expired' : `Expires ${at.toLocaleDateString()}`;
}

function TokenRow({ token }: { token: Token }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteToken(token.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tokens }),
  });
  return (
    <li>
      <KeyIcon className="ic" />
      <div className="grow">
        <b>{token.name}</b>
        <span className="muted small">
          {token.lastUsedAt
            ? `Last used ${timeAgo(token.lastUsedAt)}`
            : 'Never used'}
          {' · '}
          {expiryText(token)}
        </span>
      </div>
      <div className="ctl">
        <InlineConfirm
          label="Delete"
          confirmLabel="Delete token"
          pendingLabel="Deleting…"
          accessibleName={`Delete token ${token.name}`}
          pending={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : null}
          onConfirm={() => remove.mutate()}
        />
      </div>
    </li>
  );
}

/** Settings → Access tokens: generate a personal access token and delete the ones you no longer need. */
export default function SettingsTokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: qk.tokens, queryFn: api.tokens });
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createToken({
        name: name.trim(),
        expiresInDays: days === 'never' ? null : Number(days),
      }),
    onSuccess: (r) => {
      setCreated(r.plaintext);
      setName('');
      return qc.invalidateQueries({ queryKey: qk.tokens });
    },
  });

  return (
    <>
      <PageHead
        icon="key"
        crumbs={[
          { label: 'Settings', to: '/settings/tokens' },
          { label: 'Personal access tokens' },
        ]}
        title="Personal access tokens"
        lede="A token is a password for git over HTTPS and for Git LFS. Use it when you clone or push."
      />
      <SettingsFrame>
        <section className="panel" aria-label="Your tokens">
          <div className="pad">
            <h2>Your tokens</h2>
            <p className="small muted">
              Tokens you have generated. A deleted token stops working at once.
            </p>
          </div>
          {tokens.isPending ? (
            <div className="pad">
              <RowsSkeleton rows={2} />
            </div>
          ) : tokens.isError ? (
            <div className="pad">
              <LoadError
                what="your tokens"
                error={tokens.error}
                onRetry={() => tokens.refetch()}
              />
            </div>
          ) : tokens.data.length === 0 ? (
            <EmptyState
              picture={<KeyIcon size={20} />}
              title="You have no personal access tokens."
              body="Generate one below to use git over HTTPS."
            />
          ) : (
            <ul className="rowlist">
              {tokens.data.map((t) => (
                <TokenRow key={t.id} token={t} />
              ))}
            </ul>
          )}

          {created && (
            <div className="newtoken" role="status">
              <p>
                <b>Copy your new token now.</b> You won&apos;t be able to see it
                again.
              </p>
              <div className="copyrow">
                <input
                  className="form-control"
                  readOnly
                  value={created}
                  aria-label="Your new token"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <CopyButton
                  text={created}
                  className="btn small"
                  label="Copy the token"
                />
              </div>
            </div>
          )}

          <form
            className="formpad"
            onSubmit={(e) => {
              e.preventDefault();
              setCreated(null);
              create.mutate();
            }}
          >
            <h3 className="formtitle">Generate a new token</h3>
            <div className="frow">
              <div className="fld grow2">
                <label htmlFor="tok-name">Note</label>
                <input
                  id="tok-name"
                  className="form-control"
                  required
                  placeholder="What is this token for?"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="fld">
                <label htmlFor="tok-exp">Expiration</label>
                <select
                  id="tok-exp"
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
              <PendingButton
                type="submit"
                className="primary"
                pending={create.isPending}
                pendingLabel="Generating…"
                error={create.isError ? errorMessage(create.error) : null}
              >
                Generate token
              </PendingButton>
            </div>
          </form>
        </section>
      </SettingsFrame>
    </>
  );
}
