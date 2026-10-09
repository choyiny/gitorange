import { concat, deflate, encoder } from '../git/bytes';

/** FNV-1a, exactly as `src/components/Avatar.tsx` hashes usernames. */
export function fnv1a(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** CSS hsl() → sRGB bytes; h in degrees, s and l in 0..1. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}

export const IDENTICON_BACKGROUND: [number, number, number] = [240, 240, 240];

/** The SPA's generated avatar: a mirrored 5×5 grid (`cells[y][x]`) in a color from the seed. */
export function identicon(seed: string) {
  const h = fnv1a(seed);
  const h2 = fnv1a(seed + ':');
  const cells = Array.from({ length: 5 }, () => Array<boolean>(5).fill(false));
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if ((h2 >> (y * 3 + x)) & 1) {
        cells[y][x] = true;
        cells[y][4 - x] = true;
      }
  return { cells, rgb: hslToRgb(h % 360, 0.55, (45 + (h % 15)) / 100) };
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * The identicon as a square RGB PNG, laid out like the SPA's SVG (viewBox -0.5..5.5: a half-cell margin
 * of background around the 5×5 grid).
 */
export async function identiconPng(seed: string, size = 240) {
  const { cells, rgb } = identicon(seed);
  const unit = size / 6;
  const row = 1 + size * 3;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    const cy = Math.floor(y / unit - 0.5);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / unit - 0.5);
      const on = cx >= 0 && cx < 5 && cy >= 0 && cy < 5 && cells[cy][cx];
      raw.set(on ? rgb : IDENTICON_BACKGROUND, y * row + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB; compression, filter and interlace stay 0
  return concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', await deflate(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}
