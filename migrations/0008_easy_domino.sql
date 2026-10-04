CREATE TABLE `user_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`label` text,
	`verified_at` integer,
	`verification_token_hash` text,
	`verification_expires_at` integer,
	`verification_sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_emails_email_unique` ON `user_emails` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_emails_verification_token_hash_unique` ON `user_emails` (`verification_token_hash`);--> statement-breakpoint
CREATE INDEX `user_emails_user_idx` ON `user_emails` (`user_id`);