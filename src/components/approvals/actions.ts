import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '@/lib/api';
import { qk } from '@/lib/uiApi';

/** After any decision: the repository's pages and everything under Approvals (the list, findings, Claude's log). */
export function useRefresh() {
  const qc = useQueryClient();
  return useCallback(
    async (owner: string, name: string) => {
      void qc.invalidateQueries({ queryKey: ['repo', owner, name] });
      await qc.invalidateQueries({ queryKey: qk.approvals });
    },
    [qc]
  );
}

/** A refusal in words. A 409 on a request for changes means the note never reached anyone. */
export function failure(e: unknown, opts: { sendingNote?: boolean } = {}) {
  return (
    errorMessage(e) +
    (e instanceof ApiError && e.status === 409 && opts.sendingNote
      ? ' Your note was not sent.'
      : '')
  );
}
