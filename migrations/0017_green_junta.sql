CREATE TABLE `agents` (
	`user_id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`name` text NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`trigger_ask` text NOT NULL,
	`trigger_above` real NOT NULL,
	`engine` text DEFAULT 'pass' NOT NULL,
	`config_sha` text,
	`config_error` text,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_repository_uq` ON `agents` (`repository_id`);--> statement-breakpoint
CREATE TABLE `repository_agents` (
	`repository_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`invited_by_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `agent_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `repository_agents_agent_idx` ON `repository_agents` (`agent_id`);