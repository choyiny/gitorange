CREATE TABLE `merge_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`model` text NOT NULL,
	`conflicted_paths` text NOT NULL,
	`touched_extra_paths` text,
	`explanation` text,
	`error_message` text,
	`result_sha` text,
	`transcript_r2_key` text,
	`duration_ms` integer,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `merge_resolutions_pr_idx` ON `merge_resolutions` (`pull_request_id`,`created_at`);