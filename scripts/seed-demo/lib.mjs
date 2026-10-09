// Helpers for seed-demo.mjs: the local-only guard, time, the API client, git, and local D1.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DAY = 86_400;

/** Only a machine's own dev server is ever seeded: localhost, 127.0.0.1, [::1], *.localhost and *.test. */
export function assertLocalUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${text}" is not a URL.`);
  }
  const host = url.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test');
  if (!local || !['http:', 'https:'].includes(url.protocol))
    throw new Error(
      `Refusing to seed ${url.origin}: the demo seed only runs against a local dev server (localhost, 127.0.0.1, *.localhost or *.test).`
    );
  return url;
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Resolves history times against `nowMs`: `{ d, h, m }` is `d` days ago at hour `h`:`m` UTC, `{ ago }` is that many
 * hours ago. Never later than five minutes ago. `at` is epoch seconds, `ms` epoch milliseconds.
 */
export function makeClock(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const dayStart = now - (now % DAY);
  const at = (spec) => {
    const t =
      spec.ago !== undefined
        ? now - Math.round(spec.ago * 3600)
        : dayStart - spec.d * DAY + (spec.h ?? 0) * 3600 + (spec.m ?? 0) * 60;
    return Math.min(t, now - 300);
  };
  return { now, at, ms: (spec) => at(spec) * 1000 };
}

// ── The API ──────────────────────────────────────────────────────────────────

const clip = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').slice(0, 400);
};

export class Api {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
  }

  async request(method, route, { json, session } = {}) {
    const send = () =>
      fetch(this.base + route, {
        method,
        redirect: 'manual',
        headers: {
          origin: this.base,
          ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(session ? { cookie: session.cookie } : {}),
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
      });
    let res;
    try {
      res = await send();
    } catch (e) {
      // A kept-alive connection the server closed while git was busy: nothing was sent on it, so sending again is safe.
      const code = e.cause?.code;
      if (!['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(code))
        throw new Error(
          `${method} ${route} failed: ${e.message}${code ? ` (${code})` : ''}`
        );
      await sleep(300);
      res = await send();
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, ok: res.ok, body, headers: res.headers };
  }

  /** The response body, or a thrown error naming the call and what came back (never the request body). */
  async must(method, route, opts) {
    const res = await this.request(method, route, opts);
    if (!res.ok)
      throw new Error(
        `${method} ${route} answered ${res.status}: ${clip(res.body)}`
      );
    return res.body;
  }

  get(route, session) {
    return this.must('GET', route, { session });
  }

  /** Signs in with a username and password; the cookie stays in memory and is never printed. */
  async signIn(username, password) {
    const res = await this.request('POST', '/api/auth/sign-in/username', {
      json: { username, password },
    });
    if (!res.ok)
      throw new Error(
        `Signing in as ${username} answered ${res.status}: ${clip(res.body?.message ?? res.body?.error ?? '')}`
      );
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    if (!cookie) throw new Error(`Signing in as ${username} set no session.`);
    return { username, cookie };
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── git ──────────────────────────────────────────────────────────────────────

/**
 * A scratch clone of the demo repository. Global and system git config are ignored (no signing, hooks or credential
 * helpers of the person running this), and the push credential travels in the environment, not on a command line.
 */
export class Git {
  constructor(dir, { remote, authHeader } = {}) {
    this.dir = dir;
    this.remote = remote;
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-demo-home-'));
    this.env = {
      PATH: process.env.PATH,
      HOME: this.home,
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(authHeader
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: authHeader,
          }
        : {}),
    };
  }

  run(args, { env = {}, input } = {}) {
    try {
      return execFileSync('git', args, {
        cwd: this.dir,
        env: { ...this.env, ...env },
        input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      const stderr = String(e.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-6)
        .join('\n');
      throw new Error(`git ${args[0]} failed: ${stderr || e.message}`);
    }
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.run(['init', '-q', '-b', 'main']);
    if (this.remote) this.run(['remote', 'add', 'origin', this.remote]);
  }

  /** Commits everything in the working tree as `author` at `ts` (epoch seconds); returns the new sha. */
  commit({ message, author, ts }) {
    const when = `${ts} +0000`;
    this.run(['add', '-A']);
    this.run(['commit', '-q', '--no-gpg-sign', '--no-verify', '-m', message], {
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: when,
      },
    });
    return this.sha('HEAD');
  }

  sha(rev) {
    return this.run(['rev-parse', rev]);
  }

  /** Starts `branch` at `from`, moving the working tree there. */
  branchFrom(branch, from) {
    this.run(['checkout', '-q', '-B', branch, from]);
  }

  push(refspec) {
    this.run(['push', '-q', 'origin', refspec]);
  }

  /** Makes local `main` the server's main (after a landing, which may have moved it). */
  syncMain() {
    this.run([
      'fetch',
      '-q',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    this.run(['checkout', '-q', '-B', 'main', 'origin/main']);
  }

  /** What `git show <rev>:<file>` prints, or null when the file is not there. */
  show(rev, file) {
    try {
      return this.run(['show', `${rev}:${file}`]);
    } catch {
      return null;
    }
  }
}

/** Applies `{ write, edit, append }` to the working tree under `dir`. An edit must match exactly once. */
export function applyOps(dir, ops) {
  for (const [file, content] of Object.entries(ops.write ?? {})) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  for (const [file, edits] of Object.entries(ops.edit ?? {})) {
    const target = path.join(dir, file);
    let text = fs.readFileSync(target, 'utf8');
    for (const [from, to] of edits) {
      const count = text.split(from).length - 1;
      if (count !== 1)
        throw new Error(
          `Edit of ${file} matched ${count} times (wanted 1): ${JSON.stringify(from.slice(0, 60))}`
        );
      text = text.replace(from, () => to);
    }
    fs.writeFileSync(target, text);
  }
  for (const [file, content] of Object.entries(ops.append ?? {})) {
    fs.appendFileSync(path.join(dir, file), content);
  }
}

/** Copies fixture files (paths relative to `fixtureDir`) into the working tree. */
export function copyFixture(fixtureDir, dir, files) {
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(fixtureDir, file), target);
  }
}

// ── D1 ───────────────────────────────────────────────────────────────────────

/** An SQL literal for `v`: strings are quoted, objects become JSON text, booleans 1 or 0, nothing NULL. */
export function q(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Not a number: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${text.replaceAll("'", "''")}'`;
}

/** The local D1 of the dev server, through wrangler (it must run from the checkout the server runs from). */
export class D1 {
  constructor({ wrangler, cwd }) {
    this.wrangler = wrangler;
    this.cwd = cwd;
  }

  run(extra) {
    try {
      const out = execFileSync(
        this.wrangler.command,
        [
          ...this.wrangler.args,
          'd1',
          'execute',
          'DB',
          '--local',
          '--env',
          'dev',
          '--json',
          ...extra,
        ],
        {
          cwd: this.cwd,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          env: {
            ...process.env,
            WRANGLER_SEND_METRICS: 'false',
            NO_COLOR: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const start = out.indexOf('[');
      return JSON.parse(out.slice(start));
    } catch (e) {
      const detail = String(e.stderr || e.stdout || e.message)
        .trim()
        .split('\n')
        .slice(-8)
        .join('\n');
      throw new Error(`wrangler d1 execute failed:\n${detail.slice(0, 1500)}`);
    }
  }

  /** The rows a single SELECT returns. */
  query(sql) {
    const results = this.run(['--command', sql]);
    return results.at(-1)?.results ?? [];
  }

  /** Runs statements (one string, `;`-separated, or a list) from a file; returns wrangler's per-statement results. */
  exec(statements) {
    const text =
      (Array.isArray(statements) ? statements : [statements])
        .map((s) => s.trim().replace(/;$/, ''))
        .filter(Boolean)
        .join(';\n') + ';\n';
    const file = path.join(
      os.tmpdir(),
      `seed-demo-${process.pid}-${Date.now()}.sql`
    );
    fs.writeFileSync(file, text);
    try {
      return this.run(['--file', file]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}

/** The wrangler to run: `--wrangler`, else this checkout's own binary, else `yarn wrangler`. */
export function findWrangler(cwd, given) {
  if (given) return { command: given, args: [] };
  const local = path.join(cwd, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(local)) return { command: local, args: [] };
  return { command: 'yarn', args: ['wrangler'] };
}
