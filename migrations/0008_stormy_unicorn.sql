ALTER TABLE `pr_review_flags` ADD `changes_requested_by_id` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `changes_requested_at` integer;--> statement-breakpoint
ALTER TABLE `pr_review_flags` ADD `changes_requested_note` text;