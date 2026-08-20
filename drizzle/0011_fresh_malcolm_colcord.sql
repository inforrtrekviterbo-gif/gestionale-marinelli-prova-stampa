CREATE TABLE `realtime_sync_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`store` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `realtime_sync_jobs_sale_idx` ON `realtime_sync_jobs` (`sale_id`);--> statement-breakpoint
CREATE INDEX `realtime_sync_jobs_status_idx` ON `realtime_sync_jobs` (`status`,`created_at`);