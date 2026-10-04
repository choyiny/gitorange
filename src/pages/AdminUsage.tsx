import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertIcon,
  CreditCardIcon,
  GraphIcon,
  InfoIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { api, qk, type UsageLine, type UsageReport } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { AdminNav } from '@/components/AdminNav';
import { Spinner } from '@/components/Spinner';

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Dollars, with more precision for small amounts. */
export function usd(n: number) {
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const qty = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 3 : 0 });

const SOURCE_LABEL: Record<UsageLine['source'], string> = {
  cloudflare: 'Cloudflare analytics',
  gitorange: 'Recorded by GitOrange',
  estimate: 'Estimate',
};

function Card({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="Box p-3">
      <div className="f6 color-fg-muted">{label}</div>
      <div className="f1 text-bold lh-condensed mt-1">{value}</div>
      <div className="f6 color-fg-muted">{detail}</div>
    </div>
  );
}

/** Estimated GitOrange cost per day, one bar per day (hover a bar for its value). */
function DailyChart({ report }: { report: UsageReport }) {
  const byDay = new Map(
    report.daily.map((d) => [
      d.date,
      Object.values(d.costs).reduce((n, c) => n + c, 0),
    ])
  );
  const days: string[] = [];
  for (let i = 0; i < report.daysInMonth; i++) {
    const d = new Date(`${report.from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const max = Math.max(0, ...byDay.values());
  const W = 720;
  const H = 140;
  const gap = 2;
  const bw = W / days.length - gap;
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H + 18}`}
        width="100%"
        role="img"
        aria-label="Estimated cost per day"
      >
        <line
          x1={0}
          x2={W}
          y1={H}
          y2={H}
          stroke="var(--borderColor-muted, #d1d9e0)"
        />
        {days.map((d, i) => {
          const v = byDay.get(d) ?? 0;
          const h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * (H - 4)) : 0;
          const x = i * (bw + gap);
          return (
            <g key={d}>
              <rect x={x} y={0} width={bw + gap} height={H} fill="transparent">
                <title>{`${d}: ${usd(v)}`}</title>
              </rect>
              {h > 0 && (
                <rect
                  x={x}
                  y={H - h}
                  width={bw}
                  height={h}
                  rx={Math.min(4, bw / 2)}
                  fill="var(--fgColor-accent, #0969da)"
                  pointerEvents="none"
                />
              )}
              {(i === 0 || (i + 1) % 7 === 0) && (
                <text
                  x={x + bw / 2}
                  y={H + 14}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--fgColor-muted, #59636e)"
                >
                  {Number(d.slice(8))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="f6 color-fg-muted">
        Highest day: {usd(max)}. Days without a bar have no recorded cost yet.
      </figcaption>
    </figure>
  );
}

function StatusLabel({ line }: { line: UsageLine }) {
  if (line.status === 'measured')
    return (
      <span className="Label Label--secondary">
        {SOURCE_LABEL[line.source]}
      </span>
    );
  return (
    <span className="Label Label--attention">
      {line.status === 'not-configured' ? 'Not configured' : 'Unavailable'}
    </span>
  );
}

function LinesTable({ lines }: { lines: UsageLine[] }) {
  const products = [...new Set(lines.map((l) => l.productLabel))];
  return (
    <div className="Box mb-4" style={{ overflowX: 'auto' }}>
      <table className="width-full f6" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr className="color-bg-subtle text-left">
            <th className="p-2">Metric</th>
            <th className="p-2 text-right">GitOrange usage</th>
            <th className="p-2">Included (whole account)</th>
            <th className="p-2 text-right">List price</th>
            <th className="p-2 text-right">With allowance</th>
            <th className="p-2 text-right">Projected</th>
          </tr>
        </thead>
        {products.map((p) => (
          <tbody key={p}>
            <tr className="border-top">
              <th colSpan={6} className="p-2 text-left">
                {p}
              </th>
            </tr>
            {lines
              .filter((l) => l.productLabel === p)
              .map((l) => (
                <tr key={l.metric} className="border-top">
                  <td className="p-2" style={{ minWidth: 220 }}>
                    <div>{l.label}</div>
                    <div className="mt-1">
                      <StatusLabel line={l} />
                    </div>
                    {l.reason && (
                      <div className="color-fg-attention mt-1">{l.reason}</div>
                    )}
                    {l.note && (
                      <div className="color-fg-muted mt-1">{l.note}</div>
                    )}
                    {l.billedFrom && (
                      <div className="color-fg-muted mt-1">
                        Cloudflare bills this from {l.billedFrom}.
                      </div>
                    )}
                    {l.resources.length > 1 && (
                      <div className="color-fg-muted mt-1">
                        {l.resources
                          .map((r) => `${r.resource}: ${qty(r.quantity)}`)
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="p-2 text-right text-mono">
                    {l.status === 'measured'
                      ? `${qty(l.quantity)} ${l.unit}`
                      : '—'}
                  </td>
                  <td className="p-2 color-fg-muted">{l.includedLabel}</td>
                  <td className="p-2 text-right text-mono">
                    {usd(l.listCost)}
                  </td>
                  <td className="p-2 text-right text-mono">
                    {usd(l.dedicatedCost)}
                  </td>
                  <td className="p-2 text-right text-mono">
                    {usd(l.projectedListCost)}
                  </td>
                </tr>
              ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { key: string; detail: string; cost: number }[];
  empty: string;
}) {
  return (
    <div className="Box mb-4">
      <div className="Box-header py-2">
        <h3 className="Box-title f5">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="Box-row color-fg-muted f6">{empty}</div>
      ) : (
        rows.map((r) => (
          <div
            key={r.key}
            className="Box-row py-2 d-flex flex-items-baseline f6"
            style={{ gap: 12 }}
          >
            <div
              className="flex-1 min-width-0"
              style={{ overflowWrap: 'anywhere' }}
            >
              {r.key}
              <div className="color-fg-muted">{r.detail}</div>
            </div>
            <div className="text-mono">{usd(r.cost)}</div>
          </div>
        ))
      )}
    </div>
  );
}

export default function AdminUsage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const report = useQuery({
    queryKey: qk.usage(month),
    queryFn: () => api.usage(month),
    placeholderData: keepPreviousData,
  });
  const [syncMsg, setSyncMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const sync = useMutation({
    mutationFn: api.syncUsage,
    onSuccess: (r) => {
      const failed = Object.values(r.errors).some((e) =>
        Object.keys(e).some((k) => !k.endsWith(':unconfigured'))
      );
      setSyncMsg({
        kind: 'success',
        text: failed
          ? `Synced ${r.days.length} days; some metrics were unavailable (see below).`
          : `Synced ${r.days.length} days.`,
      });
      qc.invalidateQueries({ queryKey: ['usage'] });
    },
    onError: (e) => setSyncMsg({ kind: 'error', text: errorMessage(e) }),
  });
  const r = report.data;

  return (
    <>
      <Header context={<span className="text-bold px-2">Site admin</span>} />
      <div className="container-lg px-3 py-4">
        <AdminNav />
        <div className="Subhead">
          <h2
            className="Subhead-heading d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <CreditCardIcon size={24} /> Usage &amp; cost
          </h2>
          <div
            className="Subhead-actions d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <input
              type="month"
              className="form-control input-sm"
              aria-label="Month"
              value={month}
              max={thisMonth()}
              onChange={(e) =>
                e.target.value && setParams({ month: e.target.value })
              }
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={sync.isPending || (r && !r.analyticsConfigured)}
              onClick={() => {
                setSyncMsg(null);
                sync.mutate();
              }}
            >
              <SyncIcon /> {sync.isPending ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          <div className="Subhead-description">
            What this GitOrange deployment uses on Cloudflare, and what it would
            cost. Estimates from Cloudflare analytics (filtered to this
            deployment’s own Worker, Durable Objects, Workflows, D1 database, R2
            buckets, and Artifacts namespace) and from GitOrange’s own records.
            Not an invoice: Cloudflare’s Billing → Billable Usage page has the
            exact account total.
            {r?.lastSync?.completedAt && (
              <>
                {' '}
                Cloudflare analytics last synced{' '}
                {timeAgo(r.lastSync.completedAt)}.
              </>
            )}
          </div>
        </div>
        {syncMsg && (
          <div className={`flash flash-${syncMsg.kind} mb-3`}>
            {syncMsg.text}
          </div>
        )}
        {report.isPending ? (
          <Spinner />
        ) : report.error ? (
          <div className="flash flash-error">{errorMessage(report.error)}</div>
        ) : r ? (
          <>
            {!r.analyticsConfigured && (
              <div className="flash flash-warn mb-3">
                <AlertIcon /> Cloudflare analytics are not set up, so only what
                GitOrange records itself (Actions runners, Workers AI calls,
                emails) is shown. Add the <code>CF_ANALYTICS_TOKEN</code>{' '}
                secret: an account API token with{' '}
                <strong>Account Analytics: Read</strong>.
              </div>
            )}
            <div
              className="mb-4"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 16,
              }}
            >
              <Card
                label="GitOrange usage at list price"
                value={usd(r.totals.listCost)}
                detail="Every unit priced, no allowances"
              />
              <Card
                label="If GitOrange had the allowances to itself"
                value={usd(r.totals.dedicatedCost)}
                detail="Usage above the included amounts"
              />
              <Card
                label="Projected for the month"
                value={usd(r.totals.projectedListCost)}
                detail={`${usd(r.totals.projectedDedicatedCost)} with allowances`}
              />
              <Card
                label="Workers Paid plan fee"
                value={usd(r.prices.planFee)}
                detail="Per account, not counted above"
              />
            </div>
            <div className="flash mb-4 f6">
              <InfoIcon /> Included allowances and the plan fee belong to the
              whole Cloudflare account. If anything else runs on it, the
              allowances are shared and the real bill for GitOrange’s usage is
              somewhere between the two figures above.
            </div>

            <h3 className="f4 mb-2 d-flex flex-items-center" style={{ gap: 6 }}>
              <GraphIcon /> Estimated cost per day
            </h3>
            <div className="Box p-3 mb-4">
              <DailyChart report={r} />
            </div>

            <h3 className="f4 mb-2">By product</h3>
            <LinesTable lines={r.lines} />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: 16,
              }}
            >
              <div>
                <h3 className="f4 mb-2">
                  Actions: {qty(r.actions.minutes)} runner minutes,{' '}
                  {usd(r.actions.cost)}
                </h3>
                {r.actions.running > 0 && (
                  <p className="f6 color-fg-muted">
                    {r.actions.running} runner(s) running now are counted up to
                    this moment.
                  </p>
                )}
                <Breakdown
                  title="By repository"
                  empty="No Actions jobs ran this month."
                  rows={r.actions.byRepository.map((x) => ({
                    key: x.repository,
                    detail: `${qty(x.minutes)} minutes`,
                    cost: x.cost,
                  }))}
                />
                <Breakdown
                  title="By runner size"
                  empty="No Actions jobs ran this month."
                  rows={r.actions.byInstance.map((x) => ({
                    key: x.instanceType,
                    detail: `${qty(x.minutes)} minutes`,
                    cost: x.cost,
                  }))}
                />
              </div>
              <div>
                <h3 className="f4 mb-2">
                  Workers AI: {qty(r.ai.requests)} calls, {usd(r.ai.cost)}
                </h3>
                {r.ai.unreportedRequests > 0 && (
                  <p className="f6 color-fg-muted">
                    {r.ai.unreportedRequests} call(s) reported no token counts
                    and are not priced.
                  </p>
                )}
                <Breakdown
                  title="By feature"
                  empty="No AI calls this month."
                  rows={r.ai.byFeature.map((x) => ({
                    key: x.key,
                    detail: `${qty(x.requests)} calls · ${qty(x.tokensIn)} in · ${qty(x.tokensOut)} out tokens`,
                    cost: x.cost,
                  }))}
                />
                <Breakdown
                  title="By repository"
                  empty="No AI calls this month."
                  rows={r.ai.byRepository.map((x) => ({
                    key: x.key,
                    detail: `${qty(x.requests)} calls`,
                    cost: x.cost,
                  }))}
                />
              </div>
            </div>

            {r.gateway && (
              <>
                <h3 className="f4 mb-2">
                  AI Gateway <code>{r.gateway.id}</code> (whole gateway)
                </h3>
                <div className="Box p-3 mb-4 f6">
                  {r.gateway.status === 'measured' ? (
                    <>
                      {qty(r.gateway.requests ?? 0)} requests
                      {r.gateway.estimatedCost !== null &&
                        `, ${usd(r.gateway.estimatedCost)} by the gateway’s own estimate`}
                      .
                    </>
                  ) : (
                    <span className="color-fg-attention">
                      {r.gateway.status === 'not-configured'
                        ? 'Not configured.'
                        : 'Unavailable.'}{' '}
                      {r.gateway.reason}
                    </span>
                  )}
                  <div className="color-fg-muted mt-1">
                    For the whole gateway, which other apps or a dev instance
                    may share; not added to GitOrange’s totals. GitOrange’s own
                    AI cost is the Workers AI section above.
                  </div>
                </div>
              </>
            )}

            <h3 className="f4 mb-2">Not measured</h3>
            <ul className="f6 color-fg-muted ml-4 mb-4">
              {r.notMeasured.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p className="f6 color-fg-muted">
              Workers Paid list prices, last checked {r.prices.checkedOn}:{' '}
              {r.prices.sources.map((s, i) => (
                <span key={s}>
                  {i > 0 && ', '}
                  <a href={s} target="_blank" rel="noreferrer">
                    {new URL(s).pathname.split('/').filter(Boolean)[0]}
                  </a>
                </span>
              ))}
              .
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}
