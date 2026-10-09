/**
 * Pure rules behind the agent pages: the Agents directory (who is reviewing, what a card says), an agent's profile
 * (its overall state, its tabs, where it can be invited) and New reviewer (preset state, the crew's result).
 */
import type { AgentStatus, Tone } from './agentLook';
import type {
  Agent,
  AgentActivity,
  AgentPreset,
  AgentStats,
  CrewResult,
  Lesson,
  LessonStatus,
  Repo,
} from './uiApi';

/** Most pressing first: what blocks a merge, then what is in progress, then what is done. Same order as the API's. */
const PRESSING: AgentActivity[] = [
  'failed',
  'changes_requested',
  'flagged',
  'reviewing',
  'approved',
];

/** What an agent is doing across its repositories: the most pressing status among them; `idle` when none. */
export function overallStatus(
  repos: readonly { status: AgentActivity }[]
): AgentActivity {
  let best = -1;
  for (const r of repos) {
    const rank = PRESSING.indexOf(r.status);
    if (rank >= 0 && (best < 0 || rank < best)) best = rank;
  }
  return best < 0 ? 'idle' : PRESSING[best];
}

/**
 * The status its avatar and chip show: asleep (`off`) once deleted or when it is not on any repository, otherwise
 * what it is doing now.
 */
export function avatarStatusOf(o: {
  deleted?: boolean;
  /** The repositories it is invited to that you can see. */
  repos: number;
  status: AgentActivity;
}): AgentStatus {
  return o.deleted || o.repos === 0 ? 'off' : o.status;
}

export interface DirectoryGroups {
  /** Invited to a repository you can see. */
  reviewing: Agent[];
  /** Created, but not on any repository you can see. */
  available: Agent[];
}

/**
 * Splits the agents by whether they review something you can see. An agent whose record could not be read has no
 * known repositories: it stays with the reviewers, so nothing is hidden because a request failed.
 */
export function groupAgents(
  agents: readonly Agent[],
  stats: ReadonlyMap<string, AgentStats | undefined>
): DirectoryGroups {
  const groups: DirectoryGroups = { reviewing: [], available: [] };
  for (const a of agents) {
    const s = stats.get(a.username);
    (s && s.repos.length === 0 ? groups.available : groups.reviewing).push(a);
  }
  return groups;
}

/** The three numbers on a card: raised, the share a person kept, and the rules it learned. */
export function cardStats(
  s: AgentStats | undefined
): { value: string; label: string }[] {
  if (!s)
    return [
      { value: '—', label: 'raised' },
      { value: '—', label: 'kept' },
      { value: '—', label: 'rules' },
    ];
  return [
    { value: String(s.raised), label: 'raised' },
    { value: s.keptPct === null ? '—' : `${s.keptPct}%`, label: 'kept' },
    { value: String(s.rules), label: s.rules === 1 ? 'rule' : 'rules' },
  ];
}

/** Where a card says the agent works. */
export function whereText(s: AgentStats | undefined): string {
  if (!s) return 'Record unavailable';
  if (s.repos.length === 0) return 'Add it to a repository from its profile';
  if (s.repos.length === 1) return `Reviews ${s.repos[0].repo}`;
  return `Reviews ${s.repos.length} repositories`;
}

export const PROFILE_TABS = ['overview', 'reviews', 'rules', 'config'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** The tab named in `?tab=`; the overview for anything else. */
export function parseProfileTab(value: string | null): ProfileTab {
  return (PROFILE_TABS as readonly string[]).includes(value ?? '')
    ? (value as ProfileTab)
    : 'overview';
}

/**
 * The repositories a person can offer to add an agent to: those it is not on yet, other than agents' own
 * instruction repositories. A site admin may add it anywhere; anyone else on the repositories they own (the
 * server decides in the end: it answers 403 where they are no admin, and a team repository's admins use its
 * settings).
 */
export function inviteChoices(
  repos: readonly Repo[],
  o: {
    /** `owner/name` of each repository the agent is already on. */
    invited: readonly string[];
    /** `owner/name` of the agents' own repositories. */
    agentRepos: readonly (string | null)[];
    me: { id: string; role?: string } | null;
  }
): Repo[] {
  if (!o.me) return [];
  const skip = new Set(
    [...o.invited, ...o.agentRepos]
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase())
  );
  const mine = (r: Repo) =>
    o.me!.role === 'admin' ||
    (r.ownerType === 'user' && r.owner.id === o.me!.id);
  return repos
    .filter((r) => !skip.has(r.fullName.toLowerCase()) && mine(r))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

const percent = (above: number) => Math.round(above * 100);

/** "Wakes when Clef is 40% sure" */
export function wakeText(trigger: { above: number; ask?: string }): string {
  return `Wakes when Clef is ${percent(trigger.above)}% sure`;
}

/** "At least 40% sure that the answer is yes": the threshold, for the settings. */
export function thresholdText(trigger: {
  above: number;
  ask?: string;
}): string {
  return `At least ${percent(trigger.above)}% sure that the answer is yes`;
}

export function engineText(engine: 'pass' | 'pi'): string {
  return engine === 'pi'
    ? 'A Pi agent that reads the repository with read-only tools'
    : 'One reasoning-model pass per review';
}

/** "Security, Data and Speed" */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What "Add the recommended crew" did: who was added (null when nobody) and each one skipped, with the reason. */
export function crewResultText(r: CrewResult): {
  added: string | null;
  skipped: string[];
} {
  return {
    added: r.created.length
      ? `Added ${listNames(r.created.map((a) => a.name))}.`
      : null,
    skipped: r.skipped.map((s) => `@${s.handle}: ${s.reason}`),
  };
}

/** Why a handle can't be used, in plain words (the server has the last word); null when it looks fine. */
export function handleProblem(handle: string): string | null {
  if (!handle) return 'Give the agent a handle.';
  if (handle.length > 39) return 'A handle can be at most 39 characters.';
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/.test(handle))
    return 'Use letters, numbers and single hyphens only.';
  return null;
}

export type PresetState = 'create' | 'created' | 'taken';

/**
 * Whether a preset can be created. `exists` means its handle is taken: by an agent (it is created) or by
 * someone else (it can't be).
 */
export function presetState(
  preset: AgentPreset,
  agentHandles: ReadonlySet<string>
): PresetState {
  if (!preset.exists) return 'create';
  return agentHandles.has(preset.handle.toLowerCase()) ? 'created' : 'taken';
}

/** Lessons that became a rule in the agent's repository. */
export function ruleCount(lessons: readonly Pick<Lesson, 'status'>[]): number {
  return lessons.filter((l) => l.status === 'committed').length;
}

const LESSON_TONE: Record<LessonStatus, Tone> = {
  pending: 'off',
  learning: 'info',
  committed: 'good',
  nothing: 'off',
  failed: 'critical',
};

/** The chip tone for a lesson's status. */
export const lessonTone = (status: LessonStatus): Tone => LESSON_TONE[status];
