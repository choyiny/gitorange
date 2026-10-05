CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`pull_request_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_runs_repo_started_idx` ON `agent_runs` (`repository_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_repo_kind_started_idx` ON `agent_runs` (`repository_id`,`kind`,`started_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_pr_started_idx` ON `agent_runs` (`pull_request_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_started_idx` ON `agent_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `agent_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_estimate` real,
	`decision` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_steps_run_position_idx` ON `agent_steps` (`run_id`,`position`);--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `agent_step_id` text;--> statement-breakpoint
CREATE INDEX `ai_usage_agent_step_idx` ON `ai_usage` (`agent_step_id`);