import { describe, expect, it } from 'vitest';
import {
  inLineRange,
  isMarkdownPath,
  nextLineHash,
  encodeRepoPath,
  parentPath,
  parseLineHash,
  pathCrumbs,
  splitFrontmatter,
  splitLines,
} from './codeView';

describe('parseLineHash', () => {
  it('reads one line and a range', () => {
    expect(parseLineHash('#L12')).toEqual({ start: 12, end: 12 });
    expect(parseLineHash('#L12-L20')).toEqual({ start: 12, end: 20 });
  });
  it('orders a backwards range', () => {
    expect(parseLineHash('#L20-L12')).toEqual({ start: 12, end: 20 });
  });
  it('ignores anything else', () => {
    expect(parseLineHash('')).toBeNull();
    expect(parseLineHash('#diff-a')).toBeNull();
    expect(parseLineHash('#L0')).toBeNull();
    expect(parseLineHash('#L1-')).toBeNull();
    expect(parseLineHash('#Lx')).toBeNull();
  });
});

describe('nextLineHash', () => {
  it('selects the clicked line', () => {
    expect(nextLineHash(null, 5, false)).toBe('#L5');
    expect(nextLineHash({ start: 2, end: 3 }, 5, false)).toBe('#L5');
  });
  it('extends from the selected line on shift-click', () => {
    expect(nextLineHash({ start: 5, end: 5 }, 9, true)).toBe('#L5-L9');
    expect(nextLineHash({ start: 5, end: 5 }, 2, true)).toBe('#L2-L5');
    expect(nextLineHash({ start: 5, end: 8 }, 9, true)).toBe('#L5-L9');
  });
  it('is just the line on shift-click with nothing selected', () => {
    expect(nextLineHash(null, 4, true)).toBe('#L4');
  });
});

describe('inLineRange', () => {
  it('includes both ends', () => {
    const r = { start: 3, end: 5 };
    expect([2, 3, 4, 5, 6].map((n) => inLineRange(r, n))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(inLineRange(null, 3)).toBe(false);
  });
});

describe('splitLines', () => {
  it('drops the empty line after a final newline only', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
  });
});

describe('paths', () => {
  it('lists a path as links from the root', () => {
    expect(pathCrumbs('/o/r', 'main', 'src/lib/a.ts')).toEqual([
      { label: 'src', to: '/o/r/tree/main/src' },
      { label: 'lib', to: '/o/r/tree/main/src/lib' },
      { label: 'a.ts', to: null },
    ]);
    expect(pathCrumbs('/o/r', 'main', '')).toEqual([]);
  });
  it('encodes the segments of a path, not its slashes', () => {
    expect(encodeRepoPath('a b/c#d/e?.md')).toBe('a%20b/c%23d/e%3F.md');
    expect(encodeRepoPath('src/lib/a.ts')).toBe('src/lib/a.ts');
    expect(pathCrumbs('/o/r', 'main', 'a b/c#d/e.md')[1]).toEqual({
      label: 'c#d',
      to: '/o/r/tree/main/a%20b/c%23d',
    });
  });
  it('finds the parent directory', () => {
    expect(parentPath('a/b/c')).toBe('a/b');
    expect(parentPath('a')).toBe('');
    expect(parentPath('')).toBe('');
  });
  it('knows Markdown files', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('a/b.markdown')).toBe(true);
    expect(isMarkdownPath('README')).toBe(false);
    expect(isMarkdownPath('x.mdx')).toBe(false);
  });
});

describe('splitFrontmatter', () => {
  it('separates a leading YAML block', () => {
    const r = splitFrontmatter('---\nname: A\nbio: B\n---\n\n# Body\n');
    expect(r.frontmatter).toBe('name: A\nbio: B');
    expect(r.body).toBe('# Body\n');
  });
  it('leaves a document that does not start with one alone', () => {
    const text = '# Title\n\n---\n\ntext';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });
  it('needs the closing line', () => {
    const text = '---\nname: A\nno end';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });
  it('handles Windows line endings', () => {
    const r = splitFrontmatter('---\r\na: 1\r\n---\r\nBody');
    expect(r.frontmatter).toBe('a: 1');
    expect(r.body).toBe('Body');
  });
});
