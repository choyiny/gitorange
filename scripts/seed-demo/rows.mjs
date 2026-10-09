// The database rows the demo seed writes directly (the API cannot): backdating, provenance, reviews and findings,
// test runs, lessons and a few timeline entries. Each function returns SQL statements for local D1; times come from
// the clock, so history always ends "just now".
//
// Timestamp units follow the schema: `mode: 'timestamp'` columns are epoch seconds, `timestamp_ms` ones milliseconds.

import { q } from './lib.mjs';
import {
  AGENTS_ADDED,
  FAILED_PUSH_RUN,
  INVITED,
  LESSONS,
  REBASE_RUNS,
  REPO,
  TEAMMATE,
} from './history.mjs';

export const SUMMARY_MODEL = '@cf/zai-org/glm-5.3-flash';
export const CLASSIFIER_MODEL = '@cf/cloudflare/clef';
export const REVIEW_MODEL = '@cf/zai-org/glm-5.3';
export const AI_VIA = 'GitOrange AI';
export const WORKFLOW = { path: '.github/workflows/test.yml', name: 'Tests' };

/** A small stable number from text, so a fabricated detail (a probability, a duration) never changes between runs. */
const hash = (text) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};

// ── Per-pull-request facts that need the git history ─────────────────────────

/** `{ path, status, additions, deletions, summary }` for every file the pull request changes, as a review lists them. */
export function fileSummaries(git, base, head, summaries) {
  const status = new Map(
    git
      .run(['diff', '--name-status', base, head])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, file] = line.split('\t');
        return [
          file,
          code === 'A' ? 'added' : code === 'D' ? 'removed' : 'modified',
        ];
      })
  );
  return git
    .run(['diff', '--numstat', base, head])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, file] = line.split('\t');
      return {
        path: file,
        status: status.get(file) ?? 'modified',
        additions: Number(added),
        deletions: Number(deleted),
        summary: summaries[file] ?? `Changes ${file}.`,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The new-side line numbers a diff adds. */
function addedLines(diff) {
  const added = new Set();
  let line = 0;
  for (const text of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!line || text.startsWith('---') || text.startsWith('+++')) continue;
    if (text.startsWith('+')) added.add(line++);
    else if (!text.startsWith('-')) line++;
  }
  return added;
}

/** A finding's comment body: its sentence, a before and after table, and an excerpt from the real diff. */
export function findingDetail(git, base, head, flag) {
  const parts = [flag.detail];
  if (flag.changes?.length)
    parts.push(
      [
        '| | Before | After |',
        '|---|---|---|',
        ...flag.changes.map(
          ([what, before, after]) =>
            `| **${what}** | ${before || '—'} | ${after || '—'} |`
        ),
      ].join('\n')
    );
  const s = flag.snippet;
  if (s) {
    const text = git.show(head, s.path);
    if (text !== null) {
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.includes(s.find));
      if (at >= 0) {
        const start = at + 1;
        const end = Math.min(start + s.lines - 1, lines.length);
        const added = addedLines(
          git.run(['diff', '-U0', base, head, '--', s.path])
        );
        const body = lines
          .slice(at, end)
          .map((l, i) => `${added.has(start + i) ? '+' : ' '}${l}`)
          .join('\n');
        parts.push(
          `<details><summary><code>${s.path}</code> lines ${start}–${end}: ${s.why}</summary>\n\n\`\`\`diff\n${body}\n\`\`\`\n\n</details>`
        );
      }
    }
  }
  return parts.join('\n\n');
}

// ── Backdating and provenance ────────────────────────────────────────────────

/**
 * Provenance (which app opened each pull request, in which session, at whose request), real dates for everything the
 * seed created through the API a moment ago, and who merged what: some landings are marked as GitOrange's own.
 */
export function historyStatements(ctx) {
  const { clock, repoId, prs } = ctx;
  const out = [];
  const audit = (action, target, ms) =>
    `UPDATE audit_events SET created_at = ${ms} WHERE repository_id = ${q(repoId)} AND action = ${q(action)} AND target = ${q(target)}`;

  // The repository and its collaborator (both made by this run).
  const created = clock.at(REPO.createdAt);
  out.push(
    `UPDATE repositories SET created_at = ${created} WHERE id = ${q(repoId)}`,
    audit('repository.created', ctx.repoFull, created * 1000),
    audit('collaborator.added', TEAMMATE.username, (created + 60) * 1000)
  );

  // Only what this run created is backdated (`ctx.created`): a teammate, agents or tokens that were already there are
  // somebody's own data and keep their dates.
  const made = ctx.created;
  const recent = clock.now * 1000 - 86_400_000;
  if (made.cho)
    out.push(
      `UPDATE users SET created_at = ${clock.ms(TEAMMATE.joinedAt)}, updated_at = ${clock.ms(TEAMMATE.joinedAt)} WHERE username = ${q(TEAMMATE.username)}`,
      `UPDATE invitations SET created_at = ${clock.at(TEAMMATE.joinedAt) - 600}, accepted_at = ${clock.at(TEAMMATE.joinedAt)} WHERE id = (SELECT id FROM invitations WHERE email = ${q(TEAMMATE.email)} ORDER BY created_at DESC LIMIT 1)`
    );
  // The access token used to push the history (deleted again once it was done).
  if (made.tokenId) {
    const token = `json_extract(data, '$.token') = ${q(made.tokenId)}`;
    out.push(
      `UPDATE audit_events SET created_at = ${(created + 120) * 1000} WHERE action = 'token.created' AND ${token}`,
      `UPDATE audit_events SET created_at = ${(created + 130) * 1000} WHERE action = 'token.deleted' AND ${token}`
    );
  }

  // The crew this run created: created and invited before the first pull request was reviewed.
  const added = clock.at(AGENTS_ADDED);
  if (made.agents.length) {
    const ids = made.agents.map((a) => q(a.id)).join(', ');
    const handles = made.agents.map((a) => q(a.handle)).join(', ');
    out.push(
      `UPDATE users SET created_at = ${added * 1000 - 120_000}, updated_at = ${added * 1000 - 120_000} WHERE id IN (${ids})`,
      `UPDATE agents SET created_at = ${added - 120} WHERE user_id IN (${ids})`,
      `UPDATE repositories SET created_at = ${added - 120} WHERE id IN (SELECT repository_id FROM agents WHERE user_id IN (${ids}) AND repository_id IS NOT NULL)`,
      `UPDATE audit_events SET created_at = ${added * 1000 - 120_000} + (rowid % 60) * 1000 WHERE action = 'agent.created' AND repository_id IS NULL AND target IN (${handles}) AND created_at > ${recent}`
    );
  }
  out.push(
    `UPDATE repository_agents SET created_at = ${added} WHERE repository_id = ${q(repoId)}`,
    `UPDATE audit_events SET created_at = ${added * 1000} + (rowid % 60) * 1000 WHERE action = 'agent.invited' AND repository_id = ${q(repoId)}`
  );

  for (const pr of prs) {
    const s = pr.spec;
    const opened = clock.at(s.openedAt);
    const provenance = `created_via = ${q(s.via)}, session_label = ${q(s.session)}, request = ${q(s.request)}`;
    if (pr.kind === 'merged') {
      const approved = clock.at(s.approvedAt);
      const merged = clock.at(s.mergedAt);
      out.push(
        `UPDATE pull_requests SET ${provenance}, created_at = ${opened}, updated_at = ${merged}, merged_at = ${merged}, closed_at = ${merged}, merged_automatically = ${s.auto ? 1 : 0}${s.auto ? ', merged_by_id = NULL' : ''} WHERE id = ${q(pr.id)}`,
        `UPDATE pr_approvals SET created_at = ${approved} WHERE pull_request_id = ${q(pr.id)}`,
        audit('pull.approved', `#${pr.number}`, approved * 1000),
        audit('pull.merged', `#${pr.number}`, merged * 1000),
        audit('branch.deleted', s.branch, merged * 1000 + 2000)
      );
      if (s.auto)
        out.push(
          `UPDATE audit_events SET actor_id = NULL, actor_kind = 'system', data = json_set(data, '$.automatic', json('true')) WHERE repository_id = ${q(repoId)} AND action = 'pull.merged' AND target = ${q(`#${pr.number}`)}`
        );
    } else {
      const updated = clock.at(s.updatedAt ?? s.openedAt);
      out.push(
        `UPDATE pull_requests SET ${provenance}, created_at = ${opened}, updated_at = ${updated}${s.autoMergeOff ? `, auto_merge_disabled_at = ${updated}` : ''} WHERE id = ${q(pr.id)}`
      );
    }
    // Everything the timeline recorded so far happened when the pull request opened.
    out.push(
      `UPDATE pr_events SET created_at = ${opened * 1000 + 60_000}, computed_at = ${opened * 1000 + 60_000} WHERE pull_request_id = ${q(pr.id)}`
    );
  }
  const last = Math.max(
    ...prs.map((p) =>
      clock.at(p.spec.updatedAt ?? p.spec.mergedAt ?? p.spec.openedAt)
    )
  );
  out.push(
    `UPDATE repositories SET updated_at = ${last} WHERE id = ${q(repoId)}`
  );
  return out;
}

// ── Reviews, findings and what was decided ───────────────────────────────────

/**
 * One review per pull request head: a classification with the one-liners, a reviewer row for every invited agent (Clef
 * asked some, left the rest `not_needed`), and each finding with the decision made on it. The agents did not really
 * run; these rows are what they would have written.
 */
export function reviewStatements(ctx) {
  const { clock, repoId, prs, people, agents } = ctx;
  const out = [
    `DELETE FROM pr_classifications WHERE pull_request_id IN (SELECT id FROM pull_requests WHERE repository_id = ${q(repoId)})`,
    `DELETE FROM pr_reviewers WHERE pull_request_id IN (SELECT id FROM pull_requests WHERE repository_id = ${q(repoId)})`,
  ];
  const personId = (who) => people[who].id;

  for (const pr of prs) {
    const { review } = pr.spec;
    const reviewAt = clock.at(review.at);
    const finished =
      review.durationMs === null
        ? null
        : reviewAt + Math.ceil(review.durationMs / 1000);
    const classification = `${pr.id}-${pr.headSha}`;
    out.push(
      `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model, files, error_message, duration_ms, created_at, finished_at)
       VALUES (${q(classification)}, ${q(pr.id)}, ${q(pr.headSha)}, ${q(review.status ?? 'done')}, ${q(SUMMARY_MODEL)}, ${q(CLASSIFIER_MODEL)}, ${q(pr.files)}, NULL, ${q(review.durationMs)}, ${reviewAt}, ${q(finished)})`
    );

    for (const handle of INVITED) {
      const agent = agents.get(handle);
      if (!agent) continue;
      const spec = review.agents.find((a) => a.agent === handle);
      const status = spec?.status ?? 'not_needed';
      const requested = Boolean(spec);
      const probability = spec
        ? spec.p
        : Math.round(
            (0.03 + (hash(`${pr.number}:${handle}`) % 16) / 100) * 100
          ) / 100;
      let reviewerDone;
      if (status === 'reviewing') reviewerDone = null;
      else if (!requested) reviewerDone = reviewAt + 5;
      else {
        reviewerDone = reviewAt + 8 + (hash(`${pr.number}${handle}`) % 26);
        if (finished !== null)
          reviewerDone = Math.min(reviewerDone, finished - 1);
      }
      out.push(
        `INSERT INTO pr_reviewers (id, pull_request_id, head_sha, agent_id, probability, requested, agent_sha, status, summary, error, created_at, finished_at)
         VALUES (${q(`seed-rv-${pr.number}-${handle}`)}, ${q(pr.id)}, ${q(pr.headSha)}, ${q(agent.id)}, ${probability}, ${requested ? 1 : 0}, ${q(agent.sha)}, ${q(status)}, ${q(spec?.summary ?? null)}, NULL, ${reviewAt}, ${q(reviewerDone)})`
      );

      (spec?.flags ?? []).forEach((flag, i) => {
        const id = `seed-flag-${pr.number}-${handle}-${i}`;
        pr.flagIds.push({ id, handle, flag, index: i });
        const d = flag.decision;
        const decided = d ? clock.at(d.at) : null;
        const approved = d && (d.kind === 'approve' || d.kind === 'dismiss');
        out.push(
          `INSERT INTO pr_review_flags (id, classification_id, key, value, paths, detail, detail_model, approved_by_id, approved_at, approved_via, agent_id, kind, agent_sha, question, assignee_id, assigned_by_id, assigned_at, decision_reason, teach_note, teach_by_id, created_at)
           VALUES (${q(id)}, ${q(classification)}, ${q(`${agent.id}:${i}`)}, ${q({ title: flag.title })}, ${q(flag.paths)}, ${q(pr.detailFor(flag))}, ${q(REVIEW_MODEL)}, ${approved ? q(personId(d.by)) : 'NULL'}, ${q(decided)}, ${q(d?.via ?? null)}, ${q(agent.id)}, ${q(flag.kind)}, ${q(agent.sha)}, ${q(flag.question ?? null)}, ${flag.assignee ? q(personId(flag.assignee)) : 'NULL'}, ${flag.assignedBy ? q(personId(flag.assignedBy)) : 'NULL'}, ${flag.assignedAt ? clock.at(flag.assignedAt) : 'NULL'}, ${q(d?.reason ?? null)}, ${q(d?.teach ?? null)}, ${d?.teach ? q(personId(d.by)) : 'NULL'}, ${reviewerDone ?? reviewAt})`
        );

        const about = { finding: id, kind: flag.kind, agent: handle };
        const event = (e) =>
          `INSERT INTO audit_events (id, repository_id, actor_id, actor_kind, via, action, target, data, created_at)
           VALUES (${q(e.id)}, ${q(repoId)}, ${q(e.actorId)}, ${q(e.kind ?? 'person')}, ${q(e.via ?? null)}, ${q(e.action)}, ${q(flag.title)}, ${q({ ...e.data, pull: pr.number })}, ${e.ms})`;
        if (flag.assignee)
          out.push(
            event({
              id: `seed-audit-${id}-assigned`,
              actorId: personId(flag.assignedBy),
              action: 'finding.assigned',
              data: { ...about, assignee: people[flag.assignee].username },
              ms: clock.ms(flag.assignedAt),
            })
          );
        if (d && d.via === AI_VIA)
          out.push(
            event({
              id: `seed-audit-${id}-delegated`,
              actorId: personId(d.by),
              kind: 'ai',
              via: AI_VIA,
              action: 'finding.delegated',
              data: { ...about, decision: 'approve', reason: d.reason },
              ms: decided * 1000,
            })
          );
        else if (d)
          out.push(
            event({
              id: `seed-audit-${id}-approved`,
              actorId: personId(d.by),
              action: 'finding.approved',
              data: { ...about, ...(d.reason ? { reason: d.reason } : {}) },
              ms: decided * 1000,
            })
          );
        if (d?.teach)
          out.push(
            event({
              id: `seed-audit-${id}-taught`,
              actorId: personId(d.by),
              action: 'finding.taught',
              data: { ...about, teach: d.teach },
              ms: decided * 1000 + 1000,
            })
          );
      });
    }
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const STEP_NAMES = [
  'Run actions/checkout@v4',
  'Run actions/setup-node@v4',
  'Install dependencies',
  'Run the tests',
];

/**
 * Tests on main and on pull requests. Containers don't run locally, so the real runs a landing queues are replaced
 * by these: passing runs on main (one failing landing last week, then a passing re-run), a passing run on every pull
 * request, and one still running.
 */
export function runStatements(ctx) {
  const { clock, repoId, prs, people, baseTip } = ctx;
  const runs = [];
  runs.push({
    event: 'push',
    ref: 'refs/heads/main',
    sha: baseTip.sha,
    at: baseTip.at + 20,
    actor: 'admin',
    title: baseTip.subject,
    result: 'success',
  });
  for (const pr of prs.filter((p) => p.kind === 'merged')) {
    const merged = clock.at(pr.spec.mergedAt);
    const failed = pr.spec.branch === FAILED_PUSH_RUN;
    const actor = pr.spec.merger;
    runs.push({
      event: 'push',
      ref: 'refs/heads/main',
      sha: pr.mergeSha,
      at: merged + 20,
      actor,
      title: pr.spec.commits.at(-1).message,
      result: failed ? 'failure' : 'success',
    });
    if (failed)
      runs.push({
        event: 'push',
        ref: 'refs/heads/main',
        sha: pr.mergeSha,
        at: merged + 20 * 60,
        actor,
        title: pr.spec.commits.at(-1).message,
        result: 'success',
      });
    runs.push({
      event: 'pull_request',
      ref: `refs/pull/${pr.number}/head`,
      sha: pr.headSha,
      at: clock.at(pr.spec.openedAt) + 30,
      actor: pr.spec.author,
      title: pr.spec.title,
      result: 'success',
    });
  }
  for (const pr of prs.filter((p) => p.kind === 'open')) {
    const at = clock.at(pr.spec.openedAt) + 30;
    runs.push({
      event: 'pull_request',
      ref: `refs/pull/${pr.number}/head`,
      sha: pr.headSha,
      at: pr.spec.check === 'running' ? clock.now - 7 * 60 : at,
      actor: pr.spec.author,
      title: pr.spec.title,
      result: pr.spec.check === 'running' ? 'running' : 'success',
    });
  }
  runs.sort((a, b) => a.at - b.at);

  const out = [
    // The real runs (and the runner sessions they started) are replaced by the ones below.
    `DELETE FROM workflow_steps WHERE job_id IN (SELECT j.id FROM workflow_jobs j JOIN workflow_runs r ON r.id = j.run_id WHERE r.repository_id = ${q(repoId)} AND r.id NOT LIKE 'seed-%')`,
    `DELETE FROM workflow_jobs WHERE run_id IN (SELECT id FROM workflow_runs WHERE repository_id = ${q(repoId)} AND id NOT LIKE 'seed-%')`,
    `DELETE FROM workflow_runs WHERE repository_id = ${q(repoId)} AND id NOT LIKE 'seed-%'`,
    `DELETE FROM runner_sessions WHERE repository_id = ${q(repoId)}`,
  ];
  runs.forEach((run, i) => {
    const n = i + 1;
    const id = `seed-run-${n}`;
    const jobId = `seed-job-${n}`;
    const seconds = 62 + (hash(`${n}:${run.sha}`) % 40);
    const started = run.at + 8;
    const running = run.result === 'running';
    const done = running ? null : started + seconds;
    const conclusion = running ? null : run.result;
    const stepAt = (k) => started + Math.round((seconds * k) / 4);
    out.push(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, actor_id, status, conclusion, error_message, created_at, started_at, completed_at)
       VALUES (${q(id)}, ${q(repoId)}, ${n}, ${q(WORKFLOW.path)}, ${q(WORKFLOW.name)}, ${q(run.event)}, ${q(run.ref)}, ${q(run.sha)}, ${q(run.title)}, ${q(people[run.actor].id)}, ${q(running ? 'in_progress' : 'completed')}, ${q(conclusion)}, NULL, ${run.at}, ${started}, ${q(done)})`,
      `INSERT INTO workflow_jobs (id, run_id, job_key, name, runs_on, needs, matrix_values, status, conclusion, started_at, completed_at)
       VALUES (${q(jobId)}, ${q(id)}, 'test', 'test', 'ubuntu-latest', '[]', NULL, ${q(running ? 'in_progress' : 'completed')}, ${q(conclusion)}, ${started}, ${q(done)})`
    );
    STEP_NAMES.forEach((name, k) => {
      const last = k === STEP_NAMES.length - 1;
      const state = running
        ? k < 2
          ? 'done'
          : k === 2
            ? 'running'
            : 'queued'
        : 'done';
      const stepResult =
        state === 'done'
          ? last && run.result === 'failure'
            ? 'failure'
            : 'success'
          : null;
      out.push(
        `INSERT INTO workflow_steps (id, job_id, number, name, status, conclusion, started_at, completed_at, log_r2_key)
         VALUES (${q(`seed-step-${n}-${k + 1}`)}, ${q(jobId)}, ${k + 1}, ${q(name)}, ${q(state === 'done' ? 'completed' : state === 'running' ? 'in_progress' : 'queued')}, ${q(stepResult)}, ${state === 'queued' ? 'NULL' : stepAt(k)}, ${state === 'done' ? stepAt(k + 1) : 'NULL'}, NULL)`
      );
    });
  });
  return out;
}

// ── Everything else ──────────────────────────────────────────────────────────

/** The stack (the PDF pull request builds on the US dollar one), a delegation, learned rules and Fixer's attempts. */
export function extraStatements(ctx) {
  const { clock, repoId, prs, people, agents } = ctx;
  const out = [];
  const byBranch = new Map(prs.map((p) => [p.spec.branch, p]));

  // Stack: the PDF pull request builds on the US dollar one, and every other pair of open pull requests is checked and
  // independent (a pull request with no checked pair would read "checking how it relates to others"). Discovery's own
  // rows (AI, in the dev environment) are replaced so the demo does not depend on what a model decided.
  const open = prs.filter((p) => p.kind === 'open');
  out.push(`DELETE FROM pr_edges WHERE repository_id = ${q(repoId)}`);
  for (const pr of open) {
    const parent = pr.spec.stackedOn
      ? open.find((p) => p.spec.key === pr.spec.stackedOn)
      : null;
    out.push(
      `UPDATE pull_requests SET base_ref = ${q(parent ? parent.spec.branch : 'main')}, land_target = 'main' WHERE id = ${q(pr.id)}`
    );
  }
  const now = clock.now;
  const byNumber = [...open].sort((x, y) => x.number - y.number);
  byNumber.forEach((a, i) => {
    for (const b of byNumber.slice(i + 1)) {
      const stacked = b.spec.stackedOn === a.spec.key;
      out.push(
        `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, slot, a_head, b_head, stage, kind, prerequisite, files, conflict_files, reason, created_at, updated_at)
         VALUES (${q(`seed-edge-${a.number}-${b.number}`)}, ${q(repoId)}, 'main', ${q(a.id)}, ${q(b.id)}, 'pair', ${q(a.headSha)}, ${q(b.headSha)}, 'done', ${q(stacked ? 'builds_on' : 'independent')}, ${q(stacked ? 'a' : null)}, ${q(stacked ? ['src/api/routes.ts', 'src/currency.ts'] : [])}, '[]', ${q(stacked ? 'The PDF prints each invoice in its own currency, which the US dollar change adds.' : 'They change different parts of the code.')}, ${now}, ${now})`
      );
    }
  });

  // Admin lets GitOrange AI answer the Shipping agent's findings on their pull requests.
  const shipping = agents.get('shippingagent');
  if (shipping)
    out.push(
      `INSERT OR IGNORE INTO ai_delegations (user_id, agent_id, created_at) VALUES (${q(people.admin.id)}, ${q(shipping.id)}, ${clock.at({ d: 4, h: 10, m: 0 })})`
    );

  // What agents learned from findings a person dismissed.
  LESSONS.forEach((lesson, i) => {
    const agent = agents.get(lesson.agent);
    const pr = byBranch.get(lesson.branch);
    const flag = pr?.flagIds.find(
      (f) => f.handle === lesson.agent && f.flag.kind === 'change_requested'
    );
    if (!agent || !pr || !flag) return;
    const finished = clock.at(lesson.finished);
    out.push(
      `INSERT INTO agent_lessons (id, agent_id, pull_request_id, repository_id, finding_ids, status, run_id, attempts, retryable, base_sha, commit_sha, summary, error, created_at, started_at, finished_at)
       VALUES (${q(`seed-lesson-${i + 1}`)}, ${q(agent.id)}, ${q(pr.id)}, ${q(repoId)}, ${q([flag.id])}, 'committed', NULL, 1, 0, ${q(agent.sha)}, ${q(agent.sha)}, ${q(lesson.summary)}, NULL, ${clock.at(pr.spec.mergedAt) + 5}, ${finished - 60}, ${finished})`,
      `INSERT OR IGNORE INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
       VALUES (${q(`learned:seed-lesson-${i + 1}`)}, ${q(repoId)}, ${q(pr.id)}, 'learned', NULL, ${q({ handle: lesson.agent, findings: 1, sha: agent.sha, repository: `${lesson.agent}/${lesson.agent}` })}, ${q(agent.id)}, ${finished * 1000}, ${finished * 1000})`
    );
  });

  // Fixer: rebases it attempted this week.
  REBASE_RUNS.forEach((run, i) => {
    const pr = byBranch.get(run.branch);
    if (!pr) return;
    const startedMs = clock.ms(run.at);
    const finishedMs = startedMs + run.seconds * 1000;
    const id = `seed-rebase-${i + 1}`;
    out.push(
      `INSERT INTO agent_runs (id, repository_id, pull_request_id, kind, status, title, workflow_instance_id, started_at, finished_at, error)
       VALUES (${q(id)}, ${q(repoId)}, ${q(pr.id)}, 'rebase', ${q(run.status)}, ${q(`Rebase #${pr.number} onto main`)}, ${q(id)}, ${startedMs}, ${finishedMs}, ${q(run.error ?? null)})`,
      `INSERT INTO agent_steps (id, run_id, position, name, status, started_at, finished_at, attempts, model, tokens_in, tokens_out, cost_estimate, decision, error)
       VALUES (${q(`${id}:load`)}, ${q(id)}, 1, 'load', 'succeeded', ${startedMs}, ${startedMs + 800}, 1, NULL, NULL, NULL, NULL, NULL, NULL)`,
      `INSERT INTO agent_steps (id, run_id, position, name, status, started_at, finished_at, attempts, model, tokens_in, tokens_out, cost_estimate, decision, error)
       VALUES (${q(`${id}:resolve`)}, ${q(id)}, 2, 'resolve', ${q(run.status)}, ${startedMs + 800}, ${finishedMs}, 1, ${q(REVIEW_MODEL)}, ${1800 + i * 600}, ${420 + i * 90}, ${0.004 + i * 0.002}, ${q(run.status === 'succeeded' ? 'Combined the two changes to src/api/routes.ts.' : null)}, ${q(run.error ?? null)})`
    );
  });
  return out;
}

/**
 * Where each open pull request stands now, recorded on its timeline (a state change at the moment its last review
 * landed), from the states the app computes over the rows above.
 */
export function stateStatements(ctx, states) {
  const { clock, repoId, prs } = ctx;
  const out = [];
  for (const pr of prs.filter((p) => p.kind === 'open')) {
    const state = states.get(pr.number);
    if (!state) continue;
    const decisions = pr.flagIds.flatMap((f) =>
      f.flag.decision ? [clock.ms(f.flag.decision.at)] : []
    );
    const reviewed =
      clock.ms(pr.spec.review.at) + (pr.spec.review.durationMs ?? 0);
    const when = Math.min(
      Math.max(reviewed, ...decisions) + 30_000,
      clock.now * 1000 - 120_000
    );
    out.push(
      `INSERT OR REPLACE INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
       VALUES (${q(`seed-state-${pr.number}`)}, ${q(repoId)}, ${q(pr.id)}, 'state_changed', ${q(state.state)}, ${q({ reasons: state.reasons })}, NULL, ${when}, ${when})`
    );
  }
  return out;
}
