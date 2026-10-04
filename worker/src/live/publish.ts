/**
 * Live-update channels. Messages say only what changed, never data, so a page refetches what it
 * shows through the permission-checked API:
 * - `repo:<id>`: anything in a repository (pushes, pull requests, reviews, Actions). Pages under
 *   that repository refetch.
 * - `approvals`: something that may change anyone's approvals inbox (reviews, flags, conflict
 *   resolutions, merges). The inbox and its count in the header refetch.
 */
export const repoChannel = (repositoryId: string) => `repo:${repositoryId}`;
export const APPROVALS_CHANNEL = 'approvals';

export function liveConfigured(env: CloudflareBindings): boolean {
  return Boolean((env as Partial<CloudflareBindings>).LIVE);
}

const hub = (env: CloudflareBindings) => env.LIVE.getByName('hub');

/**
 * Tells open pages that a repository changed; `approvals` also refreshes approval inboxes.
 * Never throws: a missed ping only delays an update until the next one or a reload.
 */
export async function publishChange(
  env: CloudflareBindings,
  repositoryId: string,
  opts: { approvals?: boolean } = {}
): Promise<void> {
  if (!liveConfigured(env)) return;
  try {
    const h = hub(env);
    await h.publish(
      repoChannel(repositoryId),
      JSON.stringify({ type: 'repo' })
    );
    if (opts.approvals)
      await h.publish(APPROVALS_CHANNEL, JSON.stringify({ type: 'approvals' }));
  } catch (e) {
    console.warn('[live] publish failed', e);
  }
}

/** Opens a browser's WebSocket on the hub, subscribed to the given (already authorized) channels. */
export function connectLive(
  env: CloudflareBindings,
  request: Request,
  channels: string[]
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('X-Live-Channels', channels.join(','));
  return hub(env).fetch(new Request(request.url, { headers }));
}

/** The `do` of a Workflow step runner, as the executors use it. */
interface Steps {
  do<T>(name: string, ...args: unknown[]): Promise<T>;
}

/**
 * Wraps a Workflow's step runner so each completed step pings the repository's open pages: a
 * review, conflict resolution, or Actions run then shows its progress live. A replayed step
 * pings again, which is harmless.
 */
export function pingingSteps<S>(
  env: CloudflareBindings,
  step: S,
  repositoryId: string,
  opts: { approvals?: boolean } = {}
): S {
  const inner = step as unknown as Steps;
  const wrapped: Steps = {
    async do<T>(name: string, ...args: unknown[]): Promise<T> {
      const result = await inner.do<T>(name, ...args);
      await publishChange(env, repositoryId, opts);
      return result;
    },
  };
  return wrapped as unknown as S;
}
