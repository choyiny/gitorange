/**
 * AI Gateway: every Workers AI call goes through it, so the gateway's logs and analytics show
 * requests, tokens, and cost. `AI_GATEWAY` names the gateway; `default` is created automatically
 * on first use (any other name must exist in the account). Set it to `off` to call Workers AI
 * directly.
 *
 * Each request carries metadata — which feature made it, which instance, and the record it
 * belongs to — so cost can be filtered by feature in the gateway's logs.
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
