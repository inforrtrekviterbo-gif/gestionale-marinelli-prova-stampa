ALTER TABLE `products` ADD `brand` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `variant_group` text;--> statement-breakpoint
ALTER TABLE `products` ADD `photo_key` text;