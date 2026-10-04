import { DurableObject } from 'cloudflare:workers';
import { mask, parseKeyValueFile, parsePathFile } from './commands';
import type { InstanceType } from './plan';

export interface StepRequest {
  number: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Values to replace with *** in the log (tokens). */
  masks: string[];
}

export interface StepResult {
  exitCode: number;
  timedOut: boolean;
  log: string;
  outputs: Record<string, string>;
  envAdds: Record<string, string>;
  pathAdds: string[];
}

/** The surface the run executor needs; the Durable Object implements it over RPC. */
export interface JobRunnerApi {
  boot(instance: InstanceType, maxMs: number): Promise<{ ms: number }>;
  runStep(req: StepRequest): Promise<StepResult>;
  destroy(): Promise<void>;
}

export const WORKSPACE = '/workspace';
const STATE_DIR = '/tmp/_gitorange';
/** Per-step log cap; beyond it the start is dropped so the failure at the end survives. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const BOOT_TIMEOUT_MS = 3 * 60_000;

function capped(text: string): string {
  if (text.length <= MAX_LOG_BYTES) return text;
  return (
    `[log truncated: showing the last ${MAX_LOG_BYTES / 1024 / 1024} MB]\n` +
    text.slice(-MAX_LOG_BYTES)
  );
}

/**
 * One Actions job's container (Durable Object scheduling policy: this object starts its own
 * container and picks the instance type at runtime). Holds no application data: the only
 * state is the running step's output, kept in memory so the UI can tail it live, and an alarm
 * that destroys the container if the run that owns it disappears.
 */
export class JobRunner
  extends DurableObject<CloudflareBindings>
  implements JobRunnerApi
{
  private liveStep: { number: number; text: string; masks: string[] } | null =
    null;

  private get container() {
    const c = this.ctx.container;
    if (!c) throw new Error('The JobRunner container is not configured');
    return c;
  }

  async boot(instance: InstanceType, maxMs: number): Promise<{ ms: number }> {
    const t = Date.now();
    // Hard stop for orphaned containers: the job's own timeout plus a margin.
    await this.ctx.storage.setAlarm(Date.now() + maxMs + 10 * 60_000);
    if (!this.container.running) {
      this.container.start({
        image: this.container.images.runner,
        instance,
        entrypoint: ['sleep', 'infinity'],
        enableInternet: true,
      });
    }
    // start() returns before the container accepts commands; probe until exec works.
    for (;;) {
      try {
        const p = await this.container.exec([
          'mkdir',
          '-p',
          WORKSPACE,
          STATE_DIR,
        ]);
        if ((await p.exitCode) === 0) break;
      } catch {
        // not ready yet
      }
      if (Date.now() - t > BOOT_TIMEOUT_MS)
        throw new Error('The runner did not start within 3 minutes');
      await new Promise((r) => setTimeout(r, 250));
    }
    // Cloudflare's microVM leaves `/` owned by an unmapped user, not root. Tools that check
    // their parent directories for safety refuse to run under it (e.g. @swc/core: "cache root
    // has a parent writable by another user"), so give it back to root, as on GitHub's runners.
    // Best effort: a job still runs if this fails.
    await this.container
      .exec(['chown', '0:0', '/'])
      .then((p) => p.exitCode)
      .catch((e) => console.warn('[actions] chown / failed', e));
    return { ms: Date.now() - t };
  }

  async runStep(req: StepRequest): Promise<StepResult> {
    const files = {
      GITHUB_ENV: `${STATE_DIR}/env_${req.number}`,
      GITHUB_OUTPUT: `${STATE_DIR}/output_${req.number}`,
      GITHUB_PATH: `${STATE_DIR}/path_${req.number}`,
      GITHUB_STEP_SUMMARY: `${STATE_DIR}/summary_${req.number}`,
    };
    await (
      await this.container.exec(['touch', ...Object.values(files)])
    ).exitCode;
    await (
      await this.container.exec(['mkdir', '-p', req.cwd])
    ).exitCode;

    const live = { number: req.number, text: '', masks: req.masks };
    this.liveStep = live;
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, req.timeoutMs);
    let exitCode = 1;
    try {
      const proc = await this.container.exec(req.argv, {
        cwd: req.cwd,
        env: { ...req.env, ...files },
        stderr: 'combined',
        signal: abort.signal,
      });
      if (proc.stdout) {
        const reader = proc.stdout
          .pipeThrough(new TextDecoderStream())
          .getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          live.text += value;
          if (live.text.length > MAX_LOG_BYTES * 1.25)
            live.text = capped(live.text);
        }
      }
      exitCode = await proc.exitCode;
    } catch (e) {
      if (!timedOut)
        live.text += `\n${e instanceof Error ? e.message : String(e)}\n`;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      exitCode = 1;
      live.text += `\nThe step exceeded its timeout of ${Math.round(req.timeoutMs / 60_000)} minutes and was stopped.\n`;
    }

    // Read back what the step wrote to its command files (NUL-separated).
    let envAdds: Record<string, string> = {};
    let outputs: Record<string, string> = {};
    let pathAdds: string[] = [];
    try {
      const p = await this.container.exec([
        'sh',
        '-c',
        `cat "$1"; printf '\\0'; cat "$2"; printf '\\0'; cat "$3"`,
        'sh',
        files.GITHUB_ENV,
        files.GITHUB_OUTPUT,
        files.GITHUB_PATH,
      ]);
      const out = await p.output();
      const [env = '', output = '', path = ''] = new TextDecoder()
        .decode(out.stdout)
        .split('\0');
      envAdds = parseKeyValueFile(env);
      outputs = parseKeyValueFile(output);
      pathAdds = parsePathFile(path);
    } catch {
      // The container is gone (e.g. timed out); there is nothing more to read.
    }
    this.liveStep = null;
    return {
      exitCode,
      timedOut,
      log: mask(capped(live.text), req.masks),
      outputs,
      envAdds,
      pathAdds,
    };
  }

  /** Output so far of the step that is running now, for live logs. */
  async live(stepNumber: number): Promise<string | null> {
    const s = this.liveStep;
    if (!s || s.number !== stepNumber) return null;
    return mask(capped(s.text), s.masks);
  }

  async destroy(): Promise<void> {
    this.liveStep = null;
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container?.running) await this.container.destroy();
  }

  async alarm() {
    if (this.ctx.container?.running) await this.container.destroy();
  }
}
