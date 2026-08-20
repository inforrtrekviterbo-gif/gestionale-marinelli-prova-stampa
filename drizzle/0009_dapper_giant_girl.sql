ALTER TABLE `business_documents` ADD `payment_method` text DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `sale_id` integer REFERENCES sales(id);--> statement-breakpoint
ALTER TABLE `sales` ADD `bank_amount` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ADD `fiscal_document_type` text DEFAULT 'receipt' NOT NULL;