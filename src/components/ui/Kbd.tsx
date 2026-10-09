import type { ReactNode } from 'react';

/** A key as the person presses it, e.g. <Kbd>/</Kbd> or <Kbd>j</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
