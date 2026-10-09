-- Crew redesign (2026-10-08): the redesign's only schema change. Additive: two new tables (audit_events, ai_delegations),
-- nullable or defaulted columns, and two pr_events indexes. Deploy: run `yarn db:migrate:prod`, then deploy the code.
CREATE TABLE `ai_delegations` (
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `agent_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_delegations_agent_idx` ON `ai_delegations` (`agent_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`via` text,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_repo_created_idx` ON `audit_events` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `color` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `facet` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `guarded` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `question` text;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `assignee_id` text;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `assigned_by_id` text;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `assigned_at` integer;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `teach_note` text;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `teach_by_id` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `created_via` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `session_label` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `request` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `merging_paused_at` integer;--> statement-breakpoint
ALTER TABLE `repositories` ADD `merging_paused_by_id` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `delete_merged_branches` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `language` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `language_sha` text;--> statement-breakpoint
CREATE INDEX `pr_events_repo_created_idx` ON `pr_events` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `pr_events_created_idx` ON `pr_events` (`created_at`);