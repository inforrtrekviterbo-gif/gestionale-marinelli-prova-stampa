CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sale_items` ADD `discount_percent` real DEFAULT 0 NOT NULL;