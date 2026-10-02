CREATE TABLE `lfs_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`oid` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`uploaded_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lfs_objects_repo_oid_uq` ON `lfs_objects` (`repository_id`,`oid`);