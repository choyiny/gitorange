import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({
  source,
  className = '',
}: {
  source: string;
  className?: string;
}) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false }) as string),
    [source]
  );
  return (
    <div
      className={`markdown-body ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
