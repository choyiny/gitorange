import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GearIcon } from '@primer/octicons-react';
import { api, qk, type InstanceSetting } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Spinner } from './Spinner';

const GROUPS: InstanceSetting['group'][] = [
  'General',
  'AI models',
  'Reviews',
  'Actions',
];

function SettingRow({
  s,
  onSaved,
}: {
  s: InstanceSetting;
  onSaved: () => void;
}) {
  const retention = s.key === 'actions.retention_days';
  // Other number settings (e.g. actions.max_concurrent_jobs) save numbers, not text.
  const numeric = !retention && typeof s.default === 'number';
  const [text, setText] = useState('');
  const [forever, setForever] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow the server's value whenever it changes (after a save, a reset, or a live update).
  useEffect(() => {
    if (retention) {
      setForever(s.value === null);
      setText(s.value === null ? '' : String(s.value));
    } else setText(String(s.value ?? ''));
  }, [s.value, retention]);

  const current = retention
    ? forever
      ? null
      : Number(text)
    : numeric
      ? Number(text)
      : text.trim();
  const dirty = current !== s.value;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const defaultText =
    s.default === null
      ? 'keep forever'
      : retention
        ? `${s.default} days`
        : String(s.default);

  return (
    <form
      className="Box-row"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.saveSetting(s.key, current));
      }}
    >
      <label className="d-block text-bold mb-1" htmlFor={`setting-${s.key}`}>
        {s.label}
      </label>
      <p className="f6 color-fg-muted mb-2">{s.description}</p>
      <div className="d-flex flex-wrap flex-items-center" style={{ gap: 8 }}>
        {retention ? (
          <>
            <input
              id={`setting-${s.key}`}
              className="form-control"
              type="number"
              min={1}
              max={400}
              style={{ width: 100 }}
              value={text}
              disabled={forever}
              onChange={(e) => setText(e.target.value)}
              required={!forever}
            />
            <span className="color-fg-muted">days</span>
            <label
              className="d-inline-flex flex-items-center f6 ml-2"
              style={{ gap: 4 }}
            >
              <input
                type="checkbox"
                checked={forever}
                onChange={(e) => setForever(e.target.checked)}
              />
              Keep forever
            </label>
          </>
        ) : numeric ? (
          <input
            id={`setting-${s.key}`}
            className="form-control"
            type="number"
            min={s.min ?? 1}
            max={s.max}
            step={1}
            style={{ width: 140 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        ) : (
          <input
            id={`setting-${s.key}`}
            className="form-control flex-1"
            style={{ minWidth: 200 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        )}
        <button className="btn btn-sm" type="submit" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {s.overridden && (
          <button
            type="button"
            className="btn btn-sm btn-invisible"
            disabled={busy}
            onClick={() => void run(() => api.resetSetting(s.key))}
          >
            Reset to default
          </button>
        )}
      </div>
      <div className="f6 color-fg-muted mt-1">
        {s.overridden
          ? `Set here${s.updatedAt ? ` ${timeAgo(s.updatedAt)}` : ''}. Default: ${defaultText}.`
          : `Using the default (${defaultText}).`}
        {saved && !error && (
          <span className="color-fg-success ml-2">Saved.</span>
        )}
      </div>
      {error && <div className="flash flash-error mt-2 f6">{error}</div>}
    </form>
  );
}

/**
 * Instance settings in Site admin: values that used to need a wrangler var and a deploy. Each
 * shows its default (from the deploy's config, or built in) and can be reset to it.
 */
export function AdminSettings() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.adminSettings,
    queryFn: api.adminSettings,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.adminSettings });
    // The instance name shows in the header and page titles.
    void qc.invalidateQueries({ queryKey: qk.setup });
  };
  return (
    <>
      <div className="Subhead">
        <h2
          className="Subhead-heading d-flex flex-items-center"
          style={{ gap: 8 }}
        >
          <GearIcon size={24} /> Settings
        </h2>
        <div className="Subhead-description">
          Instance-wide settings. Defaults come from the deploy&apos;s
          configuration; anything set here takes effect right away, without a
          deploy.
        </div>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <div className="flash flash-error mb-5">{errorMessage(q.error)}</div>
      ) : (
        GROUPS.map((group) => (
          <div key={group} className="Box mb-4">
            <div className="Box-header">
              <h3 className="Box-title">{group}</h3>
            </div>
            {q.data.settings
              .filter((s) => s.group === group)
              .map((s) => (
                <SettingRow key={s.key} s={s} onSaved={refresh} />
              ))}
            {group === 'Actions' && (
              <div className="Box-row f6 color-fg-muted">
                {q.data.actions.runs} workflow run
                {q.data.actions.runs === 1 ? '' : 's'} stored
                {q.data.actions.oldestFinishedAt &&
                  `; the oldest finished ${timeAgo(q.data.actions.oldestFinishedAt)}`}
                .{' '}
                {q.data.actions.retention
                  ? `Cleanup last ran ${timeAgo(q.data.actions.retention.at)} and deleted ${q.data.actions.retention.deletedRuns} run${q.data.actions.retention.deletedRuns === 1 ? '' : 's'}${q.data.actions.retention.more ? ' (more remain; it continues tomorrow)' : ''}.`
                  : 'Cleanup runs once a day.'}
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}
