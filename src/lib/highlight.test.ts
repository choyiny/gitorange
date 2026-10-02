import { describe, expect, it } from 'vitest';
import {
  highlightHunkLines,
  highlightLines,
  splitHtmlLines,
} from './highlight';
import { languageFor } from './languages';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const balanced = (html: string) =>
  (html.match(/<span/g) ?? []).length ===
  (html.match(/<\/span>/g) ?? []).length;

describe('languageFor', () => {
  it('detects common extensions and special filenames', () => {
    expect(languageFor('src/App.tsx')).toBe('typescript');
    expect(languageFor('main.py')).toBe('python');
    expect(languageFor('a/b/Dockerfile')).toBe('dockerfile');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('config.yml')).toBe('yaml');
    expect(languageFor('LICENSE')).toBeNull();
    expect(languageFor('notes.unknownext')).toBeNull();
  });
});

describe('highlightLines', () => {
  it('returns one well-formed line per source line, preserving text', () => {
    const code =
      'def greet(name):\n    """Say\n    hello."""\n    return f"Hi {name}"\n';
    const lines = highlightLines(code, 'python')!;
    expect(lines).toHaveLength(code.split('\n').length);
    lines.forEach((l, i) => {
      expect(balanced(l)).toBe(true);
      expect(text(l)).toBe(code.split('\n')[i]);
    });
    // The docstring spans lines 2-3; both lines must carry the string color.
    expect(lines[1]).toContain('hljs-string');
    expect(lines[2]).toContain('hljs-string');
  });

  it('escapes HTML in source text', () => {
    const lines = highlightLines(
      'const x = "<img src=x onerror=alert(1)>";',
      'javascript'
    )!;
    expect(lines[0]).not.toContain('<img');
    expect(lines[0]).toContain('&lt;img');
  });

  it('declines unknown languages', () => {
    expect(highlightLines('x', 'not-a-language')).toBeNull();
  });
});

describe('splitHtmlLines', () => {
  it('reopens spans that cross a newline', () => {
    expect(splitHtmlLines('<span class="a">x\ny</span>z')).toEqual([
      '<span class="a">x</span>',
      '<span class="a">y</span>z',
    ]);
  });
});

describe('highlightHunkLines', () => {
  it('colors each diff line from its own side, keeping markers out of the code', () => {
    const lines = [
      ' /* start of a',
      '-   old comment */',
      '+   new comment */',
      ' const a = 1;',
    ];
    const html = highlightHunkLines(lines, 'javascript');
    expect(html.map((h) => text(h!))).toEqual([
      '/* start of a',
      '   old comment */',
      '   new comment */',
      'const a = 1;',
    ]);
    expect(html[1]).toContain('hljs-comment');
    expect(html[2]).toContain('hljs-comment');
    expect(html[3]).toContain('hljs-keyword');
  });
});
