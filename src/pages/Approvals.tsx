import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertIcon,
  CheckIcon,
  InboxIcon,
  ShieldIcon,
  UndoIcon,
} from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { useApprovalPages } from '@/lib/approvals';
import { useCurrentUser } from '@/lib/auth';
import {
  dedupeItems,
  displayOrder,
  inboxRows,
  keyAction,
  moveCurrent,
  onlyAssignedTo,
  selectable,
  type FindingRow,
  type InboxRow,
} from '@/lib/approvalsInbox';
import { possessive } from '@/lib/claudeLog';
import { AgentAvatar } from '@/components/AgentAvatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { Kbd } from '@/components/ui/Kbd';
import { PageHead } from '@/components/ui/PageHead';
import { PendingButton } from '@/components/ui/PendingButton';
import { Seg } from '@/components/ui/Seg';
import { useToast } from '@/components/ui/Toast';
import { QueryError, RowsSkeleton } from '@/components/actions/states';
import { failure, useRefresh } from '@/components/approvals/actions';
import { ClaudePanel } from '@/components/approvals/ClaudePanel';
import {
  agentName,
  InboxRowView,
  ReceiptView,
  rowHref,
  type Receipt,
  type RowAction,
  type RowPanel,
} from '@/components/approvals/InboxRow';

const KEYS: [string[], string][] = [
  [['j', 'k'], 'move'],
  [['o'], 'open'],
  [['a'], 'approve'],
  [['r'], 'request changes'],
  [['d'], 'dismiss'],
  [['x'], 'select'],
  [['A'], 'approve selected'],
];

type Busy = { key: string; kind: RowAction['kind'] } | null;

/** "Assigned to you" counts over every page: at most this many more pages load by themselves to show them all. */
const ASSIGNED_AUTO_PAGES = 8;
type ReceiptBody = Omit<Receipt, 'key' | 'index' | 'row'>;

const reduced = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** A finding approved from the list (one key, a button or "Approve selected"). */
function approvedReceipt(row: FindingRow): ReceiptBody {
  const { owner, name } = row;
  const n = row.pull.number;
  return {
    status: 'approved',
    icon: 'check',
    tone: 'good',
    text: `You approved ${possessive(agentName(row.agent))} finding. #${n} can merge when nothing else holds it up.`,
    toast: `Approved ${agentName(row.agent)} on #${n}`,
    undo: () => api.undoFlag(owner, name, n, row.flag.id),
  };
}

/**
 * The receipt a decision leaves, known before the request returns: approving, dismissing and requesting changes (on a
 * finding or a whole pull request) show it at once and roll it back if the request fails. Null for the rest.
 */
function receiptFor(row: InboxRow, a: RowAction): ReceiptBody | null {
  const { owner, name } = row;
  const n = row.pull.number;
  if (row.type === 'finding') {
    const agent = agentName(row.agent);
    const undo = () => api.undoFlag(owner, name, n, row.flag.id);
    switch (a.kind) {
      case 'approve':
        return approvedReceipt(row);
      case 'dismiss':
        return a.teach
          ? {
              status: 'learned',
              icon: 'book',
              tone: 'good',
              text: `Dismissed. ${agent} learns your rule when #${n} closes.`,
              toast: `Dismissed. ${agent} learns your rule`,
              undo,
            }
          : {
              status: 'approved',
              icon: 'x',
              tone: 'muted',
              text: `Dismissed for #${n} only. ${agent} will ask again next time.`,
              toast: 'Dismissed once',
              undo,
            };
      case 'changes':
        return {
          status: 'changes_requested',
          icon: 'sync',
          tone: 'change',
          text: `Changes requested on #${n}. Its author gets ${possessive(agent)} finding${a.note.trim() ? ' and your note' : ''}.`,
          toast: `Changes requested on #${n}`,
          undo,
        };
      default:
        return null;
    }
  }
  if (a.kind === 'approve-pull' && row.pull.headSha)
    return {
      status: 'approved',
      icon: 'check',
      tone: 'good',
      text: `You approved #${n}. It can merge when nothing else holds it up.`,
      toast: `Approved #${n}`,
      undo: () => api.withdrawApproval(owner, name, n),
    };
  return null;
}

/** Calls the API for one row's action; the receipt the rest leave (retries), or null when the row simply reloads. */
async function perform(
  row: InboxRow,
  a: RowAction
): Promise<ReceiptBody | null> {
  const { owner, name } = row;
  const n = row.pull.number;
  if (row.type === 'finding') {
    const id = row.flag.id;
    switch (a.kind) {
      case 'approve':
        await api.approveFlag(owner, name, n, id);
        return null;
      case 'dismiss':
        await api.approveFlag(owner, name, n, id, {
          reason: a.reason,
          teach: a.teach,
        });
        return null;
      case 'changes':
        await api.requestFlagChanges(owner, name, n, id, a.note, a.teach);
        return null;
      case 'undo':
        await api.undoFlag(owner, name, n, id);
        return null;
      default:
        return null;
    }
  }
  switch (a.kind) {
    case 'retry-review':
      await api.retryReview(owner, name, n);
      return {
        status: 'reviewing',
        icon: 'play',
        tone: 'good',
        text: `The review of #${n} started again.`,
        toast: `Review restarted on #${n}`,
      };
    case 'retry-reviewer':
      if (row.type !== 'reviewer-failed') return null;
      await api.retryReviewer(owner, name, n, row.reviewerId);
      return {
        status: 'reviewing',
        icon: 'play',
        tone: 'good',
        text: `${agentName(row.agent)} is reviewing #${n} again.`,
        toast: `${agentName(row.agent)} is reviewing #${n} again`,
      };
    case 'retry-stack':
      await api.retryStack(owner, name, n);
      return {
        status: 'reviewing',
        icon: 'play',
        tone: 'good',
        text: `Checking #${n} against the others again.`,
        toast: `Checking #${n} again`,
      };
    case 'approve-pull':
      if (!row.pull.headSha) return null;
      await api.approvePull(owner, name, n, row.pull.headSha);
      return null;
    default:
      return null;
  }
}

/**
 * Everything waiting on you across every repository you can merge in: reviewer findings (owner questions open their
 * own page), failed reviews, conflicts AI couldn't resolve, pull requests no agent reviewed, and stack items.
 * Keyboard first (`j k o a r d x A`); guarded agents' findings are never bulk- or one-key-approved. Each decision
 * leaves a one-line receipt with Undo until you leave the page. The aside lets Claude decide for you.
 */
export default function Approvals() {
  const me = useCurrentUser();
  const myLogin = me?.username ?? null;
  const myName = me?.name || me?.username || 'you';
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useRefresh();
  const [params, setParams] = useSearchParams();
  const assignedOnly = params.get('filter') === 'assigned';

  const q = useApprovalPages();
  const delegations = useQuery({
    queryKey: qk.delegations,
    queryFn: api.delegations,
  });
  const firstPage = q.data?.pages[0];
  const count = firstPage?.count ?? 0;
  const assignedToMe = firstPage?.assignedToMe ?? 0;

  const allRows = useMemo(
    () => inboxRows(dedupeItems(q.data?.pages ?? [])),
    [q.data]
  );
  const rows = useMemo(
    () =>
      assignedOnly && myLogin ? onlyAssignedTo(allRows, myLogin) : allRows,
    [allRows, assignedOnly, myLogin]
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const [receipts, setReceipts] = useState<Map<string, Receipt>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [panels, setPanels] = useState<Map<string, RowPanel>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusyState] = useState<Busy>(null);
  // Toasts call back into older renders (Undo): this ref says what is running now.
  const busyRef = useRef<Busy>(null);
  const setBusy = (b: Busy) => {
    busyRef.current = b;
    setBusyState(b);
  };
  const running = () => !!busyRef.current;
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const refs = useRef(new Map<string, HTMLLIElement>());
  // Decisions sent but not answered yet, by row: Undo waits for them.
  const pending = useRef(new Map<string, Promise<unknown>>());
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;

  const shownReceipts = [...receipts.values()].filter(
    (r) => !assignedOnly || (myLogin && onlyAssignedTo([r.row], myLogin).length)
  );
  const shownReceiptKeys = new Set(shownReceipts.map((r) => r.key));
  const order = displayOrder(
    rows.map((r) => r.key),
    shownReceipts
  );
  const openKeys = order.filter(
    (k) => byKey.has(k) && !shownReceiptKeys.has(k)
  );
  const cur =
    current && openKeys.includes(current) ? current : (openKeys[0] ?? null);
  const picked = [...selected].filter((k) => {
    const r = byKey.get(k);
    return r && selectable(r) && !receipts.has(k);
  });
  const colors = new Map(
    delegations.data?.agents.map((a) => [a.handle, a.color])
  );
  const claudeLeft = new Map<string, string>();
  for (const e of delegations.data?.today ?? [])
    if (e.data.decision === 'leave' && !claudeLeft.has(e.data.finding))
      claudeLeft.set(e.data.finding, e.data.reason);

  const setError = (key: string, message: string | null) =>
    setErrors((m) => {
      const next = new Map(m);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  const focusRow = (key: string | null) => {
    if (!key) return;
    requestAnimationFrame(() => {
      const el = refs.current.get(key);
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({
        block: 'nearest',
        behavior: reduced() ? 'auto' : 'smooth',
      });
    });
  };
  const nextOpen = (key: string) => {
    const i = openKeys.indexOf(key);
    return openKeys[i + 1] ?? openKeys[i - 1] ?? null;
  };
  const closePanel = (key: string) =>
    setPanels((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  const togglePick = (key: string, on?: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });

  /** Removes a receipt: the row is back in the list. */
  const dropReceipt = (key: string) =>
    setReceipts((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });

  /** Shows a decision's receipt now; the request runs behind it, and a refusal puts the row back with the error. */
  const decide = async (row: InboxRow, a: RowAction, body: ReceiptBody) => {
    const index = order.indexOf(row.key);
    const next = nextOpen(row.key);
    const hadFocus = !!refs.current
      .get(row.key)
      ?.contains(document.activeElement);
    setError(row.key, null);
    closePanel(row.key);
    togglePick(row.key, false);
    setReceipts((m) =>
      new Map(m).set(row.key, { ...body, key: row.key, index, row })
    );
    toast(
      body.toast,
      body.undo ? { undo: () => void undoReceipt(row.key) } : undefined
    );
    if (cur === row.key) setCurrent(next);
    if (hadFocus) focusRow(next);
    const request = perform(row, a);
    pending.current.set(row.key, request);
    try {
      await request;
    } catch (e) {
      dropReceipt(row.key);
      const message = failure(e, { sendingNote: a.kind === 'changes' });
      setError(row.key, message);
      toast(`Not saved: ${message}`, { icon: <AlertIcon size={16} /> });
    } finally {
      pending.current.delete(row.key);
      // Also after a refusal (409: the branch moved): the list shows the new state.
      await refresh(row.owner, row.name);
    }
  };

  const run = async (row: InboxRow, a: RowAction) => {
    if (running() || pending.current.has(row.key)) return;
    const body = receiptFor(row, a);
    if (body) return decide(row, a, body);
    const index = order.indexOf(row.key);
    const next = nextOpen(row.key);
    const hadFocus = !!refs.current
      .get(row.key)
      ?.contains(document.activeElement);
    setBusy({ key: row.key, kind: a.kind });
    setError(row.key, null);
    try {
      const done = await perform(row, a);
      closePanel(row.key);
      togglePick(row.key, false);
      if (done) {
        setReceipts((m) =>
          new Map(m).set(row.key, { ...done, key: row.key, index, row })
        );
        toast(
          done.toast,
          done.undo ? { undo: () => void undoReceipt(row.key) } : undefined
        );
        if (cur === row.key) setCurrent(next);
        if (hadFocus) focusRow(next);
      } else if (a.kind === 'undo')
        toast('Reopened. It’s back in your list.', {
          icon: <UndoIcon size={16} />,
        });
    } catch (e) {
      setError(row.key, failure(e, { sendingNote: a.kind === 'changes' }));
    } finally {
      // Also after a refusal (409: the branch moved): the list shows the new state.
      await refresh(row.owner, row.name);
      setBusy(null);
    }
  };

  const undoReceipt = async (key: string) => {
    // Undo right after deciding: let the decision land first, and do nothing if it was refused.
    const inFlight = pending.current.get(key);
    if (inFlight) await inFlight.catch(() => undefined);
    const r = receiptsRef.current.get(key);
    if (!r?.undo || running()) return;
    setBusy({ key, kind: 'undo' });
    setError(key, null);
    try {
      await r.undo();
      await refresh(r.row.owner, r.row.name);
      dropReceipt(key);
      setCurrent(key);
      focusRow(key);
      toast('Reopened. It’s back in your list.', {
        icon: <UndoIcon size={16} />,
      });
    } catch (e) {
      setError(key, failure(e));
      await refresh(r.row.owner, r.row.name);
    } finally {
      setBusy(null);
    }
  };

  const undoMany = async (keys: string[]) => {
    for (const key of keys) await undoReceipt(key);
  };

  const approveSelected = async () => {
    const rowsToApprove = picked
      .map((k) => byKey.get(k))
      .filter((r): r is FindingRow => !!r && r.type === 'finding');
    if (!rowsToApprove.length || running()) return;
    // Every receipt shows now; the approvals are sent one by one behind them, and refusals come back as rows.
    const keys = rowsToApprove.map((r) => r.key);
    for (const row of rowsToApprove) setError(row.key, null);
    setReceipts((m) => {
      const next = new Map(m);
      for (const row of rowsToApprove)
        next.set(row.key, {
          ...approvedReceipt(row),
          key: row.key,
          index: order.indexOf(row.key),
          row,
        });
      return next;
    });
    setSelected(new Set());
    setCurrent(openKeys.find((k) => !keys.includes(k)) ?? null);
    toast(
      `Approved ${keys.length} ${keys.length === 1 ? 'finding' : 'findings'}`,
      { undo: () => void undoMany(keys) }
    );
    const sent = (async () => {
      let refused = 0;
      for (const row of rowsToApprove)
        try {
          await api.approveFlag(
            row.owner,
            row.name,
            row.pull.number,
            row.flag.id
          );
        } catch (e) {
          refused++;
          dropReceipt(row.key);
          setError(row.key, failure(e));
        }
      return refused;
    })();
    for (const key of keys) pending.current.set(key, sent);
    const refused = await sent;
    for (const key of keys) pending.current.delete(key);
    await Promise.all(
      [...new Set(rowsToApprove.map((r) => r.repo))].map((repo) => {
        const [o, n] = repo.split('/');
        return refresh(o, n);
      })
    );
    if (refused)
      toast(
        `${refused} ${refused === 1 ? 'approval was' : 'approvals were'} not saved: ${refused === 1 ? 'it is' : 'they are'} back in your list`,
        { icon: <AlertIcon size={16} /> }
      );
  };

  // The "Assigned to you" count covers every page, the list only the loaded ones: while the filter is on and some
  // assigned findings are on pages not loaded yet, load them (a bounded number of pages per visit to the filter).
  const autoPages = useRef(0);
  useEffect(() => {
    autoPages.current = 0;
  }, [assignedOnly]);
  const assignedMissing =
    assignedOnly && !!q.hasNextPage && rows.length < assignedToMe;
  const fetchNext = q.fetchNextPage;
  useEffect(() => {
    if (
      !assignedMissing ||
      q.isFetchingNextPage ||
      autoPages.current >= ASSIGNED_AUTO_PAGES
    )
      return;
    autoPages.current += 1;
    void fetchNext();
  }, [assignedMissing, q.isFetchingNextPage, fetchNext]);

  // Keyboard shortcuts: j k o a r d x A (and Enter), never while typing or inside a menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : document.body;
      if (
        t.closest(
          'textarea, select, [contenteditable="true"], input:not([type=checkbox]):not([type=radio]), [data-menu-root]'
        )
      )
        return;
      if (e.key === 'Enter' && t.closest('button, a, input, label, summary'))
        return;
      const row = cur ? (byKey.get(cur) ?? null) : null;
      // Shift+a is "A" whatever the keyboard reports.
      const key =
        e.shiftKey && e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const act = keyAction(key, row);
      if (!act) return;
      e.preventDefault();
      switch (act.kind) {
        case 'move': {
          const k = moveCurrent(openKeys, cur, act.dir);
          setCurrent(k);
          focusRow(k);
          break;
        }
        case 'bulk':
          void approveSelected();
          break;
        case 'open':
          if (!row) break;
          if (act.toast) toast(act.toast, { icon: <ShieldIcon size={16} /> });
          navigate(rowHref(row));
          break;
        case 'approve':
          if (row) void run(row, { kind: 'approve' });
          break;
        case 'panel':
          if (!row) break;
          setPanels((m) => new Map(m).set(row.key, act.panel));
          setCurrent(row.key);
          break;
        case 'select':
          if (row) togglePick(row.key);
          break;
        case 'toast':
          toast(act.message, { icon: <ShieldIcon size={16} /> });
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const lede = !q.data
    ? undefined
    : count
      ? `${count} ${count === 1 ? 'item needs' : 'items need'} you. Your reviewers raised these for a person, across every repository you can merge in.`
      : 'Nothing needs you. Your crew will ask when something does.';

  const setFilter = (v: 'all' | 'assigned') =>
    setParams(v === 'assigned' ? { filter: 'assigned' } : {}, {
      replace: true,
    });

  let list;
  if (q.isError && !q.data)
    list = (
      <QueryError
        error={q.error}
        onRetry={() => void q.refetch()}
        title="Approvals did not load"
        picture={<InboxIcon size={24} />}
      />
    );
  else if (!q.data) list = <RowsSkeleton rows={5} />;
  else if (!order.length && assignedOnly && q.isFetchingNextPage)
    list = <RowsSkeleton rows={3} />;
  else if (!order.length && assignedOnly && q.hasNextPage)
    // Never "nothing is assigned" while pages remain: say what was looked at, and Load more sits below.
    list = (
      <EmptyState
        id="ap-empty"
        tabIndex={-1}
        picture={<AgentAvatar handle="clef" status="idle" size={56} />}
        title="Nothing assigned to you in what has loaded so far."
        body="Load more to look further."
      />
    );
  else if (!order.length)
    list = assignedOnly ? (
      <EmptyState
        id="ap-empty"
        tabIndex={-1}
        picture={<AgentAvatar handle="clef" status="idle" size={56} />}
        title="Nothing is assigned to you."
        body="When someone asks you to decide a finding, it shows here."
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
      <EmptyState
        id="ap-empty"
        tabIndex={-1}
        picture={<AgentAvatar handle="clef" status="idle" size={56} />}
        title="Nothing needs you."
        body="Your crew will ask when something does: findings agents raise for a person, failed reviews, pull requests no agent reviewed, conflicts AI couldn’t resolve, and pull requests that need a decision."
      />
    );
  else
    list = (
      <ol className="ap-list">
        {order.map((key) => {
          const receipt = shownReceiptKeys.has(key) ? receipts.get(key) : null;
          const setRef = (el: HTMLLIElement | null) => {
            if (el) refs.current.set(key, el);
            else refs.current.delete(key);
          };
          if (receipt)
            return (
              <ReceiptView
                key={key}
                receipt={receipt}
                undoing={busy?.key === key}
                locked={!!busy}
                error={errors.get(key) ?? null}
                color={
                  receipt.row.type === 'finding' ||
                  receipt.row.type === 'reviewer-failed'
                    ? colors.get(receipt.row.agent.username)
                    : undefined
                }
                setRef={setRef}
                onUndo={() => void undoReceipt(key)}
              />
            );
          const row = byKey.get(key);
          if (!row) return null;
          return (
            <InboxRowView
              key={key}
              row={row}
              current={cur === key}
              picked={selected.has(key)}
              panel={panels.get(key) ?? null}
              busy={busy?.key === key ? busy.kind : null}
              locked={!!busy}
              error={errors.get(key) ?? null}
              me={myLogin}
              color={
                row.type === 'finding' || row.type === 'reviewer-failed'
                  ? colors.get(row.agent.username)
                  : undefined
              }
              claudeLeft={
                row.type === 'finding' ? claudeLeft.get(row.flag.id) : undefined
              }
              setRef={setRef}
              onFocus={() => cur !== key && setCurrent(key)}
              onPick={(on) => togglePick(key, on)}
              onPanel={(p) => {
                setCurrent(key);
                setPanels((m) => {
                  const next = new Map(m);
                  if (p) next.set(key, p);
                  else next.delete(key);
                  return next;
                });
                if (!p) focusRow(key);
              }}
              onAct={(a) => void run(row, a)}
            />
          );
        })}
      </ol>
    );

  return (
    <div className="ap">
      <PageHead
        icon="inbox"
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Approvals' }]}
        title="Approvals"
        lede={lede}
      />
      <div className="ap-bar">
        <Seg
          label="Show"
          value={assignedOnly ? 'assigned' : 'all'}
          onChange={setFilter}
          options={[
            {
              value: 'all',
              label: firstPage ? `Everything · ${count}` : 'Everything',
            },
            {
              value: 'assigned',
              label: firstPage
                ? `Assigned to you · ${assignedToMe}`
                : 'Assigned to you',
            },
          ]}
        />
        <ul className="ap-keys" aria-label="Keyboard shortcuts">
          {KEYS.map(([keys, what]) => (
            <li key={what}>
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
              <span>{what}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="ap-grid">
        <div className="ap-stack">
          <section className="ap-box" aria-labelledby="ap-list-h">
            <div className="ap-box-head">
              <h2 id="ap-list-h">
                {assignedOnly ? 'Assigned to you' : 'Waiting on you'}{' '}
                {firstPage && (
                  <span className="ap-n">
                    {assignedOnly ? assignedToMe : count}
                  </span>
                )}
                {shownReceipts.length > 0 && (
                  <span className="ap-n-done">
                    {shownReceipts.length} answered
                  </span>
                )}
              </h2>
              {picked.length > 0 && (
                <div className="ap-bulk">
                  <span>{picked.length} selected</span>
                  <button
                    type="button"
                    className="btn quiet small"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={!!busy}
                    onClick={() => void approveSelected()}
                  >
                    <CheckIcon size={14} />
                    Approve selected
                  </button>
                </div>
              )}
            </div>
            {list}
            {q.hasNextPage && (
              <div className="ap-more-row">
                <PendingButton
                  className="small"
                  pending={q.isFetchingNextPage}
                  pendingLabel="Loading…"
                  onClick={() => void q.fetchNextPage()}
                >
                  Load more
                </PendingButton>
              </div>
            )}
          </section>
        </div>
        <ClaudePanel myName={myName} />
      </div>
    </div>
  );
}
