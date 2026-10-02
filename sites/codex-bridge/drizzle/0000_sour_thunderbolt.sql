CREATE TABLE `bridge_connector` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bridge_connector_owner` ON `bridge_connector` (`owner_id`);--> statement-breakpoint
CREATE TABLE `bridge_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`request_id` text,
	`tool` text NOT NULL,
	`arguments` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `idx_bridge_jobs_queue` ON `bridge_jobs` (`connector_id`,`status`,`created_at`);