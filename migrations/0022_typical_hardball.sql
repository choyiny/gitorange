CREATE TABLE `agent_lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`finding_ids` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retryable` integer DEFAULT false NOT NULL,
	`base_sha` text,
	`commit_sha` text,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_lessons_agent_pr_uq` ON `agent_lessons` (`agent_id`,`pull_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_lessons_one_learning_uq` ON `agent_lessons` (`agent_id`) WHERE status = 'learning';--> statement-breakpoint
CREATE INDEX `agent_lessons_agent_created_idx` ON `agent_lessons` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_lessons_status_idx` ON `agent_lessons` (`status`);--> statement-breakpoint
CREATE INDEX `agent_lessons_repo_finished_idx` ON `agent_lessons` (`repository_id`,`finished_at`);