CREATE TABLE `fiscal_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`vendor` text NOT NULL,
	`model` text NOT NULL,
	`connector` text NOT NULL,
	`token_hash` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text,
	`last_status` text DEFAULT 'not_configured' NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_devices_store_idx` ON `fiscal_devices` (`store`);--> statement-breakpoint
CREATE TABLE `fiscal_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`store` text NOT NULL,
	`job_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`device_response` text,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_jobs_sale_idx` ON `fiscal_jobs` (`sale_id`);--> statement-breakpoint
CREATE INDEX `fiscal_jobs_store_status_idx` ON `fiscal_jobs` (`store`,`status`,`created_at`);