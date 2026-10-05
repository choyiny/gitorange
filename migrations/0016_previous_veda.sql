DROP INDEX `pr_edges_pair_uq`;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `slot` text DEFAULT 'pair' NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `for_pr_id` text;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `for_head` text;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `accounted_for_at` integer;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `accounted_head` text;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `dismissed_at` integer;--> statement-breakpoint
ALTER TABLE `pr_edges` ADD `dismissed_by_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `pr_edges_pair_uq` ON `pr_edges` (`pr_a_id`,`pr_b_id`,`slot`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `land_target` text;--> statement-breakpoint
CREATE INDEX `pull_requests_repo_target_idx` ON `pull_requests` (`repository_id`,`land_target`,`state`);