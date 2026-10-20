import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Pull, type RepoDetail, type VersionBump } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { BUMPS, bumpLabel, parseBump } from '@/lib/versionBump';

/**
 * The pull request's version bump and, once a release ships it, "Released in vX.Y.Z". The author and anyone with
 * push access change the bump until it is merged; after that it is what the next release counts.
 */
export function VersionPanel({
  repo,
  pr,
  onSaved,
}: {
  repo: RepoDetail;
  pr: Pull;
  onSaved: () => Promise<unknown>;
}) {
  const me = useCurrentUser();
  const base = `/${repo.fullName}`;
  const merged = pr.state === 'merged';
  const canEdit =
    !merged && (repo.permissions.write || pr.author.id === me?.id);
  // The choice being saved, shown until the pull request reloads with it.
  const [saving, setSaving] = useState<VersionBump | null | undefined>();
  const [error, setError] = useState<string | null>(null);

  const change = async (next: VersionBump | null) => {
    setSaving(next);
    setError(null);
    try {
      await api.updatePull(repo.owner.username, repo.name, pr.number, {
        versionBump: next,
      });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(undefined);
    }
  };

  const shown = saving !== undefined ? saving : pr.versionBump;
  return (
    <section className="panel pad" aria-labelledby="pr-version-title">
      <h2 id="pr-version-title">Release</h2>
      {canEdit ? (
        <div className="fld">
          <label htmlFor="pr-version-bump">Version bump</label>
          <select
            id="pr-version-bump"
            className="form-select"
            value={shown ?? ''}
            disabled={saving !== undefined}
            aria-busy={saving !== undefined || undefined}
            onChange={(e) => void change(parseBump(e.target.value))}
          >
            <option value="">None (counts as patch)</option>
            {BUMPS.map((b) => (
              <option key={b} value={b}>
                {b[0].toUpperCase() + b.slice(1)}
              </option>
            ))}
          </select>
          {error && (
            <p className="rel-error small" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="small">
          Version bump: <strong>{bumpLabel(pr.versionBump)}</strong>
        </p>
      )}
      {merged && (
        <p className="small">
          {pr.releasedIn ? (
            <>
              Released in{' '}
              <Link
                to={`${base}/releases/${encodeURIComponent(pr.releasedIn)}`}
              >
                {pr.releasedIn}
              </Link>
            </>
          ) : (
            <span className="muted">
              Not released yet.{' '}
              <Link to={`${base}/releases`}>Unreleased changes</Link>
            </span>
          )}
        </p>
      )}
    </section>
  );
}
