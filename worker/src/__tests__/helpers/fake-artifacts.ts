import { inflateSync } from 'node:zlib';
import { vi } from 'vitest';
import { concat, decoder, encoder, toHex } from '../../git/bytes';
import { FLUSH, pktLine } from '../../git/pktline';
import { makeObject, type GitObject, type ObjectType } from '../../git/objects';

const HOST = 'https://fake.artifacts.test';
const TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob' };

/** One in-memory git repo: an object store plus refs. */
export class FakeRepo {
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  constructor(readonly name: string) {}

  add(...objs: GitObject[]) {
    for (const o of objs) this.objects.set(o.sha, o);
  }

  parseCommit(sha: string) {
    const o = this.objects.get(sha);
    if (!o || o.type !== 'commit') return null;
    const text = decoder.decode(o.data);
    const [head, ...msg] = text.split('\n\n');
    const lines = head.split('\n');
    const sig = (prefix: string) => {
      const m = lines
        .find((l) => l.startsWith(prefix + ' '))!
        .slice(prefix.length + 1)
        .match(/^(.*) <(.*)> (\d+)/)!;
      return { name: m[1], email: m[2], ts: Number(m[3]) };
    };
    const a = sig('author');
    const c = sig('committer');
    return {
      hash: sha,
      treeHash: lines.find((l) => l.startsWith('tree '))!.slice(5),
      parents: lines
        .filter((l) => l.startsWith('parent '))
        .map((l) => l.slice(7)),
      message: msg.join('\n\n').replace(/\n$/, ''),
      author: { name: a.name, email: a.email },
      committer: { name: c.name, email: c.email },
      authoredAt: a.ts,
      committedAt: c.ts,
    };
  }

  parseTree(sha: string) {
    const o = this.objects.get(sha);
    if (!o || o.type !== 'tree') return null;
    const out: {
      name: string;
      mode: string;
      hash: string;
      type: 'tree' | 'blob';
    }[] = [];
    let i = 0;
    while (i < o.data.length) {
      const sp = o.data.indexOf(0x20, i);
      const nul = o.data.indexOf(0, sp);
      const mode = decoder.decode(o.data.subarray(i, sp));
      out.push({
        mode,
        name: decoder.decode(o.data.subarray(sp + 1, nul)),
        hash: toHex(o.data.subarray(nul + 1, nul + 21)),
        type: mode === '40000' ? 'tree' : 'blob',
      });
      i = nul + 21;
    }
    return out;
  }

  resolve(ref: string) {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    return this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(ref) ?? null;
  }

  handle() {
    const repo = this;
    return {
      info: async () => ({
        name: repo.name,
        remote: `${HOST}/git/test/${repo.name}.git`,
      }),
      createToken: async (scope = 'write') => ({
        id: 't',
        plaintext: `art_fake_${scope}`,
        scope,
        expiresAt: '',
      }),
      readCommit: async (sha: string) => repo.parseCommit(sha),
      readTree: async (sha: string) => repo.parseTree(sha),
      readBlob: async (sha: string) => {
        const o = repo.objects.get(sha);
        return o?.type === 'blob' ? new Blob([o.data]) : null;
      },
      readFile: async ({ ref, path }: { ref: string; path: string }) => {
        const commit = repo.resolve(ref);
        let sha = commit ? (repo.parseCommit(commit)?.treeHash ?? null) : null;
        for (const name of path.split('/').filter(Boolean)) {
          sha = sha
            ? (repo.parseTree(sha)?.find((e) => e.name === name)?.hash ?? null)
            : null;
        }
        const o = sha ? repo.objects.get(sha) : undefined;
        return o?.type === 'blob' ? new Blob([o.data]) : null;
      },
      log: async ({
        ref = 'HEAD',
        limit = 50,
        offset = 0,
      }: { ref?: string; limit?: number; offset?: number } = {}) => {
        const out = [];
        let sha = repo.resolve(ref);
        while (sha) {
          const c = repo.parseCommit(sha);
          if (!c) break;
          out.push(c);
          sha = c.parents[0] ?? null;
        }
        return out.slice(offset, offset + limit);
      },
    };
  }

  advertisement(): Uint8Array {
    const entries = [...this.refs].sort(([a], [b]) => a.localeCompare(b));
    const lines = [pktLine('# service=git-upload-pack\n'), FLUSH];
    const caps = 'symref=HEAD:refs/heads/main agent=fake';
    if (!entries.length)
      lines.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
    entries.forEach(([name, sha], i) =>
      lines.push(pktLine(`${sha} ${name}${i === 0 ? '\0' + caps : ''}\n`))
    );
    lines.push(FLUSH);
    return concat(lines);
  }

  async receivePack(body: Uint8Array): Promise<Uint8Array> {
    // Walk pkt-lines up to the flush; the packfile follows it.
    const commands: string[][] = [];
    let off0 = 0;
    for (;;) {
      const len = parseInt(decoder.decode(body.subarray(off0, off0 + 4)), 16);
      if (len === 0) {
        off0 += 4;
        break;
      }
      commands.push(
        decoder
          .decode(body.subarray(off0 + 4, off0 + len))
          .split('\0')[0]
          .trim()
          .split(' ')
      );
      off0 += len;
    }
    const pack = body.subarray(off0);
    if (pack.length) {
      const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
      let off = 12;
      for (let n = 0; n < count; n++) {
        let byte = pack[off++];
        const type = TYPES[(byte >> 4) & 7];
        while (byte & 0x80) byte = pack[off++];
        const r = inflateSync(pack.subarray(off), {
          info: true,
        } as never) as unknown as {
          buffer: Uint8Array;
          engine: { bytesWritten: number };
        };
        off += r.engine.bytesWritten;
        this.add(await makeObject(type, new Uint8Array(r.buffer)));
      }
    }
    const report = [pktLine('unpack ok\n')];
    for (const [old, next, ref] of commands) {
      const current = this.refs.get(ref) ?? '0'.repeat(40);
      if (current !== old) {
        report.push(pktLine(`ng ${ref} stale info\n`));
        continue;
      }
      if (/^0{40}$/.test(next)) this.refs.delete(ref);
      else this.refs.set(ref, next);
      report.push(pktLine(`ok ${ref}\n`));
    }
    report.push(FLUSH);
    return concat(report);
  }
}

/** An in-memory stand-in for the Artifacts binding plus the git smart-HTTP remote. */
export function createFakeArtifacts() {
  const repos = new Map<string, FakeRepo>();
  const binding = {
    create: async (name: string) => {
      const repo = new FakeRepo(name);
      repos.set(name, repo);
      return {
        id: name,
        name,
        remote: `${HOST}/git/test/${name}.git`,
        token: 'art_fake',
        defaultBranch: 'main',
      };
    },
    get: async (name: string) => {
      const repo = repos.get(name);
      if (!repo) throw new Error('NOT_FOUND');
      return repo.handle();
    },
    delete: async (name: string) => repos.delete(name),
  } as unknown as Artifacts;

  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      );
      if (url.origin !== HOST) return realFetch(input, init);
      const name = url.pathname.match(/\/git\/test\/(.+?)\.git/)![1];
      const repo = repos.get(name)!;
      if (url.pathname.endsWith('/info/refs')) {
        return new Response(repo.advertisement(), {
          headers: {
            'Content-Type': 'application/x-git-upload-pack-advertisement',
          },
        });
      }
      if (url.pathname.endsWith('/git-receive-pack')) {
        const body = new Uint8Array(
          await new Response(init?.body).arrayBuffer()
        );
        return new Response(await repo.receivePack(body));
      }
      if (url.pathname.endsWith('/git-upload-pack'))
        return new Response(encoder.encode('0000'));
      return new Response('not found', { status: 404 });
    }
  );

  return { binding, repos };
}
