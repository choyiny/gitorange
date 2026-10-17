import type { RunResult, Runner } from '../runner.ts';

type Handler = (args: string[]) => RunResult | Promise<RunResult>;

/**
 * A Runner driven by a script keyed by `cmd` or `cmd arg0` (the more specific key wins).
 * Unscripted commands fail loudly.
 */
export function fakeRunner(
  script: Record<string, Handler>
): Runner & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push({ cmd, args });
      const handler = script[`${cmd} ${args[0] ?? ''}`.trim()] ?? script[cmd];
      if (!handler)
        throw new Error(`fakeRunner: unscripted ${cmd} ${args.join(' ')}`);
      return handler(args);
    },
  };
}

/** Stub: filled in Task 5 (in-memory Cloudflare REST fake). */
export function fakeCloudflare(): never {
  throw new Error('fakeCloudflare: filled in Task 5');
}
