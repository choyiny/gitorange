import { concat, encoder, fromHex, sha1, toHex } from './bytes';

export type ObjectType = 'commit' | 'tree' | 'blob';

export interface GitObject {
  type: ObjectType;
  sha: string;
  data: Uint8Array;
}

export async function makeObject(
  type: ObjectType,
  data: Uint8Array
): Promise<GitObject> {
  const header = encoder.encode(`${type} ${data.length}\0`);
  const sha = toHex(await sha1(concat([header, data])));
  return { type, sha, data };
}

export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
}

/** Git orders tree entries by name, comparing directories as if suffixed with "/". */
function sortKey(e: TreeEntry) {
  return e.mode === '40000' || e.mode === '040000' ? e.name + '/' : e.name;
}

export function compareEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = encoder.encode(sortKey(a));
  const kb = encoder.encode(sortKey(b));
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return ka.length - kb.length;
}

export function makeTree(entries: TreeEntry[]): Promise<GitObject> {
  const sorted = [...entries].sort(compareEntries);
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    const mode = e.mode === '040000' ? '40000' : e.mode;
    parts.push(encoder.encode(`${mode} ${e.name}\0`), fromHex(e.hash));
  }
  return makeObject('tree', concat(parts));
}

export interface Signature {
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
}

function formatSignature(s: Signature) {
  const name = s.name.replace(/[<>\n]/g, '');
  const email = s.email.replace(/[<>\n]/g, '');
  return `${name} <${email}> ${s.timestamp} +0000`;
}

export function makeCommit(opts: {
  tree: string;
  parents: string[];
  author: Signature;
  committer?: Signature;
  message: string;
}): Promise<GitObject> {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${formatSignature(opts.author)}`);
  lines.push(`committer ${formatSignature(opts.committer ?? opts.author)}`);
  const message = opts.message.endsWith('\n')
    ? opts.message
    : opts.message + '\n';
  return makeObject(
    'commit',
    encoder.encode(lines.join('\n') + '\n\n' + message)
  );
}

export function makeBlob(content: string | Uint8Array): Promise<GitObject> {
  return makeObject(
    'blob',
    typeof content === 'string' ? encoder.encode(content) : content
  );
}
