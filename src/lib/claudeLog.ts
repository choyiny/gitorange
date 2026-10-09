/**
 * Sentences for GitOrange AI's answers ("Let Claude decide", shown as Claude) and for one finding's history.
 * A small local stand-in until the shared audit sentences (`auditText.ts`, crew redesign C12) land; the final
 * review may fold these into it.
 */
import { withVia } from './via';
import type { AuditEvent, DelegatedEvent, PersonRef } from './uiApi';

/** How GitOrange AI's decisions are recorded (`decidedVia`, `audit.via`). */
export const AI_VIA = 'GitOrange AI';
/** What the interface calls GitOrange AI. */
export const AI_NAME = 'Claude';

export const isAiVia = (via: string | null | undefined) => via === AI_VIA;

/** "Data’s", "Features’". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

/** The time of day an event happened, as "09:05" (the viewer's clock). */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line of "What Claude did today". */
export function delegatedText(e: DelegatedEvent, agentName: string): string {
  const whose = possessive(agentName);
  const pr = `#${e.pull ?? '?'}`;
  switch (e.data.decision) {
    case 'approve':
      return `${AI_NAME} approved ${whose} finding on ${pr}`;
    case 'request_changes':
      return `${AI_NAME} requested changes on ${pr} for ${whose} finding`;
    default:
      return `${AI_NAME} left ${whose} finding on ${pr} for you`;
  }
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A person as the sentence names them: "you", their name, or @login. */
function named(
  p: { login: string | null; name: string | null } | null,
  me: string | null
): string {
  if (!p || (!p.login && !p.name)) return 'someone';
  if (same(p.login, me)) return 'you';
  return p.name || `@${p.login}`;
}

/** Who made a decision: "you", "Cho", "Cho via Claude Mod", or "Claude for you". */
export function decidedByText(
  by: PersonRef | null,
  via: string | null,
  me: string | null
): string {
  const who = named(by, me);
  if (isAiVia(via)) return `${AI_NAME} for ${who}`;
  return withVia(who, via);
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const sentence = (t: string) => (/[.!?”"]$/.test(t) ? t : `${t}.`);
const str = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const UNDID: Record<string, string> = {
  approved: 'approval',
  dismissed: 'dismissal',
  changes_requested: 'request for changes',
};

/** One entry of a finding's history, as a sentence. */
export function findingEventText(
  e: AuditEvent,
  ctx: { me: string | null; agentName: string }
): string {
  const actor =
    e.actor.kind === 'system' ? 'GitOrange' : capital(named(e.actor, ctx.me));
  const who = isAiVia(e.via) ? actor : withVia(actor, e.via);
  const forWhom = named(e.actor, ctx.me);
  const d = e.data;
  switch (e.action) {
    case 'finding.approved': {
      const reason = str(d.reason);
      const verb = d.kind === 'change_requested' ? 'dismissed' : 'approved';
      return sentence(
        `${who} ${verb} it${reason ? `. Reason: ${reason}` : ''}`
      );
    }
    case 'finding.changes_requested': {
      const note = str(d.note);
      return note
        ? `${who} requested changes: “${note}”`
        : `${who} requested changes.`;
    }
    case 'finding.assigned': {
      const to = str(d.assignee);
      if (!to) return `${who} took the question back.`;
      return `${who} asked ${same(to, ctx.me) ? 'you' : `@${to}`} to decide.`;
    }
    case 'finding.delegated': {
      const reason = str(d.reason);
      const what =
        d.decision === 'approve'
          ? `${AI_NAME} approved it for ${forWhom}`
          : d.decision === 'request_changes'
            ? `${AI_NAME} requested changes for ${forWhom}`
            : `${AI_NAME} left it for ${forWhom}`;
      return sentence(reason ? `${what}: ${reason}` : what);
    }
    case 'finding.undone': {
      const thing = UNDID[String(d.undid)] ?? 'decision';
      return isAiVia(str(d.via))
        ? `${who} undid ${possessive(AI_NAME)} ${thing}.`
        : `${who} undid the ${thing}.`;
    }
    case 'finding.taught': {
      const teach = str(d.teach);
      return teach
        ? `${who} taught ${ctx.agentName}: “${teach}”`
        : `${who} taught ${ctx.agentName}.`;
    }
    default:
      return sentence(`${who}: ${e.action}`);
  }
}
