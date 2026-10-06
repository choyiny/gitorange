CREATE TABLE `mcp_moderators` (
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`consent_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `client_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consent_id`) REFERENCES `oauth_consents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_moderators_consent_id_idx` ON `mcp_moderators` (`consent_id`);--> statement-breakpoint
ALTER TABLE `pr_approvals` ADD `via` text;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `approved_via` text;