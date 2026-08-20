PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reservation_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reservation_id` integer NOT NULL,
	`product_id` integer,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` real NOT NULL,
	`discount_percent` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_reservation_items`("id", "reservation_id", "product_id", "description", "quantity", "unit_price", "discount_percent") SELECT "id", "reservation_id", "product_id", "description", "quantity", "unit_price", "discount_percent" FROM `reservation_items`;--> statement-breakpoint
DROP TABLE `reservation_items`;--> statement-breakpoint
ALTER TABLE `__new_reservation_items` RENAME TO `reservation_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `reservation_items_reservation_idx` ON `reservation_items` (`reservation_id`);