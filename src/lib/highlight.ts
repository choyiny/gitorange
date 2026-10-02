/**
 * Syntax highlighting, loaded on demand (see useHighlight). Produces one HTML string per
 * source line so it slots into line-numbered tables; spans that cross a newline are closed
 * at the end of the line and reopened on the next, so every line is well-formed on its own.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import haskell from 'highlight.js/lib/languages/haskell';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  elixir,
  go,
  graphql,
  haskell,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  nginx,
  perl,
  php,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES))
  hljs.registerLanguage(name, lang);

/** Above this, highlighting costs more than it's worth; callers fall back to plain text. */
const MAX_CHARS = 300_000;

export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else if (part.startsWith('<span')) {
      open.push(part);
      line += part;
    } else if (part === '</span>') {
      open.pop();
      line += part;
    } else {
      line += part;
    }
  }
  lines.push(line + '</span>'.repeat(open.length));
  return lines;
}

/** Highlights `code` and returns one HTML string per line, or null if it can't or shouldn't. */
export function highlightLines(
  code: string,
  language: string
): string[] | null {
  if (code.length > MAX_CHARS || !hljs.getLanguage(language)) return null;
  try {
    return splitHtmlLines(
      hljs.highlight(code, { language, ignoreIllegals: true }).value
    );
  } catch {
    return null;
  }
}

/**
 * Highlights a diff hunk's lines. Each side (old: context + deletions, new: context +
 * additions) is highlighted as contiguous text so multi-line strings and comments color
 * correctly, then each diff line takes its HTML from the side it belongs to.
 */
export function highlightHunkLines(
  lines: string[],
  language: string
): (string | null)[] {
  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  const oldText: string[] = [];
  const newText: string[] = [];
  lines.forEach((l, i) => {
    const kind = l[0];
    if (kind === '\\') return;
    if (kind !== '+') {
      oldIdx.push(i);
      oldText.push(l.slice(1));
    }
    if (kind !== '-') {
      newIdx.push(i);
      newText.push(l.slice(1));
    }
  });
  const out: (string | null)[] = lines.map(() => null);
  const oldHtml = highlightLines(oldText.join('\n'), language);
  const newHtml = highlightLines(newText.join('\n'), language);
  // Context lines come from the new side; deletions from the old side.
  if (oldHtml) oldIdx.forEach((li, k) => (out[li] = oldHtml[k]));
  if (newHtml) newIdx.forEach((li, k) => (out[li] = newHtml[k]));
  return out;
}
