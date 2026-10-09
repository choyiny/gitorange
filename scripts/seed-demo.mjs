#!/usr/bin/env node
// Fills a local GitOrange dev instance with a demo: a teammate, an invoicing project with ten days of history, eight
// merged pull requests, six open ones, the reviewer crew, their findings and a week of test runs, so every page has
// something to show. Development only: it refuses any host that is not local.
//
//   SEED_ADMIN=<username> SEED_PASSWORD=<password> yarn seed:demo [--url http://localhost:8080]
//
// Run it from the checkout `yarn dev` runs from: it writes some rows (reviews, backdated dates, test runs) straight into
// that checkout's local D1 with `wrangler d1 execute DB --local --env dev`, which the API has no way to write.
// Running it again finds the demo and stops. `--reset` deletes the demo repository first and builds it again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Api,
  assertLocalUrl,
  applyOps,
  copyFixture,
  D1,
  findWrangler,
  Git,
  makeClock,
  q,
  sleep,
} from './seed-demo/lib.mjs';
import * as history from './seed-demo/history.mjs';
import * as rows from './seed-demo/rows.mjs';
import { validateSql } from './seed-demo/validate.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'seed-demo',
  'fixture'
);

/** The teammate's sign-in on a local demo instance. Override with SEED_TEAMMATE_PASSWORD. */
const TEAMMATE_PASSWORD =
  process.env.SEED_TEAMMATE_PASSWORD || 'demo-teammate-pass';

const HELP = `Usage: yarn seed:demo [options]

  --url <url>         the dev server (default http://localhost:8080; must be local)
  --admin <username>  a site admin's username (or SEED_ADMIN)
  --password <pw>     their password (or SEED_PASSWORD; prefer the variable: arguments show up in process lists)
  --wrangler <path>   the wrangler binary (default: node_modules/.bin/wrangler here)
  --reset             delete the demo repository first, then seed again
  --dry-run           build the git history in a temporary folder only: no server, no database

Run it from the checkout that runs \`yarn dev\`. The teammate "cho" is created with the password in
SEED_TEAMMATE_PASSWORD (default: see TEAMMATE_PASSWORD in scripts/seed-demo.mjs).`;

function parseArgs(argv) {
  const args = { url: 'http://localhost:8080', dryRun: false, reset: false };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value.`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--url':
        args.url = value(i++, '--url');
        break;
      case '--admin':
        args.admin = value(i++, '--admin');
        break;
      case '--password':
        args.password = value(i++, '--password');
        break;
      case '--wrangler':
        args.wrangler = value(i++, '--wrangler');
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option ${argv[i]}.\n\n${HELP}`);
    }
  }
  args.admin ||= process.env.SEED_ADMIN;
  args.password ||= process.env.SEED_PASSWORD;
  return args;
}

const log = (text = '') => console.log(text);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return log(HELP);
  const url = assertLocalUrl(args.url);
  const dry = args.dryRun;
  const cwd = process.cwd();
  if (!dry) {
    if (!args.admin || !args.password)
      throw new Error(
        'Give a site admin: SEED_ADMIN and SEED_PASSWORD (or --admin and --password).'
      );
    if (!fs.existsSync(path.join(cwd, 'wrangler.jsonc')))
      throw new Error(
        `No wrangler.jsonc in ${cwd}. Run this from the checkout that runs \`yarn dev\`: its local database is the one that gets seeded.`
      );
  }

  const clock = makeClock();
  const api = new Api(url.origin);
  const d1 = dry
    ? null
    : new D1({ wrangler: findWrangler(cwd, args.wrangler), cwd });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-demo-'));
  let tokenId = null;
  let admin = null;
  let git = null;
  try {
    // ── 1. Sign in ──────────────────────────────────────────────────────────
    let people;
    let repoFull = `${(args.admin ?? 'admin').toLowerCase()}/${history.REPO.name}`;
    if (dry) {
      people = {
        admin: {
          id: 'dry-admin',
          username: 'admin',
          name: 'Admin',
          email: 'admin@example.test',
        },
        cho: {
          id: 'dry-cho',
          username: history.TEAMMATE.username,
          name: history.TEAMMATE.name,
          email: history.TEAMMATE.email,
        },
      };
      repoFull = `admin/${history.REPO.name}`;
      log(`Dry run: building the history in ${scratch}`);
    } else {
      d1.query('SELECT 1 AS ok');
      admin = await api.signIn(args.admin, args.password);
      const users = await api.get('/api/users', admin);
      const me = users.find((u) => u.username === args.admin.toLowerCase());
      if (!me)
        throw new Error(
          `Signed in, but ${args.admin} is not in the user list.`
        );
      if (me.role !== 'admin')
        throw new Error(
          `${me.username} is not a site admin, and the crew needs one.`
        );
      people = {
        admin: me,
        cho: users.find((u) => u.username === history.TEAMMATE.username),
      };
      repoFull = `${me.username}/${history.REPO.name}`;
      log(`Signed in as ${me.username} on ${url.origin}`);

      // ── Already seeded? ────────────────────────────────────────────────
      const repos = await api.get('/api/repos', admin);
      const existing = repos.find((r) => r.fullName === repoFull);
      if (existing && args.reset) {
        log(`Deleting ${repoFull} (--reset)`);
        await api.must('DELETE', `/api/repos/${repoFull}`, { session: admin });
      } else if (existing) {
        const [seeded] = d1.query(
          `SELECT COUNT(*) AS n FROM pr_events WHERE id LIKE 'seed-state-%' AND repository_id = ${q(existing.id)}`
        );
        if (seeded?.n > 0) {
          log(
            `${repoFull} is already seeded: nothing to do. (--reset builds it again.)`
          );
          return await summary({ api, admin, repoFull, url, d1 });
        }
        throw new Error(
          `${repoFull} exists but was not fully seeded (an earlier run stopped part way). Run again with --reset to build it from scratch.`
        );
      }
    }

    const person = (who) => people[who];
    const authorOf = (who) => ({
      name: person(who).name,
      email: person(who).email,
    });
    const sessions = { admin: null, cho: null };

    // ── 2. A token for git, and the teammate ─────────────────────────────────
    let authHeader;
    if (!dry) {
      const made = await api.must('POST', '/api/tokens', {
        session: admin,
        json: { name: 'seed-demo', expiresInDays: 1 },
      });
      tokenId = made.token.id;
      authHeader = `Authorization: Basic ${Buffer.from(`seed:${made.plaintext}`).toString('base64')}`;
      sessions.admin = admin;

      if (!people.cho) {
        const invite = await api.must('POST', '/api/invites', {
          session: admin,
          json: { email: history.TEAMMATE.email, role: 'user' },
        });
        const token = invite.inviteUrl.split('/invite/')[1];
        await api.must('POST', '/api/invites/accept', {
          json: {
            token,
            name: history.TEAMMATE.name,
            username: history.TEAMMATE.username,
            password: TEAMMATE_PASSWORD,
          },
        });
        people.cho = (await api.get('/api/users', admin)).find(
          (u) => u.username === history.TEAMMATE.username
        );
        log(
          `Invited and accepted ${history.TEAMMATE.name} (${history.TEAMMATE.username})`
        );
      } else log(`${history.TEAMMATE.username} already exists`);
      sessions.cho = await api
        .signIn(history.TEAMMATE.username, TEAMMATE_PASSWORD)
        .catch(() => {
          throw new Error(
            `Could not sign in as ${history.TEAMMATE.username}: it exists with another password. Set SEED_TEAMMATE_PASSWORD to it.`
          );
        });
    }

    // ── 3. The repository ───────────────────────────────────────────────────
    let repoId = 'dry-repo';
    if (!dry) {
      const created = await api.must('POST', '/api/repos', {
        session: admin,
        json: {
          name: history.REPO.name,
          description: history.REPO.description,
          visibility: 'internal',
        },
      });
      repoId = created.id;
      await api.must(
        'PUT',
        `/api/repos/${repoFull}/collaborators/${history.TEAMMATE.username}`,
        { session: admin }
      );
      log(
        `Created ${repoFull} (internal), with ${history.TEAMMATE.username} as a collaborator`
      );
    }
    git = new Git(path.join(scratch, 'work'), {
      remote: dry ? undefined : `${url.origin}/${repoFull}.git`,
      authHeader,
    });
    git.init();

    // ── 4. History: the base commits on main ────────────────────────────────
    let baseTip = null;
    for (const c of history.BASE_COMMITS) {
      copyFixture(FIXTURE, git.dir, c.files);
      const ts = clock.at(c.at);
      const sha = git.commit({
        message: c.message,
        author: authorOf('admin'),
        ts,
      });
      baseTip = { sha, at: ts, subject: c.message };
    }
    if (!dry) git.push('main');
    log(`Pushed ${history.BASE_COMMITS.length} commits to main`);

    // Helpers for the pull requests below.
    const records = [];
    const commitsOf = (spec) => {
      for (const c of spec.commits) {
        applyOps(git.dir, c.ops);
        const trailer =
          spec.via === 'Claude Code'
            ? '\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
            : '';
        git.commit({
          message: c.message + trailer,
          author: authorOf(spec.author),
          ts: clock.at(c.at),
        });
      }
    };
    const record = (kind, spec, baseSha) => {
      const head = git.sha('HEAD');
      const files = rows.fileSummaries(git, baseSha, head, spec.summaries);
      const pr = {
        kind,
        spec,
        number: records.length + 1,
        id: `dry-pr-${records.length + 1}`,
        headSha: head,
        baseSha,
        files,
        flagIds: [],
        detailFor: (flag) => rows.findingDetail(git, baseSha, head, flag),
      };
      records.push(pr);
      return pr;
    };
    const openPull = async (pr) => {
      if (dry) return;
      const made = await api.must('POST', `/api/repos/${repoFull}/pulls`, {
        session: sessions[pr.spec.author],
        json: {
          title: pr.spec.title,
          body: pr.spec.body,
          base: 'main',
          head: pr.spec.branch,
        },
      });
      pr.number = made.number;
      pr.id = made.id;
    };
    // GitOrange's AI works on a pull request in the background when it opens (stack discovery); landing and the states
    // wait for it so the demo does not depend on a race.
    const waitIdle = async (timeoutMs = 240_000, quietPolls = 2) => {
      if (dry) return;
      const started = Date.now();
      let quiet = 0;
      await sleep(2500);
      while (Date.now() - started < timeoutMs) {
        const { runs } = await api.get(
          `/api/repos/${repoFull}/agent-runs?limit=100`,
          admin
        );
        quiet = runs.some((r) => r.status === 'running') ? 0 : quiet + 1;
        if (quiet >= quietPolls) return;
        await sleep(2500);
      }
      log(
        `  (AI work still running after ${Math.round(timeoutMs / 1000)}s; carrying on)`
      );
    };
    // The open pull requests must still be at the commits the history was built on: if the AI's stack check rebased or
    // retargeted one, the reviews written below would describe a commit that is gone.
    const openPullsMoved = async () => {
      if (dry) return [];
      const { pulls } = await api.get(
        `/api/repos/${repoFull}/pulls?state=open`,
        admin
      );
      const live = new Map(pulls.map((p) => [p.number, p]));
      const moved = [];
      for (const pr of records.filter((r) => r.kind === 'open')) {
        const now = live.get(pr.number);
        const parent = pr.spec.stackedOn
          ? records.find((r) => r.spec.key === pr.spec.stackedOn)
          : null;
        const bases = parent ? ['main', parent.spec.branch] : ['main'];
        if (!now || now.headSha !== pr.headSha || !bases.includes(now.baseRef))
          moved.push(`#${pr.number} ${pr.spec.title}`);
      }
      return moved;
    };
    let keeping = false;
    const keepMergedBranch = (keep) => {
      if (dry || keep === keeping) return;
      d1.exec(
        `UPDATE repositories SET delete_merged_branches = ${keep ? 0 : 1} WHERE id = ${q(repoId)}`
      );
      keeping = keep;
    };
    const land = async (pr, merger) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await api.request(
          'POST',
          `/api/repos/${repoFull}/pulls/${pr.number}/merge`,
          {
            session: sessions[merger],
            json: {},
          }
        );
        if (res.ok) return res.body.sha;
        const reason = res.body?.reason;
        if (
          res.status !== 409 ||
          !['stack', 'checks', 'rebase', 'review'].includes(reason)
        )
          throw new Error(
            `Merging #${pr.number} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`
          );
        if (reason === 'stack')
          // A relation the AI found with another pull request holds it: it is not what this demo is about.
          d1.exec(
            `UPDATE pr_edges SET dismissed_at = ${clock.now} WHERE pr_a_id = ${q(pr.id)} OR pr_b_id = ${q(pr.id)}`
          );
        if (reason === 'checks')
          // A real run queued here can never finish locally (no containers); the demo's own runs replace them.
          d1.exec([
            `DELETE FROM workflow_steps WHERE job_id IN (SELECT j.id FROM workflow_jobs j JOIN workflow_runs r ON r.id = j.run_id WHERE r.repository_id = ${q(repoId)})`,
            `DELETE FROM workflow_jobs WHERE run_id IN (SELECT id FROM workflow_runs WHERE repository_id = ${q(repoId)})`,
            `DELETE FROM workflow_runs WHERE repository_id = ${q(repoId)}`,
          ]);
        await sleep(3000);
      }
      throw new Error(`Merging #${pr.number} kept being refused.`);
    };

    // ── 5. Eight pull requests, opened and landed one after another ──────────
    for (const spec of history.MERGED) {
      if (dry) git.run(['checkout', '-q', 'main']);
      else git.syncMain();
      git.branchFrom(spec.branch, 'main');
      const baseSha = git.sha('main');
      commitsOf(spec);
      if (!dry) git.push(spec.branch);
      const pr = record('merged', spec, baseSha);
      await openPull(pr);
      await waitIdle();
      if (dry) {
        git.run(['checkout', '-q', 'main']);
        git.run(['merge', '-q', '--ff-only', spec.branch]);
        pr.mergeSha = git.sha('main');
      } else {
        await api.must(
          'POST',
          `/api/repos/${repoFull}/pulls/${pr.number}/approval`,
          { session: sessions[spec.approver] }
        );
        keepMergedBranch(spec.keepBranch);
        pr.mergeSha = await land(pr, spec.merger);
        if (pr.mergeSha !== pr.headSha)
          log(
            `  note: #${pr.number} landed as ${pr.mergeSha.slice(0, 7)}, not ${pr.headSha.slice(0, 7)}`
          );
      }
      log(`Merged #${pr.number} ${spec.title}`);
    }
    keepMergedBranch(false);

    // ── 6. Six that stay open ───────────────────────────────────────────────
    for (const spec of history.OPEN) {
      if (dry) git.run(['checkout', '-q', 'main']);
      else git.syncMain();
      const parent = spec.stackedOn
        ? records.find((r) => r.spec.key === spec.stackedOn)
        : null;
      const from = parent ? parent.spec.branch : 'main';
      git.branchFrom(spec.branch, from);
      const baseSha = git.sha(from);
      commitsOf(spec);
      if (!dry) git.push(spec.branch);
      const pr = record('open', spec, baseSha);
      await openPull(pr);
      log(`Opened #${pr.number} ${spec.title}`);
    }
    // Everything is pushed: the token's work is done (and its audit entries get their dates below).
    if (tokenId && admin) {
      await api.request('DELETE', `/api/tokens/${tokenId}`, { session: admin });
      tokenId = null;
    }
    await waitIdle(300_000, 5);

    // ── 7. The crew ─────────────────────────────────────────────────────────
    const agents = new Map();
    if (dry) {
      for (const h of history.INVITED)
        agents.set(h, { id: `dry-${h}`, name: h, sha: '0'.repeat(40) });
    } else {
      const crew = await api.must('POST', '/api/admin/agents/crew', {
        session: admin,
      });
      log(
        `Crew: ${crew.created.length} created, ${crew.skipped.length} already there`
      );
      for (const handle of history.INVITED)
        await api.must('PUT', `/api/repos/${repoFull}/agents/${handle}`, {
          session: admin,
        });
      for (const a of d1.query(
        `SELECT a.user_id AS id, u.username AS handle, a.name AS name, a.config_sha AS sha FROM agents a JOIN users u ON u.id = a.user_id`
      ))
        agents.set(a.handle, a);
      for (const handle of history.INVITED)
        if (!agents.has(handle)) throw new Error(`The crew has no ${handle}.`);
      log(`Invited ${history.INVITED.join(', ')}`);
      await waitIdle(120_000, 3);
      const moved = await openPullsMoved();
      if (moved.length)
        throw new Error(
          `GitOrange's own AI work moved ${moved.join(', ')} while the demo was being built (it rebased or stacked it), so the reviews would describe a commit that is gone. Run again with --reset.`
        );
    }

    // ── 8. Rows the API cannot write ────────────────────────────────────────
    const ctx = {
      clock,
      repoId,
      repoFull,
      prs: records,
      people,
      agents,
      baseTip,
    };
    const statements = [
      ...rows.historyStatements(ctx),
      ...rows.reviewStatements(ctx),
      ...rows.runStatements(ctx),
      ...rows.extraStatements(ctx),
    ];
    if (dry) {
      log(`Would write ${statements.length} statements to D1`);
      const check = await validateSql({
        ctx,
        statements,
        migrationsDir: path.join(FIXTURE, '..', '..', '..', 'migrations'),
      });
      if (!check.checked)
        log('(node:sqlite is not available: SQL not checked)');
      else if (check.problems.length) {
        log(
          `${check.problems.length} statements failed against the migrations:`
        );
        for (const p of check.problems) log(`  ${p}`);
        process.exitCode = 1;
      } else
        log(
          `Checked against the migrations: all ran. Rows: ${JSON.stringify(check.counts)}`
        );
      log('');
      log(
        git.run([
          'log',
          '--all',
          '--graph',
          '--format=%h %an %ad %s',
          '--date=short',
        ])
      );
      return;
    }
    log(
      `Writing ${statements.length} rows of history, reviews and test runs to the local database`
    );
    d1.exec(statements);

    // The states the app computes over those rows, recorded on each open pull request's timeline.
    const open = await api.get(
      `/api/repos/${repoFull}/pulls?state=open`,
      admin
    );
    const states = new Map(
      open.pulls.filter((p) => p.pullState).map((p) => [p.number, p.pullState])
    );
    d1.exec(rows.stateStatements(ctx, states));
    const movedLate = await openPullsMoved();
    if (movedLate.length)
      log(
        `Warning: ${movedLate.join(', ')} moved while the rows were being written; --reset builds it again.`
      );

    await summary({ api, admin, repoFull, url, d1, states, records });
  } finally {
    if (tokenId && admin)
      await api
        .request('DELETE', `/api/tokens/${tokenId}`, { session: admin })
        .catch(() => {});
    if (dry)
      log(
        `\nThe history is in ${path.join(scratch, 'work')} (a dry run keeps it, to look at).`
      );
    else fs.rmSync(scratch, { recursive: true, force: true });
    if (git) fs.rmSync(git.home, { recursive: true, force: true });
  }
}

async function summary({ api, admin, repoFull, url, d1, states }) {
  const repos = await api.get('/api/repos?stats=1', admin);
  const mine = repos.find((r) => r.fullName === repoFull);
  const stats = mine?.stats;
  log('');
  log(`Demo ready: ${repoFull}`);
  if (stats) {
    log(
      `  ${stats.pulls.open} open pull requests (waiting for a person: ${stats.pulls.needsPerson}, changes requested: ${stats.pulls.changesRequested}, checking: ${stats.pulls.checking}, queued: ${stats.pulls.queued}); ${stats.merged7d} merged this week; ${stats.branchCount} branches`
    );
    log(
      `  reviewers: ${stats.agents.map((a) => `${a.name} (${a.status})`).join(', ')}`
    );
  }
  const base = url.origin;
  log('');
  log('Open:');
  for (const [label, p] of [
    ['Repositories', '/'],
    ['The project', `/${repoFull}`],
    ['Health', `/${repoFull}/health`],
    ['Pull requests', `/${repoFull}/pulls`],
    ['Branches and the branch map', `/${repoFull}/branches`],
    ['Live', `/${repoFull}/live`],
    ['Audit log', `/${repoFull}/audit`],
    ['Actions (test runs)', `/${repoFull}/actions`],
    ['Approvals', '/approvals'],
    ['Reviewers', '/agents'],
    ['Instance audit log', '/admin/audit'],
  ])
    log(`  ${label.padEnd(30)} ${base}${p}`);
  log('');
  log(
    'Each page reads an API route that is already there (the pages themselves land with the redesign):'
  );
  log(
    `  ${base}/api/repos?stats=1   …/branches   …/branches/map   …/queue   …/live   …/health   …/audit   …/sessions`
  );
  log(
    `  ${base}/api/approvals   ${base}/api/agents/presets   ${base}/api/agents/dataagent/stats   ${base}/api/search?q=inv`
  );
  log('');
  log(
    `Sign in as ${history.TEAMMATE.username} (${history.TEAMMATE.name}) with the SEED_TEAMMATE_PASSWORD you used, or the default in scripts/seed-demo.mjs.`
  );
}

main().catch((e) => {
  console.error(`\nseed-demo: ${e.message}`);
  process.exitCode = 1;
});
