CREATE TABLE `workflow_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`job_key` text NOT NULL,
	`name` text NOT NULL,
	`runs_on` text NOT NULL,
	`needs` text NOT NULL,
	`matrix_values` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`conclusion` text,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_jobs_run_idx` ON `workflow_jobs` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`run_number` integer NOT NULL,
	`workflow_path` text NOT NULL,
	`name` text NOT NULL,
	`event` text NOT NULL,
	`ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`display_title` text NOT NULL,
	`actor_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`conclusion` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_repo_number_uq` ON `workflow_runs` (`repository_id`,`run_number`);--> statement-breakpoint
CREATE INDEX `workflow_runs_repo_sha_idx` ON `workflow_runs` (`repository_id`,`head_sha`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`conclusion` text,
	`started_at` integer,
	`completed_at` integer,
	`log_r2_key` text,
	FOREIGN KEY (`job_id`) REFERENCES `workflow_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_steps_job_number_uq` ON `workflow_steps` (`job_id`,`number`);