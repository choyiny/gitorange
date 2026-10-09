import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { GraphIcon, SyncIcon } from '@primer/octicons-react';
import { api, qk, type UsageLine, type UsageReport } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { PageHead } from '@/components/ui/PageHead';
import { Chip } from '@/components/ui/Chip';
import { Section } from '@/components/ui/Section';
import { PendingButton } from '@/components/ui/PendingButton';
import { LoadError, Notice } from '@/components/Notice';
import { AdminFrame, RowsSkeleton } from '@/components/SetFrame';

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
    <div className="stat">
      <span>{label}</span>
      <b>{value}</b>
      <span>{detail}</span>
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
    <figure className="daily">
      <svg
        viewBox={`0 0 ${W} ${H + 18}`}
        width="100%"
        role="img"
        aria-label="Estimated cost per day"
      >
        <line x1={0} x2={W} y1={H} y2={H} className="axis" />
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
                  className="bar"
                  pointerEvents="none"
                />
              )}
              {(i === 0 || (i + 1) % 7 === 0) && (
                <text
                  x={x + bw / 2}
                  y={H + 14}
                  textAnchor="middle"
                  fontSize={10}
                  className="tick"
                >
                  {Number(d.slice(8))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="small muted">
        Highest day: {usd(max)}. Days without a bar have no recorded cost yet.
      </figcaption>
    </figure>
  );
}

function StatusLabel({ line }: { line: UsageLine }) {
  if (line.status === 'measured')
    return <Chip tone="off">{SOURCE_LABEL[line.source]}</Chip>;
  return (
    <Chip tone="warn">
      {line.status === 'not-configured' ? 'Not configured' : 'Unavailable'}
    </Chip>
  );
}

function LinesTable({ lines }: { lines: UsageLine[] }) {
  const products = [...new Set(lines.map((l) => l.productLabel))];
  return (
    <div className="table-wrap">
      <table className="table usage">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="r">GitOrange usage</th>
            <th>Included (whole account)</th>
            <th className="r">List price</th>
            <th className="r">With allowance</th>
            <th className="r">Projected</th>
          </tr>
        </thead>
        {products.map((p) => (
          <tbody key={p}>
            <tr className="group">
              <th colSpan={6}>{p}</th>
            </tr>
            {lines
              .filter((l) => l.productLabel === p)
              .map((l) => (
                <tr key={l.metric}>
                  <td className="metric">
                    <div>{l.label}</div>
                    <div className="note">
                      <StatusLabel line={l} />
                    </div>
                    {l.reason && (
                      <div className="note attention">{l.reason}</div>
                    )}
                    {l.note && <div className="note muted">{l.note}</div>}
                    {l.billedFrom && (
                      <div className="note muted">
                        Cloudflare bills this from {l.billedFrom}.
                      </div>
                    )}
                    {l.resources.length > 1 && (
                      <div className="note muted">
                        {l.resources
                          .map((r) => `${r.resource}: ${qty(r.quantity)}`)
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="r mono">
                    {l.status === 'measured'
                      ? `${qty(l.quantity)} ${l.unit}`
                      : '—'}
                  </td>
                  <td className="muted">{l.includedLabel}</td>
                  <td className="r mono">{usd(l.listCost)}</td>
                  <td className="r mono">{usd(l.dedicatedCost)}</td>
                  <td className="r mono">{usd(l.projectedListCost)}</td>
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
    <div className="panel">
      <div className="pad">
        <h3 className="group-title">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="pad topline small muted">{empty}</p>
      ) : (
        <ul className="rowlist">
          {rows.map((r) => (
            <li key={r.key} className="split">
              <div className="grow">
                <span className="wrap">{r.key}</span>
                <span className="small muted">{r.detail}</span>
              </div>
              <span className="mono">{usd(r.cost)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Site admin → Usage and cost: what this deployment uses on Cloudflare, and what that would cost. */
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
    kind: 'ok' | 'bad';
    text: string;
  } | null>(null);
  const sync = useMutation({
    mutationFn: api.syncUsage,
    onSuccess: (r) => {
      const failed = Object.values(r.errors).some((e) =>
        Object.keys(e).some((k) => !k.endsWith(':unconfigured'))
      );
      setSyncMsg({
        kind: 'ok',
        text: failed
          ? `Synced ${r.days.length} days; some metrics were unavailable (see below).`
          : `Synced ${r.days.length} days.`,
      });
      qc.invalidateQueries({ queryKey: ['usage'] });
    },
    onError: (e) => setSyncMsg({ kind: 'bad', text: errorMessage(e) }),
  });
  const r = report.data;

  return (
    <>
      <PageHead
        icon="shield"
        crumbs={[
          { label: 'Site admin', to: '/admin' },
          { label: 'Usage and cost' },
        ]}
        title="Usage and cost"
        lede={
          <>
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
          </>
        }
        actions={
          <>
            <input
              type="month"
              className="form-control"
              aria-label="Month"
              value={month}
              max={thisMonth()}
              onChange={(e) =>
                e.target.value && setParams({ month: e.target.value })
              }
            />
            <PendingButton
              className="small"
              pending={sync.isPending}
              pendingLabel="Syncing…"
              disabled={r ? !r.analyticsConfigured : false}
              onClick={() => {
                setSyncMsg(null);
                sync.mutate();
              }}
            >
              <SyncIcon size={14} /> Sync now
            </PendingButton>
          </>
        }
      />
      <AdminFrame>
        {syncMsg && <Notice tone={syncMsg.kind}>{syncMsg.text}</Notice>}
        {report.isPending ? (
          <RowsSkeleton rows={4} />
        ) : report.isError ? (
          <LoadError
            what="the usage report"
            error={report.error}
            onRetry={() => report.refetch()}
          />
        ) : r ? (
          <>
            {!r.analyticsConfigured && (
              <Notice tone="warn">
                Cloudflare analytics are not set up, so only what GitOrange
                records itself (Actions runners, Workers AI calls, emails) is
                shown. Add the <code>CF_ANALYTICS_TOKEN</code> secret: an
                account API token with <b>Account Analytics: Read</b>.
              </Notice>
            )}
            <div className="stats">
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
            <Notice tone="info">
              Included allowances and the plan fee belong to the whole
              Cloudflare account. If anything else runs on it, the allowances
              are shared and the real bill for GitOrange’s usage is somewhere
              between the two figures above.
            </Notice>

            <Section
              title={
                <>
                  <GraphIcon size={16} /> Estimated cost per day
                </>
              }
            >
              <div className="panel pad">
                <DailyChart report={r} />
              </div>
            </Section>

            <Section title="By product">
              <LinesTable lines={r.lines} />
            </Section>

            <div className="usage-cols">
              <Section
                title={`Actions: ${qty(r.actions.minutes)} runner minutes, ${usd(r.actions.cost)}`}
              >
                {r.actions.running > 0 && (
                  <p className="small muted">
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
              </Section>
              <Section
                title={`Workers AI: ${qty(r.ai.requests)} calls, ${usd(r.ai.cost)}`}
              >
                {r.ai.unreportedRequests > 0 && (
                  <p className="small muted">
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
              </Section>
            </div>

            {r.gateway && (
              <Section
                title={
                  <>
                    AI Gateway <code>{r.gateway.id}</code> (whole gateway)
                  </>
                }
              >
                <div className="panel pad small">
                  {r.gateway.status === 'measured' ? (
                    <p>
                      {qty(r.gateway.requests ?? 0)} requests
                      {r.gateway.estimatedCost !== null &&
                        `, ${usd(r.gateway.estimatedCost)} by the gateway’s own estimate`}
                      .
                    </p>
                  ) : (
                    <p className="attention">
                      {r.gateway.status === 'not-configured'
                        ? 'Not configured.'
                        : 'Unavailable.'}{' '}
                      {r.gateway.reason}
                    </p>
                  )}
                  <p className="muted">
                    For the whole gateway, which other apps or a dev instance
                    may share; not added to GitOrange’s totals. GitOrange’s own
                    AI cost is the Workers AI section above.
                  </p>
                </div>
              </Section>
            )}

            <Section title="Not measured">
              <ul className="plain-bullets small muted">
                {r.notMeasured.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p className="small muted">
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
            </Section>
          </>
        ) : null}
      </AdminFrame>
    </>
  );
}
