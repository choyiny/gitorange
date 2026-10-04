import { useQuery } from '@tanstack/react-query';
import { api, qk, type ApprovalItem } from './uiApi';

/** Everything waiting on the current user; shared by the header's count and the Approvals page. */
export function useApprovals() {
  return useQuery({ queryKey: qk.approvals, queryFn: api.approvals });
}

/** How many things wait on the user: unapproved flags, failed reviews, failed resolutions. */
export function approvalCount(items: ApprovalItem[] | undefined) {
  return (items ?? []).reduce(
    (n, i) =>
      n +
      i.flags.length +
      (i.reviewFailed ? 1 : 0) +
      (i.resolutionFailed ? 1 : 0),
    0
  );
}
