// A dry run's check of the SQL the seed would write: runs it against an in-memory SQLite built from this checkout's own
// migrations, with just the rows the statements refer to, so a wrong column or a broken constraint shows up without a
// server. (Uses node:sqlite; skipped where Node has none.)

import fs from 'node:fs';
import path from 'node:path';
import { q } from './lib.mjs';

export async function validateSql({ ctx, statements, migrationsDir }) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { checked: false, problems: [] };
  }
  const db = new DatabaseSync(':memory:');
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));

  const now = ctx.clock.now;
  const user = (id, username) =>
    db.exec(
      `INSERT INTO users (id, name, email, username, created_at, updated_at) VALUES (${q(id)}, ${q(username)}, ${q(`${username}@example.test`)}, ${q(username)}, ${now * 1000}, ${now * 1000})`
    );
  user(ctx.people.admin.id, ctx.people.admin.username);
  user(ctx.people.cho.id, ctx.people.cho.username);
  db.exec(
    `INSERT INTO repositories (id, owner_id, name, artifacts_name, created_at, updated_at) VALUES (${q(ctx.repoId)}, ${q(ctx.people.admin.id)}, 'invoices', ${q(`r_${ctx.repoId}`)}, ${now}, ${now})`
  );
  for (const [handle, agent] of ctx.agents) {
    user(agent.id, handle);
    db.exec(
      `INSERT INTO agents (user_id, name, trigger_ask, trigger_above, created_at) VALUES (${q(agent.id)}, ${q(agent.name)}, 'Does it?', 0.4, ${now})`
    );
    db.exec(
      `INSERT INTO repository_agents (repository_id, agent_id, created_at) VALUES (${q(ctx.repoId)}, ${q(agent.id)}, ${now})`
    );
  }
  for (const pr of ctx.prs)
    db.exec(
      `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, head_ref, state, created_at, updated_at) VALUES (${q(pr.id)}, ${q(ctx.repoId)}, ${pr.number}, ${q(pr.spec.title)}, ${q(ctx.people[pr.spec.author].id)}, 'main', ${q(pr.spec.branch)}, ${pr.kind === 'merged' ? "'merged'" : "'open'"}, ${now}, ${now})`
    );

  const problems = [];
  for (const sql of statements) {
    try {
      db.exec(sql);
    } catch (e) {
      problems.push(
        `${e.message}\n    ${sql.replace(/\s+/g, ' ').slice(0, 160)}`
      );
    }
  }
  const count = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    checked: true,
    problems,
    counts: Object.fromEntries(
      [
        'pr_classifications',
        'pr_reviewers',
        'pr_review_flags',
        'audit_events',
        'workflow_runs',
        'workflow_steps',
        'agent_lessons',
        'agent_runs',
        'pr_edges',
      ].map((t) => [t, count(t)])
    ),
  };
}
