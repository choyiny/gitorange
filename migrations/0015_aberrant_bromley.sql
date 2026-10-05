CREATE TABLE `pr_events` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text,
	`data` text,
	`actor_id` text,
	`computed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pr_events_pr_kind_idx` ON `pr_events` (`pull_request_id`,`kind`,`computed_at`);