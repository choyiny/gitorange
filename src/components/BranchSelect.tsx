import { useState } from 'react';
import {
  GitBranchIcon,
  TriangleDownIcon,
  CheckIcon,
} from '@primer/octicons-react';
import { Dropdown } from './Dropdown';

export function BranchSelect({
  branches,
  current,
  onSelect,
  label,
  defaultBranch,
}: {
  branches: { name: string }[];
  current: string;
  onSelect: (name: string) => void;
  label?: string;
  defaultBranch?: string;
}) {
  const [filter, setFilter] = useState('');
  const shown = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <Dropdown
      trigger={(_, toggle) => (
        <button
          className="btn d-inline-flex flex-items-center"
          style={{ gap: 6, maxWidth: 260 }}
          onClick={toggle}
        >
          <GitBranchIcon className="color-fg-muted" />
          {label && <span className="color-fg-muted">{label}</span>}
          <span
            className="css-truncate css-truncate-target text-bold"
            style={{ maxWidth: 160 }}
          >
            {current}
          </span>
          <TriangleDownIcon />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-3 py-2 border-bottom d-flex flex-justify-between">
            <span className="text-bold f5">Switch branches</span>
          </div>
          <div className="p-2 border-bottom">
            <input
              autoFocus
              className="form-control input-sm width-full"
              placeholder="Find a branch..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }} className="py-1">
            {shown.length === 0 && (
              <div className="px-3 py-2 color-fg-muted f6">Nothing to show</div>
            )}
            {shown.map((b) => (
              <button
                key={b.name}
                className="select-panel-item"
                onClick={() => {
                  onSelect(b.name);
                  close();
                }}
              >
                <span style={{ width: 16 }}>
                  {b.name === current && <CheckIcon />}
                </span>
                <span className="flex-1 text-truncate">{b.name}</span>
                {b.name === defaultBranch && (
                  <span className="Label">default</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </Dropdown>
  );
}
