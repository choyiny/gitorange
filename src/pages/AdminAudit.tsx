import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { HistoryIcon, SyncIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import {
  AUDIT_CATEGORIES,
  auditCategory,
  type AuditCategory,
} from '@/lib/auditText';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { PendingButton } from '@/components/ui/PendingButton';
import { AuditList } from '@/components/AuditEvents';
import { LoadError } from '@/components/Notice';
import { AdminFrame, RowsSkeleton } from '@/components/SetFrame';

type Filter = AuditCategory | 'all';

/**
 * Site admin → Audit log: everything people, reviewer agents, GitOrange AI and GitOrange itself did on this
 * instance, newest first, one sentence each. Older events load on request (cursor paging).
 */
export default function AdminAudit() {
  const log = useInfiniteQuery({
    queryKey: qk.adminAudit,
    queryFn: ({ pageParam }) => api.adminAudit(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  // Real names for the crew ("Speed", not "speedagent"). Optional: the log reads fine without them.
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const agentNames = useMemo(
    () =>
      Object.fromEntries((agents.data ?? []).map((a) => [a.username, a.name])),
    [agents.data]
  );
  const [filter, setFilter] = useState<Filter>('all');

  const events = useMemo(
    () => log.data?.pages.flatMap((p) => p.events) ?? [],
    [log.data]
  );
  const shown = useMemo(
    () =>
      filter === 'all'
        ? events
        : events.filter((e) => auditCategory(e.action) === filter),
    [events, filter]
  );
  const more = log.hasNextPage;

  return (
    <>
      <PageHead
        icon="shield"
        crumbs={[{ label: 'Site admin', to: '/admin' }, { label: 'Audit log' }]}
        title="Audit log"
        lede="Who did what on this instance, newest first: merges, decisions, access, settings and what GitOrange did on its own. Entries are recorded as they happen and can’t be edited."
        actions={
          <PendingButton
            className="small"
            pending={log.isRefetching && !log.isFetchingNextPage}
            pendingLabel="Refreshing…"
            onClick={() => log.refetch()}
          >
            <SyncIcon size={14} /> Refresh
          </PendingButton>
        }
      />
      <AdminFrame>
        <div className="filters" role="group" aria-label="Show">
          {(
            [{ id: 'all', label: 'Everything' }, ...AUDIT_CATEGORIES] as {
              id: Filter;
              label: string;
            }[]
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              className="pill"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <section className="panel" aria-label="Audit events">
          {log.isPending ? (
            <div className="pad">
              <RowsSkeleton rows={6} />
            </div>
          ) : log.isError && events.length === 0 ? (
            <div className="pad">
              <LoadError
                what="the audit log"
                error={log.error}
                onRetry={() => log.refetch()}
              />
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              picture={<HistoryIcon size={20} />}
              title="Nothing has been recorded yet."
              body="Merges, decisions, setting changes and access changes appear here as they happen."
            />
          ) : shown.length === 0 ? (
            <EmptyState
              picture={<HistoryIcon size={20} />}
              title="None of the loaded events match."
              body={
                more
                  ? 'Load older events to look further back, or show everything.'
                  : 'Show everything to see all of them.'
              }
              action={
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setFilter('all')}
                >
                  Show everything
                </button>
              }
            />
          ) : (
            <AuditList
              events={shown}
              options={{ scope: 'instance', agentNames }}
            />
          )}
          {(more ||
            log.isFetchingNextPage ||
            (log.isError && events.length > 0)) && (
            <div className="aud-more">
              {log.isError && events.length > 0 && (
                <span className="small attention">
                  Could not load more events.
                </span>
              )}
              <PendingButton
                className="small"
                pending={log.isFetchingNextPage}
                pendingLabel="Loading…"
                onClick={() => log.fetchNextPage()}
              >
                Load older
              </PendingButton>
            </div>
          )}
        </section>
      </AdminFrame>
    </>
  );
}
