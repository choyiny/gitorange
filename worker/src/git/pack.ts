import { concat, deflate, encoder, sha1 } from './bytes';
import type { GitObject } from './objects';

const TYPE_CODES = { commit: 1, tree: 2, blob: 3 } as const;

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

/** Builds an undeltified version-2 packfile. */
export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(encoder.encode('PACK'), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const obj of objects) {
    parts.push(objectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(await deflate(obj.data));
  }
  const body = concat(parts);
  return concat([body, await sha1(body)]);
}
