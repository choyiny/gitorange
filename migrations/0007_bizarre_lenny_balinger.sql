CREATE TABLE `pr_classifications` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`policy_sha` text NOT NULL,
	`status` text NOT NULL,
	`summary_model` text NOT NULL,
	`classifier_model` text NOT NULL,
	`files` text,
	`answers` text,
	`verdict` text,
	`error_message` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_classifications_pr_head_policy_uq` ON `pr_classifications` (`pull_request_id`,`head_sha`,`policy_sha`);--> statement-breakpoint
CREATE TABLE `pr_review_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`classification_id` text NOT NULL,
	`source` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`paths` text NOT NULL,
	`detail` text,
	`detail_model` text,
	`approved_by_id` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`classification_id`) REFERENCES `pr_classifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_review_flags_classification_key_uq` ON `pr_review_flags` (`classification_id`,`source`,`key`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merged_automatically` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `auto_merge_disabled_at` integer;