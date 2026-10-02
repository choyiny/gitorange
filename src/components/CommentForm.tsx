import { useState } from 'react';
import { Markdown } from './Markdown';

export function MarkdownEditor({
  value,
  onChange,
  placeholder = 'Leave a comment',
  minHeight = 100,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  return (
    <div className="Box" style={{ overflow: 'hidden' }}>
      <div
        className="d-flex border-bottom color-bg-subtle px-2 pt-2"
        style={{ gap: 4 }}
      >
        {(['write', 'preview'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="btn-link f6 px-3 py-2"
            style={{
              border: '1px solid',
              borderColor:
                tab === t ? 'var(--borderColor-default)' : 'transparent',
              borderBottom: 0,
              borderRadius: '6px 6px 0 0',
              marginBottom: -1,
              background: tab === t ? 'var(--bgColor-default)' : 'transparent',
              color:
                tab === t ? 'var(--fgColor-default)' : 'var(--fgColor-muted)',
              textDecoration: 'none',
            }}
          >
            {t === 'write' ? 'Write' : 'Preview'}
          </button>
        ))}
      </div>
      <div className="p-2">
        {tab === 'write' ? (
          <textarea
            className="form-control width-full"
            style={{ minHeight, resize: 'vertical' }}
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <div className="p-2" style={{ minHeight }}>
            {value.trim() ? (
              <Markdown source={value} />
            ) : (
              <p className="color-fg-muted">Nothing to preview</p>
            )}
          </div>
        )}
        <p className="f6 color-fg-muted mt-1 mb-0">Markdown is supported</p>
      </div>
    </div>
  );
}
