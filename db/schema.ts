import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  store: text("store"),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("users_username_idx").on(table.username)]);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerType: text("customer_type").notNull().default("private"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  companyName: text("company_name"),
  vatNumber: text("vat_number"),
  pec: text("pec"),
  sdiCode: text("sdi_code"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  postalCode: text("postal_code"),
  city: text("city"),
  province: text("province"),
  taxCode: text("tax_code"),
  scope: text("scope").notNull(),
  createdStore: text("created_store").notNull(),
  createdAt: text("created_at").notNull(),
});

export const catalogProducts = sqliteTable("catalog_products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  brand: text("brand").notNull().default(""),
  category: text("category"),
  basePrice: real("base_price").notNull(),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  brand: text("brand").notNull().default(""),
  category: text("category"),
  color: text("color"),
  size: text("size"),
  price: real("price").notNull(),
  variantGroup: text("variant_group"),
  photoKey: text("photo_key"),
  active: integer("active").notNull().default(1),
}, (table) => [uniqueIndex("products_sku_idx").on(table.sku)]);

export const productEans = sqliteTable("product_eans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  ean: text("ean").notNull(),
}, (table) => [uniqueIndex("product_eans_ean_idx").on(table.ean)]);

export const inventory = sqliteTable("inventory", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  store: text("store").notNull(),
  quantity: integer("quantity").notNull().default(0),
  reserved: integer("reserved").notNull().default(0),
}, (table) => [uniqueIndex("inventory_product_store_idx").on(table.productId, table.store)]);

export const sales = sqliteTable("sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  receiptNo: text("receipt_no").notNull(),
  store: text("store").notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  type: text("type").notNull(),
  subtotal: real("subtotal").notNull(),
  adjustment: real("adjustment").notNull().default(0),
  total: real("total").notNull(),
  cashAmount: real("cash_amount").notNull().default(0),
  cardAmount: real("card_amount").notNull().default(0),
  bankAmount: real("bank_amount").notNull().default(0),
  giftAmount: real("gift_amount").notNull().default(0),
  giftCodeUsed: text("gift_code_used"),
  fiscalStatus: text("fiscal_status").notNull().default("pending"),
  fiscalDocumentType: text("fiscal_document_type").notNull().default("receipt"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("sales_receipt_no_idx").on(table.receiptNo)]);

export const saleItems = sqliteTable("sale_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: integer("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id),
  description: text("description").notNull(),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  lineTotal: real("line_total").notNull(),
  discountPercent: real("discount_percent").notNull().default(0),
  itemType: text("item_type").notNull(),
  metadata: text("metadata"),
});

export const fiscalDevices = sqliteTable("fiscal_devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  store: text("store").notNull(),
  vendor: text("vendor").notNull(),
  model: text("model").notNull(),
  connector: text("connector").notNull(),
  tokenHash: text("token_hash"),
  enabled: integer("enabled").notNull().default(0),
  lastSeenAt: text("last_seen_at"),
  lastStatus: text("last_status").notNull().default("not_configured"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("fiscal_devices_store_idx").on(table.store)]);

export const fiscalJobs = sqliteTable("fiscal_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: integer("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  store: text("store").notNull(),
  jobType: text("job_type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  deviceResponse: text("device_response"),
  createdAt: text("created_at").notNull(),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("fiscal_jobs_sale_idx").on(table.saleId),
  index("fiscal_jobs_store_status_idx").on(table.store, table.status, table.createdAt),
]);

export const realtimeSyncJobs = sqliteTable("realtime_sync_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleId: integer("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  store: text("store").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("realtime_sync_jobs_sale_idx").on(table.saleId),
  index("realtime_sync_jobs_status_idx").on(table.status, table.createdAt),
]);

export const giftCards = sqliteTable("gift_cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  beneficiary: text("beneficiary").notNull(),
  initialValue: real("initial_value").notNull(),
  balance: real("balance").notNull(),
  expiresAt: text("expires_at").notNull(),
  store: text("store").notNull(),
  issuedSaleId: integer("issued_sale_id").notNull().references(() => sales.id),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("gift_cards_code_idx").on(table.code)]);

export const reservations = sqliteTable("reservations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  store: text("store").notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  productId: integer("product_id").references(() => products.id),
  description: text("description").notNull(),
  kind: text("kind").notNull(),
  totalPrice: real("total_price").notNull(),
  depositAmount: real("deposit_amount").notNull(),
  balanceDue: real("balance_due").notNull(),
  status: text("status").notNull(),
  issuedSaleId: integer("issued_sale_id").notNull().references(() => sales.id),
  redeemedSaleId: integer("redeemed_sale_id").references(() => sales.id),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("reservations_code_idx").on(table.code)]);

export const reservationItems = sqliteTable("reservation_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reservationId: integer("reservation_id").notNull().references(() => reservations.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  discountPercent: real("discount_percent").notNull().default(0),
}, (table) => [index("reservation_items_reservation_idx").on(table.reservationId)]);

export const transfers = sqliteTable("transfers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  fromStore: text("from_store").notNull(),
  toStore: text("to_store").notNull(),
  sender: text("sender").notNull(),
  receiver: text("receiver").notNull(),
  carrier: text("carrier").notNull(),
  transportReason: text("transport_reason").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("transfers_code_idx").on(table.code)]);

export const transferItems = sqliteTable("transfer_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transferId: integer("transfer_id").notNull().references(() => transfers.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  quantity: integer("quantity").notNull(),
});

export const businessDocuments = sqliteTable("business_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull(),
  type: text("type").notNull(),
  customerId: integer("customer_id").references(() => customers.id),
  recipient: text("recipient").notNull(),
  recipientVatNumber: text("recipient_vat_number"),
  recipientPec: text("recipient_pec"),
  recipientSdiCode: text("recipient_sdi_code"),
  recipientAddress: text("recipient_address"),
  recipientPostalCode: text("recipient_postal_code"),
  recipientCity: text("recipient_city"),
  recipientProvince: text("recipient_province"),
  origin: text("origin").notNull(),
  paymentMethod: text("payment_method").notNull().default("cash"),
  saleId: integer("sale_id").references(() => sales.id),
  netTotal: real("net_total").notNull().default(0),
  taxTotal: real("tax_total").notNull().default(0),
  total: real("total").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("business_documents_number_idx").on(table.number)]);

export const businessDocumentItems = sqliteTable("business_document_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  documentId: integer("document_id").notNull().references(() => businessDocuments.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id),
  description: text("description").notNull(),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  lineTotal: real("line_total").notNull(),
  taxRate: real("tax_rate").notNull().default(22),
  taxAmount: real("tax_amount").notNull().default(0),
  grossTotal: real("gross_total").notNull().default(0),
});
