#!/usr/bin/env node
// `yarn dev`: runs the Vite dev server (app + worker in workerd) under a memory watchdog.
//
// Every few seconds it adds up the resident memory of the whole dev process tree (Node, workerd,
// esbuild). It logs each time usage passes another whole gigabyte, which helps track down leaks,
// and stops the server once it passes DEV_MEMORY_LIMIT_MB (default 5120 = 5 GB), so a leak can't
// take the machine down. Set DEV_MEMORY_LIMIT_MB=0 to turn the watchdog off.
import { execFileSync, spawn } from 'node:child_process';

const LIMIT_MB = Number(process.env.DEV_MEMORY_LIMIT_MB ?? 5120);
const INTERVAL_MS = 5000;
const tag = '[dev watchdog]';

const child = spawn('vite', process.argv.slice(2), {
  stdio: 'inherit',
  // Its own process group, so the whole tree can be stopped at once.
  detached: process.platform !== 'win32',
  env: { ...process.env, CLOUDFLARE_ENV: process.env.CLOUDFLARE_ENV ?? 'dev' },
  shell: process.platform === 'win32',
});

/** Every process under `root` (inclusive) with its resident memory, from `ps`. */
function tree(root) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], {
    encoding: 'utf8',
  });
  const procs = out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], kb: +m[3], cmd: m[4] }));
  const byParent = new Map();
  for (const p of procs)
    byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const self = procs.find((p) => p.pid === root);
  const found = self ? [self] : [];
  for (let i = 0; i < found.length; i++)
    found.push(...(byParent.get(found[i].pid) ?? []));
  return found;
}

const mb = (kb) => Math.round(kb / 1024);

function stopTree(signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

let reportedGb = 0;
let stopping = false;
const watch =
  LIMIT_MB > 0 && process.platform !== 'win32'
    ? setInterval(() => {
        let procs;
        try {
          procs = tree(child.pid);
        } catch {
          return; // ps failed this time; try again next tick.
        }
        const totalMb = mb(procs.reduce((n, p) => n + p.kb, 0));
        const gb = Math.floor(totalMb / 1024);
        if (gb > reportedGb) {
          reportedGb = gb;
          console.warn(`${tag} dev server now uses ${totalMb} MB`);
        }
        if (totalMb <= LIMIT_MB || stopping) return;
        stopping = true;
        console.error(
          `\n${tag} dev server uses ${totalMb} MB, over the ${LIMIT_MB} MB limit; stopping it.`
        );
        for (const p of procs.sort((a, b) => b.kb - a.kb).slice(0, 6))
          console.error(
            `${tag}   ${String(mb(p.kb)).padStart(6)} MB  ${p.pid}  ${p.cmd}`
          );
        console.error(
          `${tag} Likely a memory leak. Restart with \`yarn dev\` (DEV_MEMORY_LIMIT_MB changes the limit).`
        );
        stopTree('SIGTERM');
        setTimeout(() => stopTree('SIGKILL'), 5000).unref();
      }, INTERVAL_MS)
    : null;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    stopTree(signal);
    setTimeout(() => stopTree('SIGKILL'), 5000).unref();
  });

child.on('exit', (code, signal) => {
  if (watch) clearInterval(watch);
  // 137 = killed for memory, like an OOM kill.
  process.exit(stopping ? 137 : (code ?? (signal ? 1 : 0)));
});
