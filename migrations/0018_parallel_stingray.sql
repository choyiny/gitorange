CREATE TABLE `pr_approvals` (
	`pull_request_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`pull_request_id`, `head_sha`, `user_id`),
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pr_reviewers` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`agent_id` text NOT NULL,
	`probability` real,
	`requested` integer NOT NULL,
	`agent_sha` text,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_reviewers_pr_head_agent_uq` ON `pr_reviewers` (`pull_request_id`,`head_sha`,`agent_id`);--> statement-breakpoint
CREATE INDEX `pr_reviewers_agent_created_idx` ON `pr_reviewers` (`agent_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `agent_id` text REFERENCES agents(user_id);--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `kind` text DEFAULT 'needs_person' NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `agent_sha` text;