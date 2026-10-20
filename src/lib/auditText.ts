import type { AuditEvent } from './uiApi';
import { reasonText } from './pullState';

// The audit log in words: every event as one sentence ("mahmoud paused merging on choyiny/gitorange"), a second
// line for the facts that matter (the reason, the note, what a setting was), a link and a category. Pure, so the
// instance-wide log (Site admin → Audit log), a repository's own log and the Live page all say it the same way.

/** Where the sentence is read: a repository's own log leaves the repository out, the instance log names it. */
export type AuditScope = 'repo' | 'instance';

export interface AuditOptions {
  scope?: AuditScope;
  /** Agent handle → display name, for pages that know the crew ("speedagent" → "Speed"). */
  agentNames?: Record<string, string>;
}

/** A piece of a sentence: plain text, who did it, or a repository or pull request the page can link. */
export type AuditPart =
  | { kind: 'text'; text: string }
  | { kind: 'who'; text: string }
  | { kind: 'repo'; text: string; to: string }
  | { kind: 'pull'; text: string; to: string | null };

/** Every `audit_events` action (spec: audit_events actions). Pull request timeline entries arrive as `pull.<kind>`. */
export const AUDIT_ACTIONS = [
  'settings.changed',
  'collaborator.added',
  'collaborator.removed',
  'agent.invited',
  'agent.removed',
  'agent.created',
  'agent.deleted',
  'branch.deleted',
  'branches.cleaned',
  'merging.paused',
  'merging.resumed',
  'pull.merged',
  'pull.reverted',
  'pull.approved',
  'finding.approved',
  'finding.changes_requested',
  'finding.assigned',
  'finding.delegated',
  'finding.undone',
  'finding.taught',
  'token.created',
  'token.deleted',
  'visibility.changed',
  'repository.created',
  'repository.deleted',
  'instance.settings',
  'release.created',
  'release.updated',
  'pull.version_bump',
] as const;

type Data = Record<string, unknown>;
type Actor = AuditEvent['actor'];

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const record = (v: unknown): Data | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : null;

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clip = (s: string, max = 200) =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

/** "a", "a and b", "a, b and c". */
const list = (xs: string[]) =>
  xs.length < 2
    ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const possessive = (name: string) =>
  /s$/i.test(name) ? `${name}'` : `${name}'s`;

const ACRONYMS: Record<string, string> = { ai: 'AI', id: 'ID', url: 'URL' };

/** "actions.retention_days" → ["actions", "retention", "days"]. */
const words = (key: string) =>
  key
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/** A setting key in words: "actions.retention_days" → "Actions retention days", "ai.review_model" → "AI review model". */
function settingLabel(key: string): string {
  const ws = words(key).map((w) => ACRONYMS[w] ?? w);
  return ws.length
    ? cap(ws[0]) + (ws.length > 1 ? ` ${ws.slice(1).join(' ')}` : '')
    : key;
}

/**
 * A reviewer agent's name from its handle: "speedagent" → "Speed". Custom handles stay as they are. A page that
 * knows the real names passes them in `names`.
 */
export function agentLabel(
  handle: string,
  names?: Record<string, string>
): string {
  const known = names?.[handle];
  if (known) return known;
  const m = /^(.+?)agent$/i.exec(handle);
  return m ? cap(m[1]) : handle;
}

/** Who did it, as a name: a person's username, an agent's name, "GitOrange AI" or "System". */
export function actorName(
  actor: Actor,
  names?: Record<string, string>
): string {
  switch (actor.kind) {
    case 'ai':
      return 'GitOrange AI';
    case 'system':
      return 'System';
    case 'agent':
      return actor.login
        ? agentLabel(actor.login, names)
        : actor.name || 'A reviewer agent';
    default:
      return actor.login || actor.name || 'A former member';
  }
}

/** Joins strings and parts into parts, merging neighbouring text and dropping what is empty. */
function build(...xs: (string | AuditPart | null | false | undefined)[]) {
  const out: AuditPart[] = [];
  for (const x of xs) {
    if (!x) continue;
    const part: AuditPart =
      typeof x === 'string' ? { kind: 'text', text: x } : x;
    const last = out[out.length - 1];
    if (part.kind === 'text' && last?.kind === 'text') last.text += part.text;
    else out.push(part);
  }
  return out;
}

const STATE_PHRASE: Record<string, string> = {
  agent_followup: 'waiting on an agent',
  human_review: 'waiting on a person',
  waiting: 'waiting for checks',
  ready: 'ready to merge',
};

const SETTING_LABEL: Record<string, string> = {
  name: 'the name',
  description: 'the description',
  defaultBranch: 'the default branch',
  protectedBranches: 'the protected branches',
  deleteMergedBranches: 'automatic branch clean-up',
};
const SETTING_DETAIL: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  defaultBranch: 'Default branch',
  protectedBranches: 'Protected branches',
  deleteMergedBranches: 'Automatic branch clean-up',
};

/** The pieces of one event's sentence, so a page can link the repository and the pull request. */
export function auditParts(
  e: AuditEvent,
  opts: AuditOptions = {}
): AuditPart[] {
  const scope = opts.scope ?? 'instance';
  const names = opts.agentNames;
  const d: Data = record(e.data) ?? {};
  const who: AuditPart = { kind: 'who', text: actorName(e.actor, names) };
  const here = scope === 'instance' ? e.repo : null;

  const repoPart = (): AuditPart | null =>
    e.repo ? { kind: 'repo', text: e.repo, to: `/${e.repo}` } : null;
  /** " on owner/name": the repository the event was in, when the log is not that repository's own. */
  const tail = (prep: 'on' | 'in' | 'of') => {
    const r = here ? repoPart() : null;
    return r ? [` ${prep} `, r] : [];
  };
  /** The repository as the object of the sentence: a link, or "this repository" in its own log. */
  const repoObject = (): string | AuditPart =>
    here ? (repoPart() ?? e.target) : 'this repository';
  /** A pull request: "#74" in its repository's log, "owner/name#74" instance-wide. */
  const pull = (n: number | null = e.pull): AuditPart | null =>
    n === null
      ? null
      : {
          kind: 'pull',
          text: scope === 'instance' && e.repo ? `${e.repo}#${n}` : `#${n}`,
          to: e.repo ? `/${e.repo}/pull/${n}` : null,
        };
  const on = (n: number | null = e.pull) => {
    const p = pull(n);
    return p ? [' on ', p] : [];
  };
  const agent = str(d.agent);
  const agentName = agent ? agentLabel(agent, names) : null;
  const findingOf = (kind: unknown) =>
    str(kind) === 'change_requested' ? 'change request' : 'finding';
  /** "Speed's finding", or "a finding" when it names no agent. */
  const finding = () =>
    agentName
      ? `${possessive(agentName)} ${findingOf(d.kind)}`
      : `a ${findingOf(d.kind)}`;
  /** " via Claude Code": the app a person acted through (GitOrange AI is already the actor). */
  const via = () => (e.via && e.actor.kind !== 'ai' ? ` via ${e.via}` : '');
  const forPerson = () =>
    e.actor.kind === 'ai' && e.actor.login ? ` for ${e.actor.login}` : '';

  const say = (...xs: (string | AuditPart | null | false | undefined)[]) =>
    build(who, ...xs);

  switch (e.action) {
    case 'settings.changed': {
      const changes = record(d.changes);
      const labels = changes
        ? Object.keys(changes).map(
            (k) => SETTING_LABEL[k] ?? words(k).join(' ')
          )
        : [];
      return say(
        ' changed ',
        labels.length ? list(labels) : 'settings',
        ...tail('on'),
        via()
      );
    }
    case 'visibility.changed': {
      const to = str(d.to);
      return to
        ? say(' made ', repoObject(), ` ${to}`, via())
        : say(' changed the visibility of ', repoObject(), via());
    }
    case 'collaborator.added':
      return say(` added ${e.target} as a collaborator`, ...tail('on'), via());
    case 'collaborator.removed':
      return say(
        ` removed ${e.target} as a collaborator`,
        ...tail('on'),
        via()
      );
    case 'agent.invited':
      return say(
        ` invited ${agentLabel(e.target, names)} to review `,
        repoObject(),
        via()
      );
    case 'agent.removed':
      return say(
        ` removed ${agentLabel(e.target, names)} as a reviewer on `,
        repoObject(),
        via()
      );
    case 'agent.created':
      return say(
        ` created the reviewer ${str(d.name) ?? agentLabel(e.target, names)}`,
        via()
      );
    case 'agent.deleted':
      return say(` deleted the reviewer ${agentLabel(e.target, names)}`, via());
    case 'branch.deleted':
      // GitOrange deletes a branch once its pull request has landed; a person deletes one by hand.
      if (e.pull !== null)
        return say(
          ` deleted branch ${e.target} after `,
          pull(),
          ' merged',
          via()
        );
      return say(
        ` deleted branch ${e.target}`,
        d.merged === true && ' after it merged',
        ...tail('in'),
        via()
      );
    case 'branches.cleaned': {
      const branches = Array.isArray(d.branches) ? d.branches.length : null;
      const n = branches ?? (parseInt(e.target, 10) || null);
      return say(
        ' cleaned up ',
        n
          ? `${n} merged ${n === 1 ? 'branch' : 'branches'}`
          : 'merged branches',
        ...tail('in'),
        via()
      );
    }
    case 'merging.paused':
      return say(' paused merging', ...tail('on'), via());
    case 'merging.resumed':
      return say(' resumed merging', ...tail('on'), via());
    case 'pull.merged': {
      const title = str(d.title);
      const into = str(d.into);
      return say(
        ' merged ',
        pull(),
        title && ` “${title}”`,
        into && ` into ${into}`,
        via()
      );
    }
    case 'pull.reverted': {
      const next = num(d.revert) ?? num(d.revertPull) ?? num(d.number);
      return say(
        ' reverted ',
        pull(),
        next !== null && ' with ',
        next !== null && pull(next),
        via()
      );
    }
    case 'pull.approved':
      return say(' approved ', pull(), via());
    case 'finding.approved':
      return say(
        str(d.kind) === 'change_requested'
          ? ` dismissed ${finding()}`
          : ` approved ${finding()}`,
        ...on(),
        via()
      );
    case 'finding.changes_requested':
      return say(` asked for changes on ${finding()}`, ...on(), via());
    case 'finding.assigned': {
      const to = str(d.assignee);
      return to
        ? say(` assigned ${finding()}`, ...on(), ` to ${to}`, via())
        : say(` unassigned ${finding()}`, ...on(), via());
    }
    case 'finding.delegated': {
      const decision = str(d.decision);
      const what =
        decision === 'approve'
          ? str(d.kind) === 'change_requested'
            ? ` dismissed ${finding()}`
            : ` approved ${finding()}`
          : decision === 'request_changes'
            ? ` asked for changes on ${finding()}`
            : decision === 'leave'
              ? ` left ${finding()}`
              : ` answered ${finding()}`;
      return say(
        what,
        ...on(),
        forPerson(),
        decision === 'leave' && forPerson() ? ' to decide' : '',
        via()
      );
    }
    case 'finding.undone': {
      const was = str(d.via);
      return say(
        was
          ? ` undid ${possessive(was)} decision on ${finding()}`
          : ` reopened ${finding()}`,
        ...on(),
        via()
      );
    }
    case 'finding.taught':
      return say(
        agentName
          ? ` taught ${agentName} a rule from its ${findingOf(d.kind)}`
          : ' taught a reviewer a rule from a finding',
        ...on(),
        via()
      );
    case 'token.created':
      return say(` created the access token “${e.target}”`, via());
    case 'token.deleted':
      return say(` deleted the access token “${e.target}”`, via());
    case 'repository.created': {
      const visibility = str(d.visibility);
      return say(
        ' created ',
        repoObject(),
        visibility && ` (${visibility})`,
        via()
      );
    }
    case 'repository.deleted':
      return say(` deleted ${e.target}`, via());
    case 'release.created':
      return say(` released ${e.target || 'a version'}`, ...tail('of'), via());
    case 'release.updated': {
      const fields = Array.isArray(d.fields)
        ? d.fields.filter((f): f is string => f === 'title' || f === 'notes')
        : [];
      return say(
        ' edited ',
        fields.length ? `the ${list(fields)} of ` : '',
        `release ${e.target || ''}`.trimEnd(),
        ...tail('in'),
        via()
      );
    }
    case 'pull.version_bump': {
      const from = str(d.from);
      const to = str(d.to);
      if (!to) return say(' cleared the version bump', ...on(), via());
      return say(
        from
          ? ` changed the version bump from ${from} to ${to}`
          : ` set the version bump to ${to}`,
        ...on(),
        via()
      );
    }
    case 'instance.settings':
      return d.reset === true
        ? say(
            ` reset the instance setting ${settingLabel(e.target)} to its default`,
            via()
          )
        : say(` changed the instance setting ${settingLabel(e.target)}`, via());
  }

  // The pull request timeline (`pull.<kind>`), merged into the same log.
  if (e.action.startsWith('pull.')) {
    const kind = e.action.slice('pull.'.length);
    const other = num(d.pr);
    switch (kind) {
      case 'state_changed': {
        const state = str(d.state);
        return say(
          ' marked ',
          pull(),
          ` as ${(state && STATE_PHRASE[state]) ?? state ?? 'changed'}`
        );
      }
      case 'stacked':
        return say(
          ' stacked ',
          pull(),
          other !== null && ' on ',
          other !== null && pull(other)
        );
      case 'unstacked':
        return say(
          ' unstacked ',
          pull(),
          other !== null && ' from ',
          other !== null && pull(other)
        );
      case 'ordered': {
        // Recorded on the pull request that lands later (`e.pull`); `before` lands first; `for_pr` is a third
        // pull request that builds on both.
        const before = num(d.before);
        const forPr = num(d.for_pr);
        return say(
          ' set ',
          pull(),
          before !== null ? ' to land after ' : ' to land in order',
          before !== null && pull(before),
          forPr !== null && forPr !== e.pull && ', so ',
          forPr !== null && forPr !== e.pull && pull(forPr),
          forPr !== null && forPr !== e.pull && ' can build on both'
        );
      }
      case 'must_account_for':
        return say(
          ' flagged ',
          pull(),
          ' as needing to account for ',
          pull(other)
        );
      case 'accounted_for':
        return say(' marked ', pull(), ' as accounted for ', pull(other));
      case 'dismissed':
        return say(
          ' dismissed the dependency of ',
          pull(),
          other !== null && ' on ',
          other !== null && pull(other)
        );
      case 'withdrawn':
        return say(' withdrew their approval of ', pull());
      case 'learned': {
        const n = num(d.findings);
        return say(
          ' learned from ',
          n ? `${n} dismissed ${n === 1 ? 'finding' : 'findings'} on ` : '',
          pull()
        );
      }
      case 'rebased':
        return say(' rebased ', pull(), ` onto ${str(d.onto) ?? 'its base'}`);
      default:
        return say(` recorded ${words(kind).join(' ')} on `, pull());
    }
  }

  // An action this build has not heard of: still one honest sentence.
  return say(` ${words(e.action).join(' ')}`, e.target ? ` ${e.target}` : '');
}

/** One event as a sentence: "mahmoud paused merging on choyiny/gitorange". */
export function auditText(e: AuditEvent, opts: AuditOptions = {}): string {
  return auditParts(e, opts)
    .map((p) => p.text)
    .join('');
}

/** A value from a settings change, as a few words. */
function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'none';
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : 'none';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

const UNDID: Record<string, string> = {
  approved: 'an approval',
  dismissed: 'a dismissal',
  changes_requested: 'a request for changes',
};

/** The facts worth a second line (the finding, the reason, the note, what changed), or null for a plain event. */
export function auditDetail(e: AuditEvent): string | null {
  const d: Data = record(e.data) ?? {};
  const title = e.target ? `“${clip(e.target)}”` : null;
  const join = (...xs: (string | null | false)[]) => {
    const parts = xs.filter((x): x is string => !!x);
    return parts.length ? parts.join('. ') : null;
  };
  const labelled = (label: string, v: unknown) => {
    const s = str(v);
    return s ? `${label}: ${clip(s)}` : null;
  };
  switch (e.action) {
    case 'finding.approved':
      return join(title, labelled('Reason', d.reason));
    case 'finding.changes_requested':
      return join(title, labelled('Note', d.note));
    case 'finding.delegated':
      return join(title, labelled('Why', d.reason));
    case 'finding.taught':
      return join(title, labelled('Taught', d.teach));
    case 'finding.assigned':
      return join(title);
    case 'merging.paused':
      return labelled('Reason', d.reason);
    case 'finding.undone': {
      const undid = str(d.undid);
      return join(title, undid && UNDID[undid] && `Undid ${UNDID[undid]}`);
    }
    case 'settings.changed': {
      const changes = record(d.changes);
      if (!changes) return null;
      const rows = Object.entries(changes).flatMap(([k, v]) => {
        const c = record(v);
        return c
          ? [
              `${SETTING_DETAIL[k] ?? cap(words(k).join(' '))}: ${clip(show(c.from), 60)} → ${clip(show(c.to), 60)}`,
            ]
          : [];
      });
      return rows.length ? rows.join('. ') : null;
    }
    case 'branches.cleaned': {
      const branches = Array.isArray(d.branches)
        ? d.branches.filter((b): b is string => typeof b === 'string')
        : [];
      return branches.length ? clip(branches.join(', '), 240) : null;
    }
    case 'instance.settings':
      return d.reset === true || d.value === undefined
        ? null
        : `Now: ${clip(show(d.value))}`;
    case 'token.created': {
      if (!('expiresAt' in d)) return null;
      const at = num(d.expiresAt);
      return at === null
        ? 'Never expires'
        : `Expires ${new Date(at).toISOString().slice(0, 10)}`;
    }
    case 'pull.merged':
      return d.automatic === true ? 'Merged automatically' : null;
    case 'release.created': {
      const n = num(d.pulls);
      return n ? `${n} pull ${n === 1 ? 'request' : 'requests'}` : null;
    }
    case 'pull.state_changed': {
      const reasons = Array.isArray(d.reasons)
        ? d.reasons.filter(
            (r): r is { kind: string } =>
              !!r && typeof (r as { kind?: unknown }).kind === 'string'
          )
        : [];
      const text = reasons
        .filter((r) => r.kind !== 'stacked_on' && r.kind !== 'waits_on')
        .map((r) => reasonText(r))
        .join('; ');
      return text || null;
    }
    case 'pull.rebased': {
      const from = str(d.from);
      const to = str(d.to);
      return from && to ? `${from.slice(0, 7)} → ${to.slice(0, 7)}` : null;
    }
  }
  return null;
}

/** Where the event leads: its pull request or release, else its repository, else nowhere. */
export function auditLink(e: AuditEvent): string | null {
  if (!e.repo) return null;
  if (e.action.startsWith('release.') && e.target)
    return `/${e.repo}/releases/${encodeURIComponent(e.target)}`;
  return e.pull !== null ? `/${e.repo}/pull/${e.pull}` : `/${e.repo}`;
}

export type AuditCategory =
  'merging' | 'decisions' | 'access' | 'settings' | 'activity';

export const AUDIT_CATEGORIES: { id: AuditCategory; label: string }[] = [
  { id: 'merging', label: 'Merging' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'access', label: 'Access and agents' },
  { id: 'settings', label: 'Settings' },
  { id: 'activity', label: 'Pull request activity' },
];

/** The filter an action belongs to. Pull request timeline entries (and anything new) are "activity". */
export function auditCategory(action: string): AuditCategory {
  switch (action) {
    case 'pull.merged':
    case 'pull.reverted':
    case 'release.created':
    case 'release.updated':
    case 'merging.paused':
    case 'merging.resumed':
    case 'branch.deleted':
    case 'branches.cleaned':
      return 'merging';
    case 'pull.approved':
    case 'pull.dismissed':
    case 'pull.withdrawn':
    case 'finding.approved':
    case 'finding.changes_requested':
    case 'finding.assigned':
    case 'finding.delegated':
    case 'finding.undone':
    case 'finding.taught':
      return 'decisions';
    case 'collaborator.added':
    case 'collaborator.removed':
    case 'agent.invited':
    case 'agent.removed':
    case 'agent.created':
    case 'agent.deleted':
    case 'token.created':
    case 'token.deleted':
    case 'visibility.changed':
      return 'access';
    case 'settings.changed':
    case 'instance.settings':
    case 'repository.created':
    case 'repository.deleted':
      return 'settings';
    default:
      return 'activity';
  }
}
