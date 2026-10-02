CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_unique` ON `teams` (`slug`);--> statement-breakpoint
DROP INDEX `repositories_owner_name_uq`;--> statement-breakpoint
ALTER TABLE `repositories` ADD `team_id` text REFERENCES teams(id);--> statement-breakpoint
ALTER TABLE `repositories` ADD `visibility` text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_personal_name_uq` ON `repositories` (`owner_id`,`name`) WHERE team_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_team_name_uq` ON `repositories` (`team_id`,`name`) WHERE team_id IS NOT NULL;