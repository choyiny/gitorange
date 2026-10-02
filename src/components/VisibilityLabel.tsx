import type { Visibility } from '@/lib/uiApi';

export function VisibilityLabel({
  visibility,
  className = '',
}: {
  visibility: Visibility;
  className?: string;
}) {
  return (
    <span
      className={`Label Label--secondary ${className}`}
      title={
        visibility === 'private'
          ? 'Only you, collaborators, and site admins can see this'
          : 'Every member can see this'
      }
    >
      {visibility === 'private' ? 'Private' : 'Internal'}
    </span>
  );
}
