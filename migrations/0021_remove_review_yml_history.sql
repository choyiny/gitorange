-- Deletes what the retired `.gitorange/review.yml` review left behind. Runs before 0022 drops pr_review_flags.source.
-- A review.yml review's id was a random UUID; a reviewer-agent review's id is always `<pull request id>-<head sha>`
-- (headReviewId, worker/src/review/keys.ts). classifying/investigating were review.yml-only statuses.
-- Children first, so nothing is left pointing at a deleted row.

-- review.yml findings (question/limit flags), and anything else on a review.yml review.
DELETE FROM pr_review_flags
 WHERE source IN ('question', 'limit')
    OR classification_id IN (
         SELECT id FROM pr_classifications
          WHERE id <> pull_request_id || '-' || head_sha OR status IN ('classifying', 'investigating'));
--> statement-breakpoint
-- Their runs in the Actions tab: a review.yml Workflow's instance (and agent run) id was `review-<review id>`.
DELETE FROM agent_steps
 WHERE run_id IN (
         SELECT 'review-' || id FROM pr_classifications
          WHERE id <> pull_request_id || '-' || head_sha OR status IN ('classifying', 'investigating'));
--> statement-breakpoint
DELETE FROM agent_runs
 WHERE id IN (
         SELECT 'review-' || id FROM pr_classifications
          WHERE id <> pull_request_id || '-' || head_sha OR status IN ('classifying', 'investigating'));
--> statement-breakpoint
-- The review.yml reviews.
DELETE FROM pr_classifications
 WHERE id <> pull_request_id || '-' || head_sha OR status IN ('classifying', 'investigating');
--> statement-breakpoint
-- Recorded pull request states explained by reasons only review.yml gave (removed from REASON_KINDS).
DELETE FROM pr_events
 WHERE kind = 'state_changed'
   AND EXISTS (
         SELECT 1 FROM json_each(pr_events.data, '$.reasons') r
          WHERE json_extract(r.value, '$.kind')
                IN ('flags_pending', 'review_running', 'review_failed', 'review_policy_invalid'));
