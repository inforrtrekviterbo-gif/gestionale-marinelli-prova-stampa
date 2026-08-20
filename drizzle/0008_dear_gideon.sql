ALTER TABLE `business_document_items` ADD `tax_rate` real DEFAULT 22 NOT NULL;--> statement-breakpoint
ALTER TABLE `business_document_items` ADD `tax_amount` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `business_document_items` ADD `gross_total` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_vat_number` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_pec` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_sdi_code` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_address` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_postal_code` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_city` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `recipient_province` text;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `net_total` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `business_documents` ADD `tax_total` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `customer_type` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `company_name` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `vat_number` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `pec` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `sdi_code` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `address` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `postal_code` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `province` text;--> statement-breakpoint
UPDATE `business_documents` SET `net_total` = `total` WHERE `net_total` = 0;--> statement-breakpoint
UPDATE `business_document_items` SET `gross_total` = `line_total` WHERE `gross_total` = 0;
