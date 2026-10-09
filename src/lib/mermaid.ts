import DOMPurify from 'dompurify';

type MermaidApi = typeof import('mermaid').default;
let mermaidLoad: Promise<MermaidApi> | null = null;
let diagramCount = 0;

/** Mermaid is large, so it loads only once a page has a diagram to draw. */
function loadMermaid(dark: boolean): Promise<MermaidApi> {
  mermaidLoad ??= import('mermaid').then((m) => m.default);
  return mermaidLoad.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      // Diagrams come from repositories, models and PR titles: no scripts, links, or raw HTML.
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    return mermaid;
  });
}

/** The appearance chosen in the account menu (`<html data-theme>`), else the system's. */
const prefersDark = () => {
  const chosen = document.documentElement.getAttribute('data-theme');
  if (chosen === 'dark' || chosen === 'light') return chosen === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

/** Draws Mermaid source as sanitized SVG markup; rejects when the source doesn't parse. */
export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid(prefersDark());
  const { svg } = await mermaid.render(`mermaid-${++diagramCount}`, source);
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
  });
}
