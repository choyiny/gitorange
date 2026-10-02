import { concat, decoder, encoder } from './bytes';
import {
  FLUSH,
  parsePktLines,
  parseRefAdvertisement,
  pktLine,
  type RefAdvertisement,
} from './pktline';
import { buildPack } from './pack';
import type { GitObject } from './objects';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export class GitPushError extends Error {}

/**
 * One Artifacts repo, addressed by its immutable storage name. Wraps the binding for
 * object reads and the smart-HTTP remote for ref listing and pushes.
 */
export class ArtifactsRepoClient {
  private handle?: Promise<ArtifactsRepo>;
  private remoteUrl?: Promise<string>;

  constructor(
    private readonly artifacts: Artifacts,
    readonly name: string
  ) {}

  repo(): Promise<ArtifactsRepo> {
    this.handle ??= this.artifacts.get(this.name);
    return this.handle;
  }

  remote(): Promise<string> {
    this.remoteUrl ??= this.repo().then(async (r) => (await r.info()).remote);
    return this.remoteUrl;
  }

  async token(scope: 'read' | 'write'): Promise<string> {
    const t = await (await this.repo()).createToken(scope, 300);
    return t.plaintext;
  }

  /** Forwards a smart-HTTP request (path relative to the .git remote) with a minted token. */
  async forward(
    path: string,
    init: {
      method: string;
      headers: Headers;
      body?: ReadableStream | Uint8Array | null;
    },
    scope: 'read' | 'write'
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.token(scope)}`);
    return fetch((await this.remote()) + path, {
      method: init.method,
      headers,
      body: init.body ?? undefined,
    });
  }

  async listRefs(): Promise<RefAdvertisement> {
    const res = await this.forward(
      '/info/refs?service=git-upload-pack',
      { method: 'GET', headers: new Headers() },
      'read'
    );
    if (!res.ok) throw new Error(`info/refs failed: ${res.status}`);
    return parseRefAdvertisement(new Uint8Array(await res.arrayBuffer()));
  }

  /**
   * Atomically updates refs. `old` must match the server's current value
   * (compare-and-swap), so a concurrent push makes this fail instead of clobbering.
   */
  async push(
    updates: { ref: string; old: string; new: string }[],
    objects: GitObject[]
  ): Promise<void> {
    const lines: Uint8Array[] = [];
    updates.forEach((u, i) => {
      const caps = i === 0 ? '\0report-status agent=gitorange/1.0' : '';
      lines.push(pktLine(`${u.old} ${u.new} ${u.ref}${caps}\n`));
    });
    lines.push(FLUSH);
    const needsPack = updates.some((u) => u.new !== ZERO_SHA);
    if (needsPack) lines.push(await buildPack(objects));
    const res = await this.forward(
      '/git-receive-pack',
      {
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/x-git-receive-pack-request',
          Accept: 'application/x-git-receive-pack-result',
        }),
        body: concat(lines),
      },
      'write'
    );
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok)
      throw new GitPushError(
        `push failed: ${res.status} ${decoder.decode(body)}`
      );
    const report = parsePktLines(body)
      .filter((p) => p.type === 'data')
      .map((p) => decoder.decode((p as { data: Uint8Array }).data).trim());
    const unpack = report.find((l) => l.startsWith('unpack'));
    if (unpack && unpack !== 'unpack ok') throw new GitPushError(unpack);
    const failed = report.filter((l) => l.startsWith('ng '));
    if (failed.length) throw new GitPushError(failed.join('; '));
  }
}

export { encoder };
