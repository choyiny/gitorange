-- Rebase merging (2026-10-07). Deploy: run `yarn db:migrate:prod` (applies this and 0025_cancel_squash_resolutions),
-- then deploy the code. Both only add columns or cancel open squash-era rows (commit_sha NULL), which the new code ignores.
ALTER TABLE `merge_resolutions` ADD `commit_sha` text;--> statement-breakpoint
ALTER TABLE `merge_resolutions` ADD `resolved_files` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `landed_commits` integer;