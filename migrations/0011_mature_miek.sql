CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_by_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_status_completed_idx` ON `workflow_runs` (`status`,`completed_at`);