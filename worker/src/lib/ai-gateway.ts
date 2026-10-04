/**
 * Routes Workers AI calls through AI Gateway `AI_GATEWAY` (`default` is auto-created; `off`
 * bypasses it), tagged with feature, instance, and record metadata.
 */
export type AiFeature =
  | 'review-summary'
  | 'review-classify'
  | 'review-select'
  | 'review-investigate'
  | 'merge-resolution';

export function aiGateway(
  env: Pick<CloudflareBindings, 'AI_GATEWAY' | 'BASE_URL'>,
  feature: AiFeature,
  extra: Record<string, string> = {}
): { id: string; metadata: Record<string, string> } | undefined {
  const id = env.AI_GATEWAY?.trim() || 'default';
  if (id === 'off') return undefined;
  let instance = '';
  try {
    instance = new URL(env.BASE_URL).host;
  } catch {
    // No BASE_URL: leave the instance out.
  }
  return {
    id,
    metadata: { feature, ...(instance ? { instance } : {}), ...extra },
  };
}
