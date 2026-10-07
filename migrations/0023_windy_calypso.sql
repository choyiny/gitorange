DROP INDEX `pr_review_flags_classification_key_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `pr_review_flags_classification_key_uq` ON `pr_review_flags` (`classification_id`,`key`);--> statement-breakpoint
ALTER TABLE `pr_review_flags` DROP COLUMN `source`;