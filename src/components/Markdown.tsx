import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

type MermaidApi = typeof import('mermaid').default;
let mermaidLoad: Promise<MermaidApi> | null = null;
let diagramCount = 0;

/** Mermaid is large, so it loads only once a page has a diagram to draw. */
function loadMermaid(dark: boolean): Promise<MermaidApi> {
  mermaidLoad ??= import('mermaid').then((m) => m.default);
  return mermaidLoad.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      // Diagrams come from repositories and models: no scripts, links, or raw HTML.
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    return mermaid;
  });
}

const prefersDark = () =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

/**
 * Draws every ```mermaid block in `root` as a diagram, like GitHub. A block that doesn't parse
 * stays as its source with a note.
 */
async function renderDiagrams(root: HTMLElement) {
  const blocks = [
    ...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'),
  ];
  if (!blocks.length) return;
  const mermaid = await loadMermaid(prefersDark());
  for (const code of blocks) {
    const pre = code.parentElement!;
    if (!pre.isConnected) continue;
    const source = code.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`mermaid-${++diagramCount}`, source);
      const figure = document.createElement('div');
      figure.className = 'mermaid-diagram';
      figure.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['foreignObject'],
      });
      pre.replaceWith(figure);
    } catch {
      const note = document.createElement('div');
      note.className = 'f6 color-fg-muted mt-n2 mb-3';
      note.textContent = "This diagram couldn't be drawn; showing its source.";
      pre.after(note);
    }
  }
}

/** Colors the lines of ```diff blocks: additions green, removals red. */
function colorDiffs(root: HTMLElement) {
  for (const code of root.querySelectorAll<HTMLElement>(
    'pre > code.language-diff:not([data-colored])'
  )) {
    const lines = (code.textContent ?? '').replace(/\n$/, '').split('\n');
    code.textContent = '';
    for (const line of lines) {
      const span = document.createElement('span');
      span.className =
        line[0] === '+'
          ? 'diff-line diff-line-add'
          : line[0] === '-'
            ? 'diff-line diff-line-del'
            : 'diff-line';
      span.textContent = line;
      code.append(span);
    }
    code.dataset.colored = 'true';
  }
}

export function Markdown({
  source,
  className = '',
}: {
  source: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false }) as string),
    [source]
  );
  useEffect(() => {
    if (!ref.current) return;
    colorDiffs(ref.current);
    void renderDiagrams(ref.current);
  }, [html]);
  return (
    <div
      ref={ref}
      className={`markdown-body ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
