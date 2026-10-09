/** Finding fixtures: a reviewed pull request with an owner question, guarded agents, flag rows, audit rows, a fake decider. */
import type { AgentReview } from '../../review/contract';
import type { DelegateInput, DelegateModel } from '../../review/delegate';
import { call, settle, type TestEnv } from './app';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  flags,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './reviews';

export const QUESTION = 'Were all your invoices so far in Canadian dollars?';

/** A finding for a person carrying an owner question, then a change request. */
export const QUESTIONED: AgentReview = {
  verdict: 'findings',
  summary: 'Two concerns.',
  findings: [
    {
      kind: 'needs_person',
      title: 'Invoice currency',
      detail: 'Existing invoices would be marked Canadian dollars.',
      question: QUESTION,
      changes: [],
      diagram: null,
      snippets: [],
      paths: ['src/b.ts'],
    },
    {
      kind: 'change_requested',
      title: 'Name it',
      detail: 'Rename b to invoiceCurrency.',
      question: null,
      changes: [],
      diagram: null,
      snippets: [],
      paths: ['src/b.ts'],
    },
  ],
};

/** Only the finding for a person: deciding it clears review, so the pull request auto-merges. */
export const ONLY_QUESTION: AgentReview = {
  ...QUESTIONED,
  findings: [QUESTIONED.findings[0]],
};

/** Makes agent `handle` guarded, as a Security or Data agent is. */
export async function guard(t: TestEnv, handle: string) {
  await t.env.DB.prepare(
    `UPDATE agents SET guarded = 1, facet = 'security'
      WHERE user_id = (SELECT id FROM users WHERE username = ?)`
  )
    .bind(handle)
    .run();
}

/**
 * octocat/app#1 (opened by octocat), reviewed by @`handle` answering `review` (QUESTIONED): its first two findings, in
 * order. `beforeReview` runs once the pull request is open; `delegate` is the decider the review's Workflow uses.
 */
export async function questionedPull(
  o: {
    handle?: string;
    guarded?: boolean;
    review?: AgentReview;
    beforeReview?: (s: { t: TestEnv; admin: string }) => Promise<void>;
    delegate?: DelegateModel | null;
  } = {}
) {
  const { t, admin, repo } = await appRepo();
  const handle = o.handle ?? 'dataagent';
  await invitedAgent(t, admin, handle, AGENT_MD({ name: 'Data' }));
  // The name its AGENT.md gives it (a refresh would cache it; the fixture's commit skips the push).
  await t.env.DB.prepare(
    `UPDATE agents SET name = 'Data'
      WHERE user_id = (SELECT id FROM users WHERE username = ?)`
  )
    .bind(handle)
    .run();
  if (o.guarded) await guard(t, handle);
  const { head } = await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
  await o.beforeReview?.({ t, admin });
  await startReview(t);
  await runReviews(
    t,
    agentModels({ review: () => o.review ?? QUESTIONED }).models,
    { delegate: o.delegate }
  );
  await settle(t);
  const [person, change] = await flags(t);
  return { t, admin, repo, head, person, change, handle };
}

export const flagPath = (id: string, verb: string, number = 1) =>
  `/api/repos/octocat/app/pulls/${number}/review/flags/${id}/${verb}`;

/** POSTs to a flag route as `cookie`; settles the work it handed off. */
export async function flagCall(
  t: TestEnv,
  cookie: string,
  id: string,
  verb: string,
  json?: unknown
) {
  const res = await call(t, flagPath(id, verb), {
    cookie,
    method: 'POST',
    json,
  });
  await settle(t);
  return res;
}

export type FlagState = {
  id: string;
  kind: string;
  question: string | null;
  approved_by_id: string | null;
  approved_at: number | null;
  approved_via: string | null;
  changes_requested_by_id: string | null;
  changes_requested_at: number | null;
  changes_requested_note: string | null;
  assignee_id: string | null;
  assigned_by_id: string | null;
  assigned_at: number | null;
  decision_reason: string | null;
  teach_note: string | null;
  teach_by_id: string | null;
};

export const flagState = (t: TestEnv, id: string) =>
  t.env.DB.prepare('SELECT * FROM pr_review_flags WHERE id = ?')
    .bind(id)
    .first<FlagState>();

export const userId = async (t: TestEnv, username = 'octocat') =>
  (await t.env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string }>())!.id;

export type AuditRow = {
  action: string;
  actor_kind: string;
  actor: string | null;
  via: string | null;
  target: string;
  data: Record<string, unknown>;
  created_at: number;
};

/** Every finding.* audit row, oldest first. */
export async function findingAudit(t: TestEnv): Promise<AuditRow[]> {
  return (
    await t.env.DB.prepare(
      `SELECT e.action, e.actor_kind, u.username AS actor, e.via, e.target, e.data, e.created_at
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.action LIKE 'finding.%'
        ORDER BY e.created_at, e.rowid`
    ).all<Omit<AuditRow, 'data'> & { data: string }>()
  ).results.map((r) => ({
    ...r,
    data: JSON.parse(r.data) as Record<string, unknown>,
  }));
}

/** Grants `username` push rights on octocat/app. */
export async function collaborate(t: TestEnv, admin: string, username: string) {
  const res = await call(
    t,
    `/api/repos/octocat/app/collaborators/${username}`,
    {
      cookie: admin,
      method: 'PUT',
    }
  );
  if (res.status !== 200)
    throw new Error(`collaborator failed: ${res.status} ${await res.text()}`);
}

/** A scripted decider: `answer(input)` is its raw reply (objects are sent as JSON); every input is kept. */
export function fakeDecider(
  answer: (input: DelegateInput) => unknown = () => ({
    decision: 'approve',
    reason: 'The change is intended and low risk.',
  })
) {
  const calls: DelegateInput[] = [];
  const model: DelegateModel = {
    id: '@cf/test/decider',
    async decide(input) {
      calls.push(input);
      const a = await answer(input);
      return typeof a === 'string' ? a : JSON.stringify(a);
    },
  };
  return { model, calls };
}
