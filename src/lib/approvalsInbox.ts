/**
 * The Approvals inbox as rows: one per thing that waits on a person (a finding, a failed review, a pull request
 * that needs approval, a stack item), what keyboard shortcuts do on each, and the pieces of a finding's recorded
 * detail. Pure, so the page stays thin and the rules (guarded agents never bulk- or one-key-approved) are tested.
 */
import type {
  ApprovalItem,
  Member,
  PullState,
  ReviewFlag,
  User,
} from './uiApi';

type RowCommon = {
  /** Stable across reloads: the finding, reviewer or pull request it is about. */
  key: string;
  /** `owner/name`. */
  repo: string;
  owner: string;
  name: string;
  pull: ApprovalItem['pull'];
  prUrl: string;
};
export type FindingRow = RowCommon & {
  type: 'finding';
  flag: ReviewFlag;
  agent: User;
  reviewerId: string;
};
export type InboxRow =
  | FindingRow
  | (RowCommon & {
      type: 'reviewer-failed';
      agent: User;
      reviewerId: string;
      error: string | null;
    })
  | (RowCommon & { type: 'review-failed'; error: string })
  | (RowCommon & { type: 'resolution-failed'; message: string })
  | (RowCommon & { type: 'stack-stale'; pr: number; since: string })
  | (RowCommon & { type: 'stack-unchecked'; prs: number[] })
  | (RowCommon & { type: 'needs-approval'; changeRequested: boolean })
  | (RowCommon & { type: 'human-review'; state: PullState });

/** A pull request updated between pages can come back on a later one: each shows once, where it first came. */
export function dedupeItems(
  pages: { items: ApprovalItem[] }[]
): ApprovalItem[] {
  const seen = new Map<string, ApprovalItem>();
  for (const p of pages)
    for (const i of p.items) {
      const k = `${i.repo.fullName}#${i.pull.number}`;
      if (!seen.has(k)) seen.set(k, i);
    }
  return [...seen.values()];
}

/** An agent's change request still stands on the pull request (approving it doesn't override that). */
function changeRequested(item: ApprovalItem): boolean {
  return (
    !!item.pullState?.reasons.some(
      (r) => r.kind === 'agent_changes_requested'
    ) ||
    item.agents.some(
      (g) =>
        g.status === 'changes_requested' ||
        g.flags.some((f) => f.kind === 'change_requested' && !f.approvedAt)
    )
  );
}

/**
 * Every item's rows, newest pull request first. Within one: a failed review, a failed conflict resolution, stack
 * items, a pull request that needs approval, then each agent's failed review and findings. A pull request that
 * needs a person for another reason (a cycle, say) gets one row, only when nothing else applies.
 */
export function inboxRows(items: ApprovalItem[]): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const item of items) {
    const repo = item.repo.fullName;
    const [owner, name] = repo.split('/');
    const n = item.pull.number;
    const id = `${repo}#${n}`;
    const common = {
      repo,
      owner,
      name,
      pull: item.pull,
      prUrl: `/${repo}/pull/${n}`,
    };
    const other =
      !!item.reviewFailed ||
      !!item.resolutionFailed ||
      item.stackStale.length > 0 ||
      item.stackUnchecked.length > 0 ||
      item.needsApproval ||
      item.agents.length > 0;
    if (item.pullState?.state === 'human_review' && !other)
      rows.push({
        ...common,
        key: `hr:${id}`,
        type: 'human-review',
        state: item.pullState,
      });
    if (item.reviewFailed)
      rows.push({
        ...common,
        key: `rf:${id}`,
        type: 'review-failed',
        error: item.reviewFailed,
      });
    if (item.resolutionFailed)
      rows.push({
        ...common,
        key: `rs:${id}`,
        type: 'resolution-failed',
        message: item.resolutionFailed,
      });
    for (const s of item.stackStale)
      rows.push({
        ...common,
        key: `st:${id}:${s.pr}`,
        type: 'stack-stale',
        pr: s.pr,
        since: s.since,
      });
    if (item.stackUnchecked.length)
      rows.push({
        ...common,
        key: `su:${id}`,
        type: 'stack-unchecked',
        prs: item.stackUnchecked,
      });
    if (item.needsApproval)
      rows.push({
        ...common,
        key: `na:${id}`,
        type: 'needs-approval',
        changeRequested: changeRequested(item),
      });
    for (const g of item.agents) {
      if (g.status === 'failed')
        rows.push({
          ...common,
          key: `rv:${g.reviewerId}`,
          type: 'reviewer-failed',
          agent: g.agent,
          reviewerId: g.reviewerId,
          error: g.error,
        });
      for (const f of g.flags)
        rows.push({
          ...common,
          key: `f:${f.id}`,
          type: 'finding',
          flag: f,
          agent: g.agent,
          reviewerId: g.reviewerId,
        });
    }
  }
  return rows;
}

/** Only findings someone asked `login` to decide (the "Assigned to you" filter). */
export function onlyAssignedTo(rows: InboxRow[], login: string): InboxRow[] {
  const me = login.toLowerCase();
  return rows.filter(
    (r) => r.type === 'finding' && r.flag.assignee?.login.toLowerCase() === me
  );
}

/** A plain yes/no question for the owner: answered on its own page, one at a time. */
export const isOwnerQuestion = (r: InboxRow): boolean =>
  r.type === 'finding' && r.flag.kind === 'needs_person' && !!r.flag.question;

/** Someone already decided it (a request for changes stays listed until it is fixed or approved). */
export const isDecided = (f: ReviewFlag) =>
  !!f.approvedAt || !!f.changesRequestedAt;

/** Whether a row can join "Approve selected": open, ordinary findings only; never a guarded agent's. */
export function selectable(r: InboxRow): boolean {
  return (
    r.type === 'finding' &&
    !r.flag.guarded &&
    !isOwnerQuestion(r) &&
    !isDecided(r.flag)
  );
}

/** What a guarded agent's finding says when a one-key decision is tried on it. */
export const guardMessage = (agentName: string) =>
  `${agentName} findings need a reason. Open it to decide.`;

export type KeyAction =
  | { kind: 'move'; dir: 1 | -1 }
  | { kind: 'bulk' }
  | { kind: 'open'; toast?: string }
  | { kind: 'approve' }
  | { kind: 'panel'; panel: 'changes' | 'dismiss' }
  | { kind: 'select' }
  | { kind: 'toast'; message: string };

/**
 * What a key does on the current row (`j k o a r d x A`, and Enter): guarded findings never approve, dismiss or
 * select by one key (their page opens, with the reason), owner questions open their page, other rows only open.
 */
export function keyAction(key: string, row: InboxRow | null): KeyAction | null {
  if (key === 'j') return { kind: 'move', dir: 1 };
  if (key === 'k') return { kind: 'move', dir: -1 };
  if (key === 'A') return { kind: 'bulk' };
  if (!row) return null;
  if (key === 'o' || key === 'Enter') return { kind: 'open' };
  if (row.type !== 'finding') return null;
  if (isOwnerQuestion(row))
    return key === 'a' || key === 'r' || key === 'd' ? { kind: 'open' } : null;
  const name = row.agent.name || `@${row.agent.username}`;
  if (row.flag.guarded) {
    if (key === 'a' || key === 'd')
      return { kind: 'open', toast: guardMessage(name) };
    if (key === 'x')
      return {
        kind: 'toast',
        message: `${name} findings can't be approved in bulk.`,
      };
  }
  if (key === 'a') return { kind: 'approve' };
  if (key === 'r') return { kind: 'panel', panel: 'changes' };
  if (key === 'd') return { kind: 'panel', panel: 'dismiss' };
  if (key === 'x') return selectable(row) ? { kind: 'select' } : null;
  return null;
}

/** The next current row for j (1) or k (-1): the first when none is current, stopping at either end. */
export function moveCurrent(
  keys: string[],
  current: string | null,
  dir: 1 | -1
): string | null {
  if (!keys.length) return null;
  const i = current === null ? -1 : keys.indexOf(current);
  if (i < 0) return keys[0];
  return keys[Math.max(0, Math.min(keys.length - 1, i + dir))];
}

/**
 * The order rows show in: the list as loaded, with each receipt (a row you just decided, which the reloaded list
 * may no longer have) back at the place it had, so nothing jumps under your cursor.
 */
export function displayOrder(
  rowKeys: string[],
  receipts: { key: string; index: number }[]
): string[] {
  const out = [...rowKeys];
  const present = new Set(rowKeys);
  for (const r of [...receipts]
    .filter((r) => !present.has(r.key))
    .sort((a, b) => a.index - b.index))
    out.splice(Math.min(r.index, out.length), 0, r.key);
  return out;
}

/** A finding's recorded detail (worker/src/review/detail.ts `composeDetail`), in its parts. Markdown each. */
export type FindingParts = {
  /** The agent's one plain sentence. */
  sentence: string | null;
  /** The before/after table. */
  table: string | null;
  /** A ```mermaid block. */
  diagram: string | null;
  /** Each cited diff excerpt: a `<details>` block with the path, lines and diff. */
  excerpts: string[];
  /** Anything else, kept so nothing recorded is lost. */
  rest: string | null;
};

export function splitFindingDetail(
  detail: string | null | undefined
): FindingParts {
  const parts: FindingParts = {
    sentence: null,
    table: null,
    diagram: null,
    excerpts: [],
    rest: null,
  };
  if (!detail?.trim()) return parts;
  let text = detail.replace(/\r\n/g, '\n');
  text = text.replace(/<details>[\s\S]*?<\/details>/g, (m) => {
    parts.excerpts.push(m.trim());
    return '\n\n';
  });
  text = text.replace(/(```|~~~~?)mermaid\n[\s\S]*?\n\1/, (m) => {
    parts.diagram = m.trim();
    return '\n\n';
  });
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const rest: string[] = [];
  paras.forEach((p, i) => {
    const isTable = p.split('\n').every((l) => l.trim().startsWith('|'));
    if (isTable && !parts.table) parts.table = p;
    else if (i === 0 && !isTable) parts.sentence = p;
    else rest.push(p);
  });
  parts.rest = rest.length ? rest.join('\n\n') : null;
  return parts;
}

const bare = (t: string) =>
  t
    .trim()
    .replace(/[.!?]+$/, '')
    .toLowerCase();

/** The sentence to show under a finding's title: its recorded one, unless it only repeats the title. */
export function findingSentence(
  f: Pick<ReviewFlag, 'title' | 'detail'>
): string | null {
  const { sentence } = splitFindingDetail(f.detail);
  return sentence && bare(sentence) !== bare(f.title) ? sentence : null;
}

/**
 * The people who can be asked to decide a finding in a repository: those with push rights (site admins,
 * collaborators and the personal owner; a team has no person as owner), never the person asking. The server checks
 * again (422).
 */
export function askCandidates({
  members,
  collaborators,
  owner,
  me,
}: {
  members: Member[];
  collaborators: User[];
  /** The repository's owner segment (a username, or a team's slug). */
  owner: string;
  me: string | null;
}): { login: string; name: string }[] {
  const out = new Map<string, { login: string; name: string }>();
  const add = (u: User) =>
    out.set(u.username.toLowerCase(), {
      login: u.username,
      name: u.name || u.username,
    });
  for (const m of members) if (m.role === 'admin') add(m);
  for (const c of collaborators) add(c);
  const personal = members.find(
    (m) => m.username.toLowerCase() === owner.toLowerCase()
  );
  if (personal) add(personal);
  if (me) out.delete(me.toLowerCase());
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
