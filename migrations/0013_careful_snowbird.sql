CREATE TABLE `pr_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`land_target` text NOT NULL,
	`pr_a_id` text NOT NULL,
	`pr_b_id` text NOT NULL,
	`a_head` text NOT NULL,
	`b_head` text NOT NULL,
	`stage` text NOT NULL,
	`kind` text,
	`prerequisite` text,
	`files` text,
	`conflict_files` text,
	`reason` text,
	`instructions` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_a_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_b_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_edges_pair_uq` ON `pr_edges` (`pr_a_id`,`pr_b_id`);--> statement-breakpoint
CREATE INDEX `pr_edges_repo_idx` ON `pr_edges` (`repository_id`,`land_target`);--> statement-breakpoint
CREATE INDEX `pr_edges_b_idx` ON `pr_edges` (`pr_b_id`);