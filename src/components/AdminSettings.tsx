import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersIcon } from '@primer/octicons-react';
import { api, qk, type InstanceSetting } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Section } from '@/components/ui/Section';
import { PendingButton } from '@/components/ui/PendingButton';
import { LoadError, Notice } from '@/components/Notice';
import { RowsSkeleton } from '@/components/SetFrame';

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
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
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

  const run = async (kind: 'save' | 'reset', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const defaultText =
    s.default === null
      ? 'keep forever'
      : retention
        ? `${s.default} days`
        : String(s.default);

  return (
    <li className="setting">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run('save', () => api.saveSetting(s.key, current));
        }}
      >
        <label className="setting-label" htmlFor={`setting-${s.key}`}>
          {s.label}
        </label>
        <p className="small muted">{s.description}</p>
        <div className="setting-input">
          {retention ? (
            <>
              <input
                id={`setting-${s.key}`}
                className="form-control short"
                type="number"
                min={1}
                max={400}
                value={text}
                disabled={forever}
                onChange={(e) => setText(e.target.value)}
                required={!forever}
              />
              <span className="muted">days</span>
              <label className="check-inline small">
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
              className="form-control short"
              type="number"
              min={s.min ?? 1}
              max={s.max}
              step={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          ) : (
            <input
              id={`setting-${s.key}`}
              className="form-control wide"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          )}
          <PendingButton
            type="submit"
            className="small"
            pending={busy === 'save'}
            pendingLabel="Saving…"
            disabled={busy !== null || !dirty}
          >
            Save
          </PendingButton>
          {s.overridden && (
            <PendingButton
              className="small quiet"
              pending={busy === 'reset'}
              pendingLabel="Resetting…"
              disabled={busy !== null}
              onClick={() => void run('reset', () => api.resetSetting(s.key))}
            >
              Reset to default
            </PendingButton>
          )}
        </div>
        <p className="small muted">
          {s.overridden
            ? `Set here${s.updatedAt ? ` ${timeAgo(s.updatedAt)}` : ''}. Default: ${defaultText}.`
            : `Using the default (${defaultText}).`}
          {saved && !error && <span className="saved"> Saved.</span>}
        </p>
        {error && <Notice tone="bad">{error}</Notice>}
      </form>
    </li>
  );
}

/**
 * Instance settings in Site admin: values a site admin changes without a deploy. Each shows its
 * default (from the deploy's config, or built in) and can be reset to it.
 */
export function AdminSettings() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.adminSettings,
    queryFn: api.adminSettings,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.adminSettings });
    // The instance name shows in the rail and page titles.
    void qc.invalidateQueries({ queryKey: qk.setup });
  };
  return (
    <div id="settings">
      <Section
        title={
          <>
            <SlidersIcon size={16} /> Instance settings
          </>
        }
      >
        <p className="small muted">
          Instance-wide settings. Defaults come from the deploy&apos;s
          configuration; anything set here takes effect right away, without a
          deploy.
        </p>
        {q.isPending ? (
          <RowsSkeleton rows={4} />
        ) : q.isError ? (
          <LoadError
            what="the instance settings"
            error={q.error}
            onRetry={() => q.refetch()}
          />
        ) : (
          GROUPS.map((group) => (
            <div key={group} className="panel">
              <div className="pad">
                <h3 className="group-title">{group}</h3>
              </div>
              <ul className="rowlist">
                {q.data.settings
                  .filter((s) => s.group === group)
                  .map((s) => (
                    <SettingRow key={s.key} s={s} onSaved={refresh} />
                  ))}
                {group === 'Actions' && (
                  <li className="setting-foot small muted">
                    {q.data.actions.runs} workflow run
                    {q.data.actions.runs === 1 ? '' : 's'} stored
                    {q.data.actions.oldestFinishedAt &&
                      `; the oldest finished ${timeAgo(q.data.actions.oldestFinishedAt)}`}
                    .{' '}
                    {q.data.actions.retention
                      ? `Cleanup last ran ${timeAgo(q.data.actions.retention.at)} and deleted ${q.data.actions.retention.deletedRuns} run${q.data.actions.retention.deletedRuns === 1 ? '' : 's'}${q.data.actions.retention.more ? ' (more remain; it continues tomorrow)' : ''}.`
                      : 'Cleanup runs once a day.'}
                  </li>
                )}
              </ul>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
