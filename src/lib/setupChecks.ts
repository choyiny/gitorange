import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

export type SetupStatus = 'ok' | 'warning' | 'error';
export type SetupStep = { text: string; code?: string; link?: string };
export type SetupCheck = {
  id: string;
  category: string;
  title: string;
  status: SetupStatus;
  detail: string;
  fix: SetupStep[];
};
export type SetupReport = {
  checks: SetupCheck[];
  counts: Record<SetupStatus, number>;
  checkedAt: string;
};
export type AiTestResult = {
  ok: boolean;
  gateway: string | null;
  logged: boolean;
  detail: string;
};

export const setupKey = ['admin', 'setup'] as const;

/** Site admin → Setup's checks. Shared by the Setup section and the header's error badge. */
export function useSetupChecks(enabled = true) {
  return useQuery({
    queryKey: setupKey,
    queryFn: () => apiFetch<SetupReport>('/api/admin/setup'),
    enabled,
    // Probes are cheap but not free; the header shouldn't re-run them on every page.
    staleTime: 5 * 60_000,
  });
}

export const testAiGateway = () =>
  apiFetch<AiTestResult>('/api/admin/setup/ai-test', { method: 'POST' });
