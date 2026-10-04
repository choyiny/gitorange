DROP INDEX `workflow_runs_repo_sha_idx`;--> statement-breakpoint
CREATE INDEX `workflow_runs_repo_sha_number_idx` ON `workflow_runs` (`repository_id`,`head_sha`,`run_number`);--> statement-breakpoint
CREATE INDEX `workflow_runs_repo_path_number_idx` ON `workflow_runs` (`repository_id`,`workflow_path`,`run_number`);--> statement-breakpoint
CREATE INDEX `pull_requests_state_updated_idx` ON `pull_requests` (`state`,`updated_at`);