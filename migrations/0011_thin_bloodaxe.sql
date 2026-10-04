CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`repository_id` text,
	`pull_request_id` text,
	`classification_id` text,
	`merge_resolution_id` text,
	`requests` integer DEFAULT 1 NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`tokens_cached` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `runner_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`repository_id` text,
	`instance_type` text NOT NULL,
	`started_at` integer NOT NULL,
	`stopped_at` integer,
	`deadline_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `workflow_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runner_sessions_started_idx` ON `runner_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `runner_sessions_job_idx` ON `runner_sessions` (`job_id`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`date` text NOT NULL,
	`product` text NOT NULL,
	`metric` text NOT NULL,
	`resource` text DEFAULT '' NOT NULL,
	`quantity` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`date`, `metric`, `resource`)
);
--> statement-breakpoint
CREATE TABLE `usage_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`errors` text NOT NULL
);
