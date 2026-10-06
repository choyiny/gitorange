DROP INDEX `pr_classifications_pr_head_policy_uq`;--> statement-breakpoint
CREATE INDEX `pr_classifications_pr_head_idx` ON `pr_classifications` (`pull_request_id`,`head_sha`);--> statement-breakpoint
ALTER TABLE `pr_classifications` DROP COLUMN `policy_sha`;--> statement-breakpoint
ALTER TABLE `pr_classifications` DROP COLUMN `answers`;--> statement-breakpoint
ALTER TABLE `pr_classifications` DROP COLUMN `verdict`;