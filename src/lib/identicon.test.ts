import { describe, expect, it } from 'vitest';
import { fnv1a, identiconCells } from './identicon';

describe('fnv1a', () => {
  it('is the 32-bit FNV-1a hash', () => {
    // Published FNV-1a test vectors.
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
});

describe('identiconCells', () => {
  it('is a 5×5 grid', () => {
    expect(identiconCells('octocat').cells).toHaveLength(25);
  });

  it('is deterministic', () => {
    expect(identiconCells('mahmoud')).toEqual(identiconCells('mahmoud'));
  });

  it('ignores case, like usernames', () => {
    expect(identiconCells('Mahmoud')).toEqual(identiconCells('mahmoud'));
  });

  it('mirrors columns 0↔4 and 1↔3', () => {
    for (const seed of ['mahmoud', 'cho', 'octocat', 'a', 'securityagent']) {
      const { cells } = identiconCells(seed);
      for (let y = 0; y < 5; y++) {
        expect(cells[y * 5 + 0]).toBe(cells[y * 5 + 4]);
        expect(cells[y * 5 + 1]).toBe(cells[y * 5 + 3]);
      }
    }
  });

  it('reads the 15 cells of the left half from the hash bits', () => {
    const h = fnv1a('mahmoud');
    const { cells } = identiconCells('mahmoud');
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        expect(cells[y * 5 + x]).toBe(((h >>> (y * 3 + x)) & 1) === 1);
  });

  it('colours by hue = hash % 360 at 55% saturation and 52% lightness', () => {
    const h = fnv1a('mahmoud');
    expect(identiconCells('mahmoud').color).toBe(`hsl(${h % 360} 55% 52%)`);
  });

  it('draws different people differently', () => {
    const a = identiconCells('mahmoud');
    const b = identiconCells('cho');
    expect(a.cells.join() === b.cells.join() && a.color === b.color).toBe(
      false
    );
  });
});
