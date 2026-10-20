CREATE TABLE `release_pulls` (
	`release_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	PRIMARY KEY(`release_id`, `pull_request_id`),
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_pulls_pull_uq` ON `release_pulls` (`pull_request_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`tag` text NOT NULL,
	`major` integer NOT NULL,
	`minor` integer NOT NULL,
	`patch` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`title` text NOT NULL,
	`notes` text NOT NULL,
	`created_by_id` text,
	`previous_release_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_repo_tag_uq` ON `releases` (`repository_id`,`tag`);--> statement-breakpoint
CREATE INDEX `releases_repo_version_idx` ON `releases` (`repository_id`,`major`,`minor`,`patch`);--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `version_bump` text;