import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BeakerIcon,
  DashIcon,
  GitMergeIcon,
} from '@primer/octicons-react';
import type { HealthArea, HealthTrend } from '@/lib/uiApi';
import { areaKind, areaSpark, TREND_LOOK } from '@/lib/health';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Chip } from '@/components/ui/Chip';
import { Spark } from '@/components/ui/Spark';

const TREND_ICON: Record<HealthTrend, ReactNode> = {
  better: <ArrowUpIcon size={12} />,
  same: <DashIcon size={12} />,
  worse: <ArrowDownIcon size={12} />,
};

/** The row's name: an agent with its avatar, or the tests and merging rows with their own mark. */
function AreaName({ area, base }: { area: HealthArea; base: string }) {
  const kind = areaKind(area);
  if (kind === 'agent')
    return (
      <Link
        className="hl-area"
        to={`/${area.agent}`}
        style={{ '--agent': area.color } as CSSProperties}
      >
        <AgentAvatar
          handle={area.agent!}
          color={area.color}
          status={area.open > 0 ? 'flagged' : 'idle'}
          size={28}
        />
        <b>{area.label}</b>
      </Link>
    );
  if (kind === 'tests')
    return (
      <Link className="hl-area" to={`${base}/actions`}>
        <span className="hl-area-mark" aria-hidden="true">
          <BeakerIcon size={16} />
        </span>
        <b>{area.label}</b>
      </Link>
    );
  return (
    <span className="hl-area">
      <span className="hl-area-mark" aria-hidden="true">
        <GitMergeIcon size={16} />
      </span>
      <b>{area.label}</b>
    </span>
  );
}

/**
 * "Did anything get worse?": a row per reviewer, then tests on main and merging. Each says where it stands now and
 * how this week compares, charts the last eight weeks and names the change in words. Every row counts problems
 * (findings raised, the share of test runs that failed, reverts), so lower is better.
 */
export function TrendTable({
  areas,
  base,
}: {
  areas: HealthArea[];
  base: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table hl-table">
        <caption className="sr">
          Did anything get worse? A row for each area: where it stands now, the
          last eight weeks, and whether it is better, the same or worse than
          last week. Every row counts problems, so lower is better.
        </caption>
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">This week</th>
            <th scope="col">Last 8 weeks</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => {
            const spark = areaSpark(area);
            const look = TREND_LOOK[area.trend];
            return (
              <tr key={area.id}>
                <th scope="row" className="hl-cell-area">
                  <AreaName area={area} base={base} />
                </th>
                <td className="hl-cell-now">
                  <b>{area.status}</b>
                  <span className="muted small">{area.detail}</span>
                </td>
                <td className="hl-cell-spark">
                  <Spark
                    values={spark.values}
                    width={104}
                    height={28}
                    unit={spark.unit}
                    label={spark.label}
                    labels={spark.labels}
                    trend={spark.trend}
                    missing={spark.missing}
                    missingText={spark.missingText}
                  />
                </td>
                <td className="hl-cell-change">
                  <Chip tone={look.tone} icon={TREND_ICON[area.trend]}>
                    {look.label}
                  </Chip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
