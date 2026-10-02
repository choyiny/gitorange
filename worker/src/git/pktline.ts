import { concat, decoder, encoder } from './bytes';

export const FLUSH = encoder.encode('0000');

export function pktLine(line: string | Uint8Array): Uint8Array {
  const payload = typeof line === 'string' ? encoder.encode(line) : line;
  const len = (payload.length + 4).toString(16).padStart(4, '0');
  return concat([encoder.encode(len), payload]);
}

export type Pkt = { type: 'flush' } | { type: 'data'; data: Uint8Array };

/** Splits a buffer into pkt-lines. Stops at the end of the buffer. */
export function parsePktLines(buf: Uint8Array): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(decoder.decode(buf.subarray(off, off + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len === 0 || len === 1 || len === 2) {
      out.push({ type: 'flush' });
      off += 4;
      continue;
    }
    out.push({ type: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

export interface RefAdvertisement {
  refs: Map<string, string>;
  head: string | null;
  capabilities: string[];
}

/** Parses a smart-HTTP `info/refs` advertisement (protocol v1). */
export function parseRefAdvertisement(buf: Uint8Array): RefAdvertisement {
  const refs = new Map<string, string>();
  let head: string | null = null;
  let capabilities: string[] = [];
  for (const pkt of parsePktLines(buf)) {
    if (pkt.type !== 'data') continue;
    let line = decoder.decode(pkt.data).replace(/\n$/, '');
    if (line.startsWith('#')) continue;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).split(' ');
      line = line.slice(0, nul);
      const symref = capabilities.find((c) => c.startsWith('symref=HEAD:'));
      if (symref) head = symref.slice('symref=HEAD:'.length);
    }
    const [sha, name] = line.split(' ');
    if (!name || /^0{40}$/.test(sha) || name === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) continue;
    refs.set(name, sha);
  }
  return { refs, head, capabilities };
}
