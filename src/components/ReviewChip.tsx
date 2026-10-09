import type { Pull } from '@/lib/uiApi';
import type { Tone } from '@/lib/agentLook';
import { Chip } from '@/components/ui/Chip';

type Review = NonNullable<Pull['review']>;

const REVIEW: Record<Review['state'], { label: string; tone: Tone }> = {
  reviewing: { label: 'Reviewing…', tone: 'info' },
  review_required: { label: 'Review required', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  failed: { label: 'Review failed', tone: 'critical' },
  changes_requested: { label: 'Changes requested', tone: 'serious' },
  needs_approval: { label: 'Needs approval', tone: 'warn' },
};

/** The head commit's review in a word: Reviewing…, Review required (with its flags), Approved, and so on. */
export function ReviewChip({ review }: { review: Pull['review'] }) {
  if (!review) return null;
  const { label, tone } = REVIEW[review.state];
  const flags =
    review.state === 'review_required' && review.flags > 0
      ? ` · ${review.flags} flag${review.flags === 1 ? '' : 's'}`
      : '';
  return (
    <Chip tone={tone}>
      {label}
      {flags}
    </Chip>
  );
}
