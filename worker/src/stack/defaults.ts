/** Stacking's tuning: built in (it was review.yml's `stacking:` section). */
export const STACKING_DEFAULTS = {
  /** Check a pull request against this many open ones; beyond it, only those sharing a file. */
  max_open: 20,
  /** Clef's "could these depend on each other?" probability above which a pair is related. */
  related_above: 0.3,
  /** From this confidence Clef's kind and direction stand without the reasoning model. */
  confident_above: 0.6,
};

export type StackingTuning = typeof STACKING_DEFAULTS & { model: 'clef' };

/** The tuning a stack run uses; `override` is for tests. */
export function stackingTuning(
  override: Partial<typeof STACKING_DEFAULTS> = {}
): StackingTuning {
  return { ...STACKING_DEFAULTS, ...override, model: 'clef' };
}
