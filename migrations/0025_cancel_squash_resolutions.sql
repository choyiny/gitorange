-- Rebase merging (2026-10-07): squash-era AI resolutions are cancelled. A queued, running or proposed row without a
-- commit_sha was a whole-pull-request resolution that merging would have landed; nothing lands one any more.
-- Deploy: `yarn db:migrate:prod` applies 0024 and this one together, before the code deploy. A squash-era row the old
-- code still writes in the gap (commit_sha NULL) is ignored by the new code's readers. Rows with a commit_sha are the
-- new per-commit resolutions and are never touched.
UPDATE merge_resolutions
   SET status = 'failed', error_message = 'Superseded by newer commits.', decided_at = unixepoch()
 WHERE commit_sha IS NULL
   AND status IN ('queued', 'running', 'proposed');
