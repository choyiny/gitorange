import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';

export function AuthShell({
  title,
  children,
  wide = false,
}: {
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="auth-form" style={wide ? { width: 440 } : undefined}>
      <div className="auth-form-header">
        <div className="d-flex flex-justify-center mt-4">
          <Logo size={48} />
        </div>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function FlashError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="flash flash-error mb-3" role="alert">
      {message}
    </div>
  );
}
