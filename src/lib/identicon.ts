/** 32-bit FNV-1a over UTF-16 code units (the same as bytes for ASCII usernames). */
export function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A GitHub-style identicon: a 5×5 grid, mirrored left to right, so 15 cells (columns 0–2 of each row) come
 * from the low 15 bits of the hash of the lower-cased name. Cells are row-major: index = row * 5 + column.
 */
export function identiconCells(seed: string): {
  color: string;
  cells: boolean[];
} {
  const h = fnv1a(seed.toLowerCase());
  const cells = new Array<boolean>(25).fill(false);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const on = ((h >>> (y * 3 + x)) & 1) === 1;
      cells[y * 5 + x] = on;
      cells[y * 5 + (4 - x)] = on;
    }
  }
  return { color: `hsl(${h % 360} 55% 52%)`, cells };
}
