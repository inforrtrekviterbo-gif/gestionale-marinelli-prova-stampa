import { clearRealtimeSales, saveSaleToRealtimeDatabase, verifiedFirebaseIdentityFromRequest, type VerifiedFirebaseIdentity } from "../../../lib/firebase-server";
import { currentUser, database, ean13, ensureDatabase, hashToken, idCode, json, type SessionUser, type Store } from "../../../lib/runtime-db";

type JsonMap = Record<string, unknown>;
type CartItem = {
  productId: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  itemType: string;
  metadata: JsonMap;
};

type ReservationLine = {
  productId: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
};

type DocumentLine = {
  productId: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
};

type ProductRow = Record<string, unknown> & {
  viterboQty: number;
  viterboReserved: number;
  granSassoQty: number;
  granSassoReserved: number;
};

type CustomerRow = Record<string, unknown> & { createdStore: string };

type FiscalReference = {
  date: string;
  closureNo: string;
  documentNo: string;
  serial?: string;
};

const storeNames: Store[] = ["Viterbo", "Gran Sasso"];

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectValue(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function validStore(value: unknown): value is Store {
  return typeof value === "string" && storeNames.includes(value as Store);
}

function randomLocalTicket() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fiscalReferenceFromResponse(value: string | null | undefined): FiscalReference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { fiscalReference?: Partial<FiscalReference> };
    const reference = parsed.fiscalReference;
    if (reference?.date && reference.closureNo && reference.documentNo) {
      return {
        date: String(reference.date),
        closureNo: String(reference.closureNo),
        documentNo: String(reference.documentNo),
        ...(reference.serial ? { serial: String(reference.serial) } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeItems(value: unknown): CartItem[] {
  return arrayValue(value).map((entry) => {
    const row = objectValue(entry);
    return {
      productId: row.productId == null ? null : numberValue(row.productId),
      description: stringValue(row.description),
      quantity: numberValue(row.quantity, 1),
      unitPrice: numberValue(row.unitPrice),
      discountPercent: Math.min(100, Math.max(0, numberValue(row.discountPercent))),
      itemType: stringValue(row.itemType, "product"),
      metadata: objectValue(row.metadata),
    };
  }).filter((item) => item.description && item.quantity !== 0);
}

function normalizeReservationLines(value: unknown): ReservationLine[] {
  return arrayValue(value).map((entry) => {
    const row = objectValue(entry);
    return {
      productId: row.productId == null ? null : Math.round(numberValue(row.productId)),
      description: stringValue(row.description),
      quantity: Math.max(1, Math.round(numberValue(row.quantity, 1))),
      unitPrice: Math.max(0, numberValue(row.unitPrice)),
      discountPercent: Math.min(100, Math.max(0, numberValue(row.discountPercent))),
    };
  }).filter((item) => item.description && (item.productId == null || item.productId > 0));
}

function normalizeDocumentLines(value: unknown): DocumentLine[] {
  return arrayValue(value).map((entry) => {
    const row = objectValue(entry);
    return {
      productId: row.productId == null ? null : Math.round(numberValue(row.productId)),
      description: stringValue(row.description),
      quantity: Math.max(0, numberValue(row.quantity, 1)),
      unitPrice: Math.max(0, numberValue(row.unitPrice)),
      taxRate: Math.min(100, Math.max(0, numberValue(row.taxRate, 22))),
    };
  }).filter((item) => item.description && item.quantity > 0);
}

async function all<T>(sql: string, ...bindings: unknown[]) {
  const result = await database().prepare(sql).bind(...bindings).all<T>();
  return result.results ?? [];
}

async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) return { response: json({ error: "Sessione scaduta." }, 401), user: null };
  return { response: null, user };
}

function firebaseIdentityMatchesUser(identity: VerifiedFirebaseIdentity, user: SessionUser) {
  return identity.profile.username === user.username && identity.profile.role === user.role && identity.profile.store === user.store;
}

async function syncPendingRealtimeSales(identity: VerifiedFirebaseIdentity, limit = 10) {
  const rows = identity.profile.role === "admin"
    ? await all<{ id: number; payload: string }>(`SELECT id, payload FROM realtime_sync_jobs WHERE status <> 'synced' ORDER BY created_at LIMIT ?`, limit)
    : await all<{ id: number; payload: string }>(`SELECT id, payload FROM realtime_sync_jobs WHERE status <> 'synced' AND store = ? ORDER BY created_at LIMIT ?`, identity.profile.store, limit);
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as Parameters<typeof saveSaleToRealtimeDatabase>[1];
      await saveSaleToRealtimeDatabase(identity, payload);
      await database().prepare(`UPDATE realtime_sync_jobs SET status = 'synced', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), row.id).run();
    } catch (error) {
      await database().prepare(`UPDATE realtime_sync_jobs SET status = 'pending', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`)
        .bind(error instanceof Error ? error.message.slice(0, 500) : "Errore Firebase", new Date().toISOString(), row.id).run();
    }
  }
}

async function productRows() {
  return all<ProductRow>(`SELECT p.id, p.sku, p.name, p.brand, p.category, p.color, p.size, p.price, p.variant_group AS variantGroup, p.photo_key AS photoKey,
    COALESCE(GROUP_CONCAT(DISTINCT pe.ean), '') AS eans,
    COALESCE(MAX(CASE WHEN i.store = 'Viterbo' THEN i.quantity END), 0) AS viterboQty,
    COALESCE(MAX(CASE WHEN i.store = 'Viterbo' THEN i.reserved END), 0) AS viterboReserved,
    COALESCE(MAX(CASE WHEN i.store = 'Gran Sasso' THEN i.quantity END), 0) AS granSassoQty,
    COALESCE(MAX(CASE WHEN i.store = 'Gran Sasso' THEN i.reserved END), 0) AS granSassoReserved
    FROM products p
    LEFT JOIN product_eans pe ON pe.product_id = p.id
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE p.active = 1
    GROUP BY p.id ORDER BY p.name, p.color, p.size`);
}

async function customerRows() {
  return all<CustomerRow>(`SELECT id, customer_type AS customerType, first_name AS firstName, last_name AS lastName, company_name AS companyName, vat_number AS vatNumber, pec, sdi_code AS sdiCode, phone, email, address, postal_code AS postalCode, city, province, tax_code AS taxCode, scope, created_store AS createdStore, created_at AS createdAt FROM customers WHERE active = 1 ORDER BY CASE WHEN customer_type = 'company' THEN company_name ELSE last_name END, first_name LIMIT 1000`);
}

async function bootstrap(user: SessionUser) {
  const rawProducts = await productRows();
  const products = user.role === "admin" ? rawProducts : rawProducts.map((product) => user.store === "Viterbo"
    ? { ...product, granSassoQty: 0, granSassoReserved: 0 }
    : { ...product, viterboQty: 0, viterboReserved: 0 });
  const allCustomers = await customerRows();
  const customers = user.role === "admin" ? allCustomers : allCustomers.filter((customer) => customer.createdStore === user.store);
  const allSales = await all<{ store: string } & Record<string, unknown>>(`SELECT s.id, s.receipt_no AS receiptNo, s.store, s.customer_id AS customerId, s.type, s.subtotal, s.adjustment, s.total, s.cash_amount AS cashAmount, s.card_amount AS cardAmount, s.bank_amount AS bankAmount, s.gift_amount AS giftAmount, s.fiscal_status AS fiscalStatus, s.fiscal_document_type AS fiscalDocumentType, s.created_at AS createdAt, COALESCE(CASE WHEN c.customer_type = 'company' THEN c.company_name ELSE TRIM(c.first_name || ' ' || c.last_name) END, 'Cliente non associato') AS customerName FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ORDER BY s.created_at DESC LIMIT 300`);
  const sales = user.role === "admin" ? allSales : allSales.filter((sale) => sale.store === user.store);
  const giftRows = await all<{ store: string } & Record<string, unknown>>(`SELECT id, code, beneficiary, initial_value AS initialValue, balance, expires_at AS expiresAt, store, issued_sale_id AS issuedSaleId, status, created_at AS createdAt FROM gift_cards WHERE status <> 'deleted' ORDER BY created_at DESC LIMIT 500`);
  const reservationRows = await all<{ store: string } & Record<string, unknown>>(`SELECT r.id, r.code, r.store, r.customer_id AS customerId, r.product_id AS productId, r.description, r.kind, r.total_price AS totalPrice, r.deposit_amount AS depositAmount, r.balance_due AS balanceDue, r.status, r.issued_sale_id AS issuedSaleId, r.created_at AS createdAt, COALESCE(CASE WHEN c.customer_type = 'company' THEN c.company_name ELSE TRIM(c.first_name || ' ' || c.last_name) END, '') AS customerName, (SELECT COALESCE(SUM(ri.quantity), 0) FROM reservation_items ri WHERE ri.reservation_id = r.id) AS itemCount, (SELECT COALESCE(GROUP_CONCAT(ri.description, ' '), '') FROM reservation_items ri WHERE ri.reservation_id = r.id) AS itemDescriptions FROM reservations r LEFT JOIN customers c ON c.id = r.customer_id ORDER BY r.created_at DESC LIMIT 500`);
  const transferRows = await all<{ fromStore: string } & Record<string, unknown>>(`SELECT t.id, t.code, t.from_store AS fromStore, t.to_store AS toStore, t.sender, t.receiver, t.carrier, t.transport_reason AS transportReason, t.created_at AS createdAt, COUNT(ti.id) AS lineCount, COALESCE(SUM(ti.quantity), 0) AS totalQuantity FROM transfers t LEFT JOIN transfer_items ti ON ti.transfer_id = t.id GROUP BY t.id ORDER BY t.created_at DESC LIMIT 300`);
  const gifts = user.role === "admin" ? giftRows : giftRows.filter((gift) => gift.store === user.store);
  const reservations = user.role === "admin" ? reservationRows : reservationRows.filter((reservation) => reservation.store === user.store);
  const transfers = user.role === "admin" ? transferRows : transferRows.filter((transfer) => transfer.fromStore === user.store);
  const documents = user.role === "admin" ? await all(`SELECT id, number, type, recipient, origin, payment_method AS paymentMethod, sale_id AS saleId, net_total AS netTotal, tax_total AS taxTotal, total, created_at AS createdAt FROM business_documents ORDER BY created_at DESC LIMIT 300`) : [];
  const saleItems = user.role === "admin" ? await all(`SELECT si.id, si.sale_id AS saleId, si.product_id AS productId, si.description, si.quantity, si.line_total AS lineTotal, si.item_type AS itemType, s.store, s.created_at AS createdAt, COALESCE(p.brand, '') AS brand, COALESCE(p.name, si.description) AS productName, COALESCE(p.color, '') AS color, COALESCE(p.size, '') AS size, COALESCE(p.variant_group, '') AS variantGroup FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p ON p.id = si.product_id ORDER BY s.created_at DESC LIMIT 5000`) : [];
  const allFiscalDevices = await all<{ store: string } & Record<string, unknown>>(`SELECT id, store, vendor, model, connector, enabled, token_hash IS NOT NULL AS hasToken, last_seen_at AS lastSeenAt, last_status AS lastStatus, last_error AS lastError, updated_at AS updatedAt FROM fiscal_devices ORDER BY store DESC`);
  const allFiscalJobs = await all<{ store: string } & Record<string, unknown>>(`SELECT fj.id, fj.sale_id AS saleId, fj.store, fj.job_type AS jobType, fj.status, fj.attempts, fj.device_response AS deviceResponse, fj.created_at AS createdAt, fj.claimed_at AS claimedAt, fj.completed_at AS completedAt, s.receipt_no AS receiptNo FROM fiscal_jobs fj JOIN sales s ON s.id = fj.sale_id ORDER BY fj.created_at DESC LIMIT 100`);
  const fiscalDevices = user.role === "admin" ? allFiscalDevices : allFiscalDevices.filter((device) => device.store === user.store);
  const fiscalJobs = user.role === "admin" ? allFiscalJobs : allFiscalJobs.filter((job) => job.store === user.store);
  return { user, products, customers, sales, gifts, reservations, transfers, documents, saleItems, fiscalDevices, fiscalJobs, generatedAt: new Date().toISOString() };
}

export async function GET(request: Request) {
  await ensureDatabase();
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const firebaseIdentity = await verifiedFirebaseIdentityFromRequest(request);
  if (firebaseIdentity && firebaseIdentityMatchesUser(firebaseIdentity, auth.user)) await syncPendingRealtimeSales(firebaseIdentity, 5);
  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "bootstrap";

  if (view === "bootstrap") return json(await bootstrap(auth.user), 200, { "Cache-Control": "private, no-store, max-age=0" });
  if (view === "transfer") {
    if (auth.user.role !== "admin") return json({ error: "Funzione riservata all'amministratore." }, 403);
    const transferId = Math.round(numberValue(url.searchParams.get("id")));
    const transfer = await database().prepare(`SELECT id, code, from_store AS fromStore, to_store AS toStore, sender, receiver, carrier, transport_reason AS transportReason, created_at AS createdAt FROM transfers WHERE id = ?`).bind(transferId).first();
    if (!transfer) return json({ error: "Trasferimento non trovato." }, 404);
    const items = await all(`SELECT ti.product_id AS productId, ti.quantity, p.name, p.brand, p.color, p.size FROM transfer_items ti JOIN products p ON p.id = ti.product_id WHERE ti.transfer_id = ? ORDER BY ti.id`, transferId);
    return json({ transfer, items });
  }
  if (view === "customer") {
    const customerId = numberValue(url.searchParams.get("id"));
    const customer = await database().prepare(`SELECT id, customer_type AS customerType, first_name AS firstName, last_name AS lastName, company_name AS companyName, vat_number AS vatNumber, pec, sdi_code AS sdiCode, phone, email, address, postal_code AS postalCode, city, province, tax_code AS taxCode, scope, created_store AS createdStore FROM customers WHERE id = ?`).bind(customerId).first<{ createdStore: string } & Record<string, unknown>>();
    if (!customer || (auth.user.role !== "admin" && customer.createdStore !== auth.user.store)) return json({ error: "Cliente non disponibile per questa cassa." }, 404);
    const sales = auth.user.role === "admin"
      ? await all(`SELECT id, receipt_no AS receiptNo, store, type, total, created_at AS createdAt FROM sales WHERE customer_id = ? ORDER BY created_at DESC`, customerId)
      : await all(`SELECT id, receipt_no AS receiptNo, store, type, total, created_at AS createdAt FROM sales WHERE customer_id = ? AND store = ? ORDER BY created_at DESC`, customerId, auth.user.store);
    const items = auth.user.role === "admin"
      ? await all(`SELECT si.id, si.sale_id AS saleId, si.description, si.quantity, si.unit_price AS unitPrice, si.line_total AS lineTotal, si.item_type AS itemType FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.customer_id = ? ORDER BY s.created_at DESC`, customerId)
      : await all(`SELECT si.id, si.sale_id AS saleId, si.description, si.quantity, si.unit_price AS unitPrice, si.line_total AS lineTotal, si.item_type AS itemType FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.customer_id = ? AND s.store = ? ORDER BY s.created_at DESC`, customerId, auth.user.store);
    return json({ customer, sales, items });
  }
  if (view === "returnPrice") {
    const code = stringValue(url.searchParams.get("q"));
    const receipt = stringValue(url.searchParams.get("receipt"));
    const requestedStore = url.searchParams.get("store");
    const store = auth.user.store ?? (validStore(requestedStore) ? requestedStore : "Viterbo");
    const product = await database().prepare(`SELECT p.id, p.sku, p.name, p.color, p.size, p.price FROM products p JOIN product_eans pe ON pe.product_id = p.id WHERE pe.ean = ?`).bind(code).first<{ id: number; sku: string; name: string; color: string; size: string; price: number }>();
    if (!product) return json({ error: "EAN prodotto non riconosciuto." }, 404);
    type ReturnSaleRow = { saleItemId: number; saleId: number; productId: number; description: string; itemType: string; lineTotal: number; quantity: number; unitPrice: number; discountPercent: number; subtotal: number; total: number; receiptNo: string; createdAt: string; customerName: string; originalGiftCode: string | null; returnedQty: number };
    const saleFields = `SELECT si.id AS saleItemId, s.id AS saleId, si.product_id AS productId, si.description, si.item_type AS itemType, si.line_total AS lineTotal, si.quantity, si.unit_price AS unitPrice, si.discount_percent AS discountPercent, s.subtotal, s.total, s.receipt_no AS receiptNo, s.created_at AS createdAt, s.gift_code_used AS originalGiftCode,
      COALESCE(CASE WHEN c.customer_type = 'company' THEN c.company_name ELSE TRIM(c.first_name || ' ' || c.last_name) END, 'Cliente non associato') AS customerName,
      COALESCE((SELECT SUM(ABS(returned.quantity)) FROM sale_items returned WHERE returned.item_type = 'return' AND (CAST(json_extract(returned.metadata, '$.originalSaleItemId') AS INTEGER) = si.id OR (json_extract(returned.metadata, '$.originalSaleItemId') IS NULL AND returned.product_id = si.product_id AND json_extract(returned.metadata, '$.originalReceipt') = s.receipt_no))), 0) AS returnedQty
      FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN customers c ON c.id = s.customer_id
      WHERE si.product_id = ? AND si.item_type = 'product' AND si.quantity > 0 AND s.store = ?`;
    const soldRows = receipt
      ? await all<ReturnSaleRow>(`${saleFields} AND s.receipt_no = ? ORDER BY s.created_at DESC LIMIT 20`, product.id, store, receipt)
      : await all<ReturnSaleRow>(`${saleFields} ORDER BY s.created_at DESC LIMIT 20`, product.id, store);
    const sold = soldRows.map((row) => {
      const purchasedQty = Math.abs(Number(row.quantity) || 0);
      const returnedQty = Math.min(purchasedQty, Math.abs(Number(row.returnedQty) || 0));
      const adjustmentFactor = Math.abs(Number(row.subtotal)) > 0.001 ? Number(row.total) / Number(row.subtotal) : 1;
      const finalUnitPrice = purchasedQty ? Math.round(Math.max(0, Math.abs(Number(row.lineTotal) * adjustmentFactor) / purchasedQty) * 100) / 100 : 0;
      return { ...row, purchasedQty, returnedQty, returnableQty: Math.max(0, purchasedQty - returnedQty), finalUnitPrice };
    }).find((row) => row.returnableQty > 0);
    if (!sold) return json({ error: receipt ? "Il prodotto non risulta disponibile per il reso nello scontrino indicato." : "Nessuna vendita disponibile per il reso trovata con questo EAN." }, 404);
    return json({ product, salePrice: sold.finalUnitPrice, historical: true, sale: sold });
  }
  if (view === "returnReceipt") {
    const receipt = stringValue(url.searchParams.get("receipt"));
    const requestedStore = url.searchParams.get("store");
    const store = auth.user.store ?? (validStore(requestedStore) ? requestedStore : "Viterbo");
    if (!receipt) return json({ error: "Inserisci il numero dello scontrino originale." }, 400);
    const sale = await database().prepare(`SELECT s.id, s.receipt_no AS receiptNo, s.subtotal, s.total, s.created_at AS createdAt, s.gift_code_used AS originalGiftCode,
      COALESCE(CASE WHEN c.customer_type = 'company' THEN c.company_name ELSE TRIM(c.first_name || ' ' || c.last_name) END, 'Cliente non associato') AS customerName
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.receipt_no = ? AND s.store = ?`).bind(receipt, store).first<{ id: number; receiptNo: string; subtotal: number; total: number; createdAt: string; originalGiftCode: string | null; customerName: string }>();
    if (!sale) return json({ error: "Scontrino non trovato per questa cassa." }, 404);
    const rows = await all<{ saleItemId: number; productId: number | null; description: string; itemType: string; quantity: number; unitPrice: number; discountPercent: number; lineTotal: number; returnedQty: number }>(`SELECT si.id AS saleItemId, si.product_id AS productId, si.description, si.item_type AS itemType, si.quantity, si.unit_price AS unitPrice, si.discount_percent AS discountPercent, si.line_total AS lineTotal,
      COALESCE((SELECT SUM(ABS(returned.quantity)) FROM sale_items returned WHERE returned.item_type = 'return' AND CAST(json_extract(returned.metadata, '$.originalSaleItemId') AS INTEGER) = si.id), 0) AS returnedQty
      FROM sale_items si WHERE si.sale_id = ? AND si.quantity > 0 AND (
        si.item_type = 'product' OR (si.item_type = 'service' AND (json_extract(si.metadata, '$.category') = 'Varie' OR si.description LIKE 'Varie · %'))
      ) ORDER BY si.id`, sale.id);
    const adjustmentFactor = Math.abs(Number(sale.subtotal)) > 0.001 ? Number(sale.total) / Number(sale.subtotal) : 1;
    const items = rows.map((row) => {
      const purchasedQty = Math.abs(Number(row.quantity) || 0);
      const returnedQty = Math.min(purchasedQty, Math.abs(Number(row.returnedQty) || 0));
      const finalUnitPrice = purchasedQty ? Math.round(Math.max(0, Math.abs(Number(row.lineTotal) * adjustmentFactor) / purchasedQty) * 100) / 100 : 0;
      return { ...row, saleId: sale.id, receiptNo: sale.receiptNo, createdAt: sale.createdAt, customerName: sale.customerName, originalGiftCode: sale.originalGiftCode, purchasedQty, returnedQty, returnableQty: Math.max(0, purchasedQty - returnedQty), finalUnitPrice };
    }).filter((row) => row.returnableQty > 0);
    if (!items.length) return json({ error: "Lo scontrino non contiene prodotti o vendite Varie ancora restituibili." }, 404);
    return json({ sale, items });
  }
  if (view === "code") {
    const code = stringValue(url.searchParams.get("q"));
    const gift = auth.user.role === "admin"
      ? await database().prepare(`SELECT code, beneficiary, balance, expires_at AS expiresAt, status FROM gift_cards WHERE code = ? AND status <> 'deleted'`).bind(code).first()
      : await database().prepare(`SELECT code, beneficiary, balance, expires_at AS expiresAt, status FROM gift_cards WHERE code = ? AND store = ? AND status <> 'deleted'`).bind(code, auth.user.store).first();
    if (gift) return json({ kind: "gift", record: gift });
    const reservation = auth.user.role === "admin"
      ? await database().prepare(`SELECT id, code, store, description, kind, total_price AS totalPrice, balance_due AS balanceDue, status FROM reservations WHERE code = ?`).bind(code).first<{ id: number; code: string; store: string; description: string; kind: string; totalPrice: number; balanceDue: number; status: string }>()
      : await database().prepare(`SELECT id, code, store, description, kind, total_price AS totalPrice, balance_due AS balanceDue, status FROM reservations WHERE code = ? AND store = ?`).bind(code, auth.user.store).first<{ id: number; code: string; store: string; description: string; kind: string; totalPrice: number; balanceDue: number; status: string }>();
    if (reservation) {
      const items = await all(`SELECT product_id AS productId, description, quantity, unit_price AS unitPrice, discount_percent AS discountPercent FROM reservation_items WHERE reservation_id = ? ORDER BY id`, reservation.id);
      return json({ kind: "reservation", record: reservation, items });
    }
    const product = await database().prepare(`SELECT p.id, p.sku, p.name, p.color, p.size, p.price FROM products p JOIN product_eans pe ON pe.product_id = p.id WHERE pe.ean = ? AND p.active = 1`).bind(code).first();
    return product ? json({ kind: "product", record: product }) : json({ error: "Codice non trovato." }, 404);
  }
  return json({ error: "Vista non disponibile." }, 404);
}

async function createCustomer(user: SessionUser, body: JsonMap) {
  const requestedStore = validStore(body.store) ? body.store : "Viterbo";
  const store = user.role === "admin" ? requestedStore : user.store ?? requestedStore;
  const customerType = stringValue(body.customerType) === "company" ? "company" : "private";
  const firstName = stringValue(body.firstName);
  const lastName = stringValue(body.lastName);
  const companyName = stringValue(body.companyName);
  const vatNumber = stringValue(body.vatNumber);
  if (customerType === "private" && (!firstName || !lastName)) return json({ error: "Nome e cognome sono obbligatori per un privato." }, 400);
  if (customerType === "company" && (!companyName || !vatNumber)) return json({ error: "Ragione sociale e partita IVA sono obbligatorie per un'azienda." }, 400);
  const result = await database().prepare(`INSERT INTO customers (customer_type, first_name, last_name, company_name, vat_number, pec, sdi_code, phone, email, address, postal_code, city, province, tax_code, scope, created_store, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(customerType, firstName, lastName, companyName, vatNumber, stringValue(body.pec), stringValue(body.sdiCode), stringValue(body.phone), stringValue(body.email), stringValue(body.address), stringValue(body.postalCode), stringValue(body.city), stringValue(body.province), stringValue(body.taxCode), store, store, new Date().toISOString()).run();
  return json({ ok: true, id: result.meta?.last_row_id });
}

function adminOnly(user: SessionUser) {
  return user.role === "admin" ? null : json({ error: "Funzione riservata all'amministratore." }, 403);
}

async function updateCustomer(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const customerId = Math.round(numberValue(body.id));
  const customerType = stringValue(body.customerType) === "company" ? "company" : "private";
  const firstName = stringValue(body.firstName);
  const lastName = stringValue(body.lastName);
  const companyName = stringValue(body.companyName);
  const vatNumber = stringValue(body.vatNumber);
  if (customerType === "private" && (!firstName || !lastName)) return json({ error: "Nome e cognome sono obbligatori per un privato." }, 400);
  if (customerType === "company" && (!companyName || !vatNumber)) return json({ error: "Ragione sociale e partita IVA sono obbligatorie per un'azienda." }, 400);
  const result = await database().prepare(`UPDATE customers SET customer_type = ?, first_name = ?, last_name = ?, company_name = ?, vat_number = ?, pec = ?, sdi_code = ?, phone = ?, email = ?, address = ?, postal_code = ?, city = ?, province = ?, tax_code = ? WHERE id = ? AND active = 1`)
    .bind(customerType, firstName, lastName, companyName, vatNumber, stringValue(body.pec), stringValue(body.sdiCode), stringValue(body.phone), stringValue(body.email), stringValue(body.address), stringValue(body.postalCode), stringValue(body.city), stringValue(body.province), stringValue(body.taxCode), customerId).run();
  if (!result.meta?.changes) return json({ error: "Cliente non trovato." }, 404);
  return json({ ok: true });
}

async function deleteCustomer(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const customerId = Math.round(numberValue(body.id));
  const result = await database().prepare(`UPDATE customers SET active = 0 WHERE id = ? AND active = 1`).bind(customerId).run();
  if (!result.meta?.changes) return json({ error: "Cliente non trovato." }, 404);
  return json({ ok: true });
}

async function updateProduct(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const productId = Math.round(numberValue(body.id));
  const product = await database().prepare(`SELECT id, variant_group AS variantGroup FROM products WHERE id = ? AND active = 1`).bind(productId).first<{ id: number; variantGroup: string | null }>();
  if (!product) return json({ error: "Prodotto non trovato." }, 404);
  const name = stringValue(body.name);
  const brand = stringValue(body.brand);
  const category = stringValue(body.category);
  const sku = stringValue(body.sku);
  const color = stringValue(body.color);
  const size = stringValue(body.size);
  const price = Math.round(Math.max(0, numberValue(body.price)) * 100) / 100;
  const eans = (Array.isArray(body.eans) ? arrayValue(body.eans).map((value) => stringValue(value)) : stringValue(body.eans).split(",").map((value) => value.trim())).filter(Boolean);
  if (!name || !brand || !category || !sku || !color || !size || price <= 0 || !eans.length) return json({ error: "Compila nome, marca, categoria, SKU, colore, taglia, prezzo e almeno un EAN." }, 400);
  if (new Set(eans).size !== eans.length) return json({ error: "Gli EAN non possono essere duplicati." }, 400);
  if (await database().prepare(`SELECT id FROM products WHERE LOWER(sku) = LOWER(?) AND id <> ?`).bind(sku, productId).first()) return json({ error: `SKU già presente: ${sku}.` }, 409);
  for (const ean of eans) if (await database().prepare(`SELECT id FROM product_eans WHERE ean = ? AND product_id <> ?`).bind(ean, productId).first()) return json({ error: `EAN già presente: ${ean}.` }, 409);
  const viterboQty = Math.max(0, Math.round(numberValue(body.viterboQty)));
  const granSassoQty = Math.max(0, Math.round(numberValue(body.granSassoQty)));
  const stock = await all<{ store: Store; reserved: number }>(`SELECT store, reserved FROM inventory WHERE product_id = ?`, productId);
  const viterboReserved = Number(stock.find((row) => row.store === "Viterbo")?.reserved ?? 0);
  const granSassoReserved = Number(stock.find((row) => row.store === "Gran Sasso")?.reserved ?? 0);
  if (viterboQty < viterboReserved || granSassoQty < granSassoReserved) return json({ error: "La giacenza non può essere inferiore alla quantità già prenotata." }, 409);
  const db = database();
  const statements = [
    db.prepare(`UPDATE products SET name = ?, brand = ?, category = ?, price = ? WHERE variant_group = ?`).bind(name, brand, category, price, product.variantGroup),
    db.prepare(`UPDATE catalog_products SET name = ?, brand = ?, category = ?, base_price = ? WHERE id = ?`).bind(name, brand, category, price, product.variantGroup),
    db.prepare(`UPDATE products SET sku = ?, color = ?, size = ? WHERE id = ?`).bind(sku, color, size, productId),
    db.prepare(`DELETE FROM product_eans WHERE product_id = ?`).bind(productId),
    ...eans.map((ean) => db.prepare(`INSERT INTO product_eans (product_id, ean) VALUES (?, ?)`).bind(productId, ean)),
    db.prepare(`UPDATE inventory SET quantity = ? WHERE product_id = ? AND store = 'Viterbo'`).bind(viterboQty, productId),
    db.prepare(`UPDATE inventory SET quantity = ? WHERE product_id = ? AND store = 'Gran Sasso'`).bind(granSassoQty, productId),
  ];
  await db.batch(statements);
  return json({ ok: true });
}

async function deleteProduct(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const productId = Math.round(numberValue(body.id));
  const product = await database().prepare(`SELECT variant_group AS variantGroup FROM products WHERE id = ? AND active = 1`).bind(productId).first<{ variantGroup: string | null }>();
  if (!product) return json({ error: "Prodotto non trovato." }, 404);
  await database().prepare(`UPDATE products SET active = 0 WHERE id = ?`).bind(productId).run();
  const remaining = product.variantGroup ? await database().prepare(`SELECT id FROM products WHERE variant_group = ? AND active = 1 LIMIT 1`).bind(product.variantGroup).first() : null;
  if (!remaining && product.variantGroup) await database().prepare(`UPDATE catalog_products SET active = 0 WHERE id = ?`).bind(product.variantGroup).run();
  return json({ ok: true });
}

async function updateGift(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const giftId = Math.round(numberValue(body.id));
  const beneficiary = stringValue(body.beneficiary, "Non indicato");
  const initialValue = Math.round(Math.max(0, numberValue(body.initialValue)) * 100) / 100;
  const balance = Math.round(Math.max(0, numberValue(body.balance)) * 100) / 100;
  const expiresAt = stringValue(body.expiresAt);
  const requestedStatus = stringValue(body.status);
  if (!beneficiary || initialValue <= 0 || balance > initialValue || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return json({ error: "Controlla intestatario, valori e data di scadenza." }, 400);
  const status = requestedStatus === "reversed" ? "reversed" : balance <= 0 ? "used" : requestedStatus === "expired" ? "expired" : "active";
  const result = await database().prepare(`UPDATE gift_cards SET beneficiary = ?, initial_value = ?, balance = ?, expires_at = ?, status = ? WHERE id = ? AND status <> 'deleted'`).bind(beneficiary, initialValue, balance, expiresAt, status, giftId).run();
  if (!result.meta?.changes) return json({ error: "Buono non trovato." }, 404);
  return json({ ok: true });
}

async function deleteGift(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const giftId = Math.round(numberValue(body.id));
  const result = await database().prepare(`UPDATE gift_cards SET balance = 0, status = 'deleted' WHERE id = ? AND status <> 'deleted'`).bind(giftId).run();
  if (!result.meta?.changes) return json({ error: "Buono non trovato." }, 404);
  return json({ ok: true });
}

async function adjustReservationStock(reservationId: number, store: Store, direction: 1 | -1) {
  const reservation = await database().prepare(`SELECT product_id AS productId FROM reservations WHERE id = ?`).bind(reservationId).first<{ productId: number | null }>();
  const items = await all<{ productId: number | null; quantity: number }>(`SELECT product_id AS productId, quantity FROM reservation_items WHERE reservation_id = ?`, reservationId);
  const rows = items.length ? items : reservation?.productId ? [{ productId: reservation.productId, quantity: 1 }] : [];
  for (const item of rows) if (item.productId) {
    if (direction === 1) {
      const inventory = await database().prepare(`SELECT quantity, reserved FROM inventory WHERE product_id = ? AND store = ?`).bind(item.productId, store).first<{ quantity: number; reserved: number }>();
      if (!inventory || inventory.quantity - inventory.reserved < item.quantity) throw new Error("Giacenza insufficiente per riaprire la prenotazione.");
    }
  }
  for (const item of rows) if (item.productId) await database().prepare(`UPDATE inventory SET reserved = MAX(0, reserved + ?) WHERE product_id = ? AND store = ?`).bind(direction * item.quantity, item.productId, store).run();
}

async function updateReservation(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const reservationId = Math.round(numberValue(body.id));
  const reservation = await database().prepare(`SELECT store, status FROM reservations WHERE id = ?`).bind(reservationId).first<{ store: Store; status: string }>();
  if (!reservation) return json({ error: "Prenotazione non trovata." }, 404);
  const description = stringValue(body.description);
  const totalPrice = Math.round(Math.max(0, numberValue(body.totalPrice)) * 100) / 100;
  const depositAmount = Math.round(Math.max(0, numberValue(body.depositAmount)) * 100) / 100;
  const nextStatus = stringValue(body.status) === "cancelled" ? "cancelled" : reservation.status === "completed" ? "completed" : "open";
  if (!description || totalPrice <= 0 || depositAmount > totalPrice) return json({ error: "Controlla descrizione, totale e acconto." }, 400);
  if (reservation.status === "open" && nextStatus === "cancelled") await adjustReservationStock(reservationId, reservation.store, -1);
  if (reservation.status === "cancelled" && nextStatus === "open") await adjustReservationStock(reservationId, reservation.store, 1);
  const balanceDue = nextStatus === "completed" ? 0 : Math.round((totalPrice - depositAmount) * 100) / 100;
  await database().prepare(`UPDATE reservations SET description = ?, total_price = ?, deposit_amount = ?, balance_due = ?, status = ? WHERE id = ?`).bind(description, totalPrice, depositAmount, balanceDue, nextStatus, reservationId).run();
  return json({ ok: true });
}

async function deleteReservation(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const reservationId = Math.round(numberValue(body.id));
  const reservation = await database().prepare(`SELECT store, status FROM reservations WHERE id = ?`).bind(reservationId).first<{ store: Store; status: string }>();
  if (!reservation) return json({ error: "Prenotazione non trovata." }, 404);
  if (reservation.status === "open") await adjustReservationStock(reservationId, reservation.store, -1);
  const db = database();
  await db.batch([db.prepare(`DELETE FROM reservation_items WHERE reservation_id = ?`).bind(reservationId), db.prepare(`DELETE FROM reservations WHERE id = ?`).bind(reservationId)]);
  return json({ ok: true });
}

async function updateTransfer(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const transferId = Math.round(numberValue(body.id));
  const transfer = await database().prepare(`SELECT from_store AS fromStore, to_store AS toStore FROM transfers WHERE id = ?`).bind(transferId).first<{ fromStore: Store; toStore: Store }>();
  if (!transfer) return json({ error: "Trasferimento non trovato." }, 404);
  const currentItems = await all<{ productId: number; quantity: number }>(`SELECT product_id AS productId, quantity FROM transfer_items WHERE transfer_id = ?`, transferId);
  const items = arrayValue(body.items).map((entry) => { const row = objectValue(entry); return { productId: Math.round(numberValue(row.productId)), quantity: Math.max(1, Math.round(numberValue(row.quantity, 1))) }; });
  if (items.length !== currentItems.length || items.some((item) => !currentItems.some((current) => current.productId === item.productId))) return json({ error: "Puoi modificare le quantità delle righe esistenti; per cambiare prodotti crea un nuovo trasferimento." }, 400);
  for (const item of items) {
    const oldQuantity = currentItems.find((current) => current.productId === item.productId)!.quantity;
    const delta = item.quantity - oldQuantity;
    if (!delta) continue;
    const store = delta > 0 ? transfer.fromStore : transfer.toStore;
    const required = Math.abs(delta);
    const inventory = await database().prepare(`SELECT quantity, reserved FROM inventory WHERE product_id = ? AND store = ?`).bind(item.productId, store).first<{ quantity: number; reserved: number }>();
    if (!inventory || inventory.quantity - inventory.reserved < required) return json({ error: `Giacenza insufficiente in ${store} per correggere il trasferimento.` }, 409);
  }
  const sender = stringValue(body.sender); const receiver = stringValue(body.receiver); const carrier = stringValue(body.carrier); const reason = stringValue(body.transportReason, "Trasferimento merce");
  if (!sender || !receiver || !carrier) return json({ error: "Compila mittente, ricevente e vettore." }, 400);
  const db = database();
  const statements = [db.prepare(`UPDATE transfers SET sender = ?, receiver = ?, carrier = ?, transport_reason = ? WHERE id = ?`).bind(sender, receiver, carrier, reason, transferId)];
  for (const item of items) {
    const oldQuantity = currentItems.find((current) => current.productId === item.productId)!.quantity;
    const delta = item.quantity - oldQuantity;
    if (delta) {
      statements.push(db.prepare(`UPDATE inventory SET quantity = quantity - ? WHERE product_id = ? AND store = ?`).bind(delta, item.productId, transfer.fromStore));
      statements.push(db.prepare(`UPDATE inventory SET quantity = quantity + ? WHERE product_id = ? AND store = ?`).bind(delta, item.productId, transfer.toStore));
    }
    statements.push(db.prepare(`UPDATE transfer_items SET quantity = ? WHERE transfer_id = ? AND product_id = ?`).bind(item.quantity, transferId, item.productId));
  }
  await db.batch(statements);
  return json({ ok: true });
}

async function deleteTransfer(user: SessionUser, body: JsonMap) {
  const denied = adminOnly(user); if (denied) return denied;
  const transferId = Math.round(numberValue(body.id));
  const transfer = await database().prepare(`SELECT from_store AS fromStore, to_store AS toStore FROM transfers WHERE id = ?`).bind(transferId).first<{ fromStore: Store; toStore: Store }>();
  if (!transfer) return json({ error: "Trasferimento non trovato." }, 404);
  const items = await all<{ productId: number; quantity: number }>(`SELECT product_id AS productId, quantity FROM transfer_items WHERE transfer_id = ?`, transferId);
  for (const item of items) {
    const inventory = await database().prepare(`SELECT quantity, reserved FROM inventory WHERE product_id = ? AND store = ?`).bind(item.productId, transfer.toStore).first<{ quantity: number; reserved: number }>();
    if (!inventory || inventory.quantity - inventory.reserved < item.quantity) return json({ error: `Impossibile annullare: a ${transfer.toStore} la merce è già stata utilizzata o prenotata.` }, 409);
  }
  const db = database();
  const statements = items.flatMap((item) => [
    db.prepare(`UPDATE inventory SET quantity = quantity + ? WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, transfer.fromStore),
    db.prepare(`UPDATE inventory SET quantity = quantity - ? WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, transfer.toStore),
  ]);
  statements.push(db.prepare(`DELETE FROM transfer_items WHERE transfer_id = ?`).bind(transferId));
  statements.push(db.prepare(`DELETE FROM transfers WHERE id = ?`).bind(transferId));
  await db.batch(statements);
  return json({ ok: true });
}

async function createSale(request: Request, user: SessionUser, body: JsonMap) {
  const firebaseIdentity = await verifiedFirebaseIdentityFromRequest(request);
  if (!firebaseIdentity) return json({ error: "Sessione Firebase scaduta. Esci e accedi nuovamente." }, 401);
  if (!firebaseIdentityMatchesUser(firebaseIdentity, user)) return json({ error: "Il profilo Firebase non coincide con la cassa aperta." }, 403);
  await syncPendingRealtimeSales(firebaseIdentity, 5);
  const store = validStore(body.store) ? body.store : user.store;
  if (!store) return json({ error: "Seleziona il negozio della vendita." }, 400);
  if (user.role !== "admin" && user.store !== store) return json({ error: "Questa cassa non può operare sull'altro negozio." }, 403);
  const items = normalizeItems(body.items);
  if (!items.length) return json({ error: "Il carrello è vuoto." }, 400);

  const subtotal = Math.round(items.reduce((sum, item) => sum + item.quantity * item.unitPrice * (1 - item.discountPercent / 100), 0) * 100) / 100;
  const total = Math.round(numberValue(body.total, subtotal) * 100) / 100;
  let cash = Math.round(numberValue(body.cashAmount) * 100) / 100;
  let card = Math.round(numberValue(body.cardAmount) * 100) / 100;
  let bank = Math.round(numberValue(body.bankAmount) * 100) / 100;
  let giftAmount = Math.round(numberValue(body.giftAmount) * 100) / 100;
  let giftCodeUsed = stringValue(body.giftCodeUsed);
  const fiscalDocumentType = stringValue(body.fiscalDocumentType) === "invoice" ? "invoice" : "receipt";
  const customerId = body.customerId == null ? null : numberValue(body.customerId);
  if (bank > 0 && user.role !== "admin") return json({ error: "Il bonifico bancario è riservato all'amministratore." }, 403);
  if (bank > 0 && (cash !== 0 || card !== 0 || giftAmount !== 0)) return json({ error: "Il bonifico bancario deve coprire da solo il totale della vendita." }, 400);
  if (Math.abs(cash + card + bank + giftAmount - total) > 0.02) return json({ error: "La somma dei pagamenti non coincide con il totale." }, 400);
  const invoiceRecipient = bank > 0 && fiscalDocumentType === "invoice"
    ? await database().prepare(`SELECT customer_type AS customerType, first_name AS firstName, last_name AS lastName, company_name AS companyName, vat_number AS vatNumber, pec, sdi_code AS sdiCode, address, postal_code AS postalCode, city, province, tax_code AS taxCode FROM customers WHERE id = ?`).bind(customerId).first<{ customerType: string; firstName: string; lastName: string; companyName: string; vatNumber: string; pec: string; sdiCode: string; address: string; postalCode: string; city: string; province: string; taxCode: string }>()
    : null;
  if (bank > 0 && fiscalDocumentType === "invoice" && !invoiceRecipient) return json({ error: "Associa un cliente o un'azienda per generare automaticamente la fattura." }, 400);

  const returnRequests = new Map<number, { productId: number | null; quantity: number; items: CartItem[] }>();
  const returnGiftCodes = new Set<string>();
  const originalReturnSaleIds = new Set<number>();
  let originalFiscalReference: FiscalReference | null = null;
  for (const item of items.filter((entry) => entry.itemType === "return")) {
    const originalSaleItemId = Math.round(numberValue(item.metadata.originalSaleItemId));
    if (item.quantity >= 0 || originalSaleItemId <= 0) return json({ error: "Il reso deve essere collegato a una riga della vendita originale." }, 400);
    const current = returnRequests.get(originalSaleItemId) ?? { productId: item.productId, quantity: 0, items: [] };
    if (current.productId !== item.productId) return json({ error: "I dati del prodotto reso non coincidono con la vendita originale." }, 400);
    current.quantity += Math.abs(item.quantity);
    current.items.push(item);
    returnRequests.set(originalSaleItemId, current);
  }
  for (const [originalSaleItemId, request] of returnRequests) {
    const original = await database().prepare(`SELECT s.id AS saleId, si.product_id AS productId, si.item_type AS itemType, json_extract(si.metadata, '$.category') AS category, si.description, si.quantity, si.line_total AS lineTotal, s.subtotal, s.total, s.receipt_no AS receiptNo, s.gift_code_used AS originalGiftCode FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.id = ? AND si.item_type IN ('product', 'service') AND s.store = ?`).bind(originalSaleItemId, store).first<{ saleId: number; productId: number | null; itemType: string; category: string | null; description: string; quantity: number; lineTotal: number; subtotal: number; total: number; receiptNo: string; originalGiftCode: string | null }>();
    if (!original || original.productId !== request.productId) return json({ error: "Vendita originale del reso non trovata per questa cassa." }, 404);
    if (original.itemType === "service") {
      if (original.category !== "Varie" && !original.description.startsWith("Varie ·")) return json({ error: "Questa prestazione non è registrata come vendita Varie restituibile." }, 409);
    }
    const returned = await database().prepare(`SELECT COALESCE(SUM(ABS(quantity)), 0) AS quantity FROM sale_items WHERE item_type = 'return' AND (CAST(json_extract(metadata, '$.originalSaleItemId') AS INTEGER) = ? OR (json_extract(metadata, '$.originalSaleItemId') IS NULL AND ? IS NOT NULL AND product_id = ? AND json_extract(metadata, '$.originalReceipt') = ?))`).bind(originalSaleItemId, request.productId, request.productId, original.receiptNo).first<{ quantity: number }>();
    const remaining = Math.max(0, Math.abs(Number(original.quantity)) - Math.abs(Number(returned?.quantity) || 0));
    if (request.quantity > remaining + 0.001) return json({ error: `Quantità non disponibile per il reso: restano ${remaining} pezzi sullo scontrino ${original.receiptNo}.` }, 409);
    const adjustmentFactor = Math.abs(Number(original.subtotal)) > 0.001 ? Number(original.total) / Number(original.subtotal) : 1;
    const finalUnitPrice = Math.round(Math.max(0, Math.abs(Number(original.lineTotal) * adjustmentFactor) / Math.abs(Number(original.quantity))) * 100) / 100;
    if (request.items.some((item) => Math.abs(item.unitPrice - finalUnitPrice) > 0.02)) return json({ error: `Il valore del reso non coincide con il prezzo finale pagato nello scontrino ${original.receiptNo}.` }, 409);
    originalReturnSaleIds.add(original.saleId);
    if (original.originalGiftCode) returnGiftCodes.add(original.originalGiftCode);
  }
  if (originalReturnSaleIds.size > 1) return json({ error: "Registra separatamente i resi provenienti da documenti fiscali diversi." }, 409);
  if (originalReturnSaleIds.size === 1) {
    const originalSaleId = [...originalReturnSaleIds][0];
    const originalJob = await database().prepare(`SELECT device_response AS deviceResponse FROM fiscal_jobs WHERE sale_id = ? AND status = 'printed' ORDER BY completed_at DESC LIMIT 1`)
      .bind(originalSaleId).first<{ deviceResponse: string | null }>();
    originalFiscalReference = fiscalReferenceFromResponse(originalJob?.deviceResponse);
  }

  let replacementGiftPlan: { originalGiftId: number; code: string; beneficiary: string; value: number; expiresAt: string } | null = null;
  if (total < -0.001 && returnGiftCodes.size) {
    if (returnGiftCodes.size > 1) return json({ error: "Per generare correttamente i buoni residui, registra separatamente i resi provenienti da buoni diversi." }, 409);
    const originalGiftCode = [...returnGiftCodes][0];
    const originalGift = await database().prepare(`SELECT id, beneficiary, balance, expires_at AS expiresAt FROM gift_cards WHERE code = ?`).bind(originalGiftCode).first<{ id: number; beneficiary: string; balance: number; expiresAt: string }>();
    if (!originalGift) return json({ error: "Il buono usato nella vendita originale non è più disponibile per lo storno automatico." }, 409);
    const value = Math.round((Math.max(0, Number(originalGift.balance) || 0) + Math.abs(total)) * 100) / 100;
    const expiresAt = new Date(originalGift.expiresAt) > new Date() ? originalGift.expiresAt : new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    replacementGiftPlan = { originalGiftId: originalGift.id, code: ean13(), beneficiary: originalGift.beneficiary, value, expiresAt };
    cash = 0;
    card = 0;
    bank = 0;
    giftAmount = total;
    giftCodeUsed = replacementGiftPlan.code;
  }

  const inventoryErrors: string[] = [];
  for (const item of items) {
    if (item.itemType === "deposit") {
      const reservedItems = normalizeReservationLines(item.metadata.reservationItems);
      if (!reservedItems.length && !item.productId) return json({ error: "La prenotazione non contiene prodotti." }, 400);
      for (const reservedItem of reservedItems) {
        if (!reservedItem.productId) return json({ error: "Un prodotto della prenotazione non è valido." }, 400);
        const row = await database().prepare(`SELECT quantity, reserved FROM inventory WHERE product_id = ? AND store = ?`).bind(reservedItem.productId, store).first<{ quantity: number; reserved: number }>();
        if (!row || row.quantity - row.reserved < reservedItem.quantity) inventoryErrors.push(reservedItem.description);
      }
      if (reservedItems.length) continue;
    }
    if (item.itemType === "reservation_balance") {
      const code = stringValue(item.metadata.code);
      const reservation = await database().prepare(`SELECT status, store FROM reservations WHERE code = ?`).bind(code).first<{ status: string; store: string }>();
      if (!reservation || reservation.status !== "open" || reservation.store !== store) return json({ error: "Prenotazione o risuolatura non disponibile per il saldo." }, 409);
      continue;
    }
    if (!item.productId || item.itemType === "return" || item.itemType === "reservation_balance") continue;
    const row = await database().prepare(`SELECT quantity, reserved FROM inventory WHERE product_id = ? AND store = ?`).bind(item.productId, store).first<{ quantity: number; reserved: number }>();
    if (!row || row.quantity - row.reserved < item.quantity) inventoryErrors.push(item.description);
  }
  if (inventoryErrors.length) return json({ error: "Giacenza insufficiente.", insufficient: inventoryErrors }, 409);

  if (giftAmount > 0) {
    const gift = await database().prepare(`SELECT balance, expires_at AS expiresAt, status FROM gift_cards WHERE code = ?`).bind(giftCodeUsed).first<{ balance: number; expiresAt: string; status: string }>();
    if (!gift || gift.status !== "active" || new Date(gift.expiresAt) < new Date() || gift.balance + 0.001 < giftAmount) return json({ error: "Buono non valido o saldo insufficiente." }, 400);
  }

  const receiptNo = idCode(store === "Viterbo" ? "VT" : "GS");
  const type = items.some((item) => item.itemType === "return") ? "exchange" : "sale";
  const createdAt = new Date().toISOString();
  const fiscalStatus = fiscalDocumentType === "invoice" ? "invoiced" : "pending";
  const sale = await database().prepare(`INSERT INTO sales (receipt_no, store, customer_id, type, subtotal, adjustment, total, cash_amount, card_amount, bank_amount, gift_amount, gift_code_used, fiscal_status, fiscal_document_type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(receiptNo, store, customerId, type, subtotal, total - subtotal, total, cash, card, bank, giftAmount, giftCodeUsed || null, fiscalStatus, fiscalDocumentType, user.id, createdAt).run();
  const saleId = sale.meta?.last_row_id;
  if (!saleId) return json({ error: "Vendita non registrata." }, 500);

  for (const item of items) {
    const lineTotal = Math.round(item.quantity * item.unitPrice * (1 - item.discountPercent / 100) * 100) / 100;
    await database().prepare(`INSERT INTO sale_items (sale_id, product_id, description, quantity, unit_price, line_total, discount_percent, item_type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(saleId, item.productId, item.description, item.quantity, item.unitPrice, lineTotal, item.discountPercent, item.itemType, JSON.stringify(item.metadata)).run();

    if (item.productId && item.itemType === "product") {
      await database().prepare(`UPDATE inventory SET quantity = quantity - ? WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, store).run();
    }
    if (item.productId && item.itemType === "return") {
      await database().prepare(`UPDATE inventory SET quantity = quantity + ? WHERE product_id = ? AND store = ?`).bind(Math.abs(item.quantity), item.productId, store).run();
    }
    if (item.itemType === "gift") {
      const code = stringValue(item.metadata.code) || ean13();
      const beneficiary = stringValue(item.metadata.beneficiary, "Non indicato");
      const expiresAt = stringValue(item.metadata.expiresAt, new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10));
      await database().prepare(`INSERT INTO gift_cards (code, beneficiary, initial_value, balance, expires_at, store, issued_sale_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
        .bind(code, beneficiary, lineTotal, lineTotal, expiresAt, store, saleId, createdAt).run();
    }
    if (item.itemType === "deposit" || item.itemType === "repair_deposit") {
      const code = stringValue(item.metadata.code) || ean13();
      const totalPrice = numberValue(item.metadata.totalPrice, lineTotal);
      const productId = item.metadata.productId == null ? item.productId : numberValue(item.metadata.productId);
      const balanceDue = Math.max(0, Math.round((totalPrice - lineTotal) * 100) / 100);
      const status = balanceDue > 0 ? "open" : "completed";
      const created = await database().prepare(`INSERT INTO reservations (code, store, customer_id, product_id, description, kind, total_price, deposit_amount, balance_due, status, issued_sale_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(code, store, customerId, productId || null, item.description, item.itemType === "repair_deposit" ? "repair" : "product", totalPrice, lineTotal, balanceDue, status, saleId, createdAt).run();
      const reservationId = created.meta?.last_row_id;
      const reservedItems = normalizeReservationLines(item.metadata.reservationItems);
      if (reservationId && reservedItems.length) {
        for (const reservedItem of reservedItems) {
          await database().prepare(`INSERT INTO reservation_items (reservation_id, product_id, description, quantity, unit_price, discount_percent) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(reservationId, reservedItem.productId, reservedItem.description, reservedItem.quantity, reservedItem.unitPrice, reservedItem.discountPercent).run();
          if (reservedItem.productId && status === "open") await database().prepare(`UPDATE inventory SET reserved = reserved + ? WHERE product_id = ? AND store = ?`).bind(reservedItem.quantity, reservedItem.productId, store).run();
          else if (reservedItem.productId) await database().prepare(`UPDATE inventory SET quantity = quantity - ? WHERE product_id = ? AND store = ?`).bind(reservedItem.quantity, reservedItem.productId, store).run();
        }
      } else if (productId && status === "open") {
        await database().prepare(`UPDATE inventory SET reserved = reserved + 1 WHERE product_id = ? AND store = ?`).bind(productId, store).run();
      } else if (productId) {
        await database().prepare(`UPDATE inventory SET quantity = quantity - 1 WHERE product_id = ? AND store = ?`).bind(productId, store).run();
      }
    }
    if (item.itemType === "reservation_balance") {
      const code = stringValue(item.metadata.code);
      const reservation = await database().prepare(`SELECT id, product_id AS productId FROM reservations WHERE code = ? AND status = 'open'`).bind(code).first<{ id: number; productId: number | null }>();
      await database().prepare(`UPDATE reservations SET status = 'completed', redeemed_sale_id = ? WHERE code = ? AND status = 'open'`).bind(saleId, code).run();
      if (reservation) {
        const reservedItems = await all<{ productId: number | null; quantity: number }>(`SELECT product_id AS productId, quantity FROM reservation_items WHERE reservation_id = ?`, reservation.id);
        if (reservedItems.length) {
          for (const reservedItem of reservedItems) if (reservedItem.productId) await database().prepare(`UPDATE inventory SET quantity = quantity - ?, reserved = MAX(reserved - ?, 0) WHERE product_id = ? AND store = ?`).bind(reservedItem.quantity, reservedItem.quantity, reservedItem.productId, store).run();
        } else if (reservation.productId) {
          await database().prepare(`UPDATE inventory SET quantity = quantity - 1, reserved = MAX(reserved - 1, 0) WHERE product_id = ? AND store = ?`).bind(reservation.productId, store).run();
        }
      }
    }
  }

  let replacementGift: { id: number; code: string; value: number; beneficiary: string } | null = null;
  if (replacementGiftPlan) {
    const createdGift = await database().prepare(`INSERT INTO gift_cards (code, beneficiary, initial_value, balance, expires_at, store, issued_sale_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(replacementGiftPlan.code, replacementGiftPlan.beneficiary, replacementGiftPlan.value, replacementGiftPlan.value, replacementGiftPlan.expiresAt, store, saleId, createdAt).run();
    const createdGiftId = createdGift.meta?.last_row_id;
    if (!createdGiftId) return json({ error: "Il reso è stato registrato ma non è stato possibile generare il buono residuo. Contatta l'amministratore." }, 500);
    await database().prepare(`UPDATE gift_cards SET balance = 0, status = 'reversed' WHERE id = ?`).bind(replacementGiftPlan.originalGiftId).run();
    replacementGift = { id: Number(createdGiftId), code: replacementGiftPlan.code, value: replacementGiftPlan.value, beneficiary: replacementGiftPlan.beneficiary };
  }

  if (giftAmount > 0) await database().prepare(`UPDATE gift_cards SET balance = balance - ?, status = CASE WHEN balance - ? <= 0.001 THEN 'used' ELSE 'active' END WHERE code = ?`).bind(giftAmount, giftAmount, giftCodeUsed).run();
  if (customerId) {
    const otherStore = store === "Viterbo" ? "Gran Sasso" : "Viterbo";
    const previous = await database().prepare(`SELECT id FROM sales WHERE customer_id = ? AND store = ? LIMIT 1`).bind(customerId, otherStore).first();
    if (previous) await database().prepare(`UPDATE customers SET scope = 'Comune' WHERE id = ?`).bind(customerId).run();
  }
  let invoiceDocument: { id: number; number: string } | null = null;
  if (bank > 0 && fiscalDocumentType === "invoice" && invoiceRecipient) {
    const number = idCode("FAT");
    const netTotal = Math.round(total / 1.22 * 100) / 100;
    const taxTotal = Math.round((total - netTotal) * 100) / 100;
    const recipient = invoiceRecipient.customerType === "company" ? invoiceRecipient.companyName : `${invoiceRecipient.firstName} ${invoiceRecipient.lastName}`.trim();
    const document = await database().prepare(`INSERT INTO business_documents (number, type, customer_id, recipient, recipient_vat_number, recipient_pec, recipient_sdi_code, recipient_address, recipient_postal_code, recipient_city, recipient_province, origin, payment_method, sale_id, net_total, tax_total, total, created_by, created_at) VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bank', ?, ?, ?, ?, ?, ?)`)
      .bind(number, customerId, recipient, invoiceRecipient.vatNumber || invoiceRecipient.taxCode || "", invoiceRecipient.pec || "", invoiceRecipient.sdiCode || "", invoiceRecipient.address || "", invoiceRecipient.postalCode || "", invoiceRecipient.city || "", invoiceRecipient.province || "", `Cassa ${store}`, saleId, netTotal, taxTotal, total, user.id, createdAt).run();
    const documentId = document.meta?.last_row_id;
    if (documentId) {
      for (const item of items) {
        const grossTotal = Math.round(item.quantity * item.unitPrice * (1 - item.discountPercent / 100) * 100) / 100;
        const lineTotal = Math.round(grossTotal / 1.22 * 100) / 100;
        const taxAmount = Math.round((grossTotal - lineTotal) * 100) / 100;
        const unitPrice = item.quantity ? Math.round(lineTotal / item.quantity * 100) / 100 : 0;
        await database().prepare(`INSERT INTO business_document_items (document_id, product_id, description, quantity, unit_price, line_total, tax_rate, tax_amount, gross_total) VALUES (?, ?, ?, ?, ?, ?, 22, ?, ?)`)
          .bind(documentId, item.productId, item.description, item.quantity, unitPrice, lineTotal, taxAmount, grossTotal).run();
      }
      const adjustmentGross = Math.round((total - subtotal) * 100) / 100;
      if (Math.abs(adjustmentGross) > 0.001) {
        const adjustmentNet = Math.round(adjustmentGross / 1.22 * 100) / 100;
        await database().prepare(`INSERT INTO business_document_items (document_id, product_id, description, quantity, unit_price, line_total, tax_rate, tax_amount, gross_total) VALUES (?, NULL, 'Adeguamento totale vendita', 1, ?, ?, 22, ?, ?)`)
          .bind(documentId, adjustmentNet, adjustmentNet, Math.round((adjustmentGross - adjustmentNet) * 100) / 100, adjustmentGross).run();
      }
      invoiceDocument = { id: Number(documentId), number };
    }
  }
  let fiscalJob: { id: number; status: string } | null = null;
  let localFiscalTicket: string | null = null;
  let fiscalPayload: JsonMap | null = null;
  let fiscalDevice: { id: number; vendor: string; model: string; connector: string; enabled: number; tokenHash: string | null } | null = null;
  if (fiscalDocumentType === "receipt") {
    fiscalDevice = await database().prepare(`SELECT id, vendor, model, connector, enabled, token_hash AS tokenHash FROM fiscal_devices WHERE store = ?`).bind(store).first<{ id: number; vendor: string; model: string; connector: string; enabled: number; tokenHash: string | null }>();
    const paymentLines = [
      cash ? { method: "cash", description: "CONTANTI", amount: cash, epsonMode: 0 } : null,
      card ? { method: "card", description: "CARTA", amount: card, epsonMode: 2 } : null,
      bank ? { method: "bank", description: "BONIFICO", amount: bank, epsonMode: 5 } : null,
      giftAmount ? { method: "gift", description: giftAmount < 0 ? "BUONO CREDITO RESIDUO" : "BUONO", amount: giftAmount, epsonMode: 6 } : null,
    ].filter(Boolean);
    fiscalPayload = {
      schemaVersion: 2,
      saleId,
      receiptNo,
      store,
      createdAt,
      documentType: type,
      requiresOriginalFiscalReference: type === "exchange",
      originalFiscalReference,
      printer: fiscalDevice ? { vendor: fiscalDevice.vendor, model: fiscalDevice.model, connector: fiscalDevice.connector } : null,
      lines: items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        lineTotal: Math.round(item.quantity * item.unitPrice * (1 - item.discountPercent / 100) * 100) / 100,
        itemType: item.itemType,
        metadata: item.metadata,
      })),
      subtotal,
      adjustment: Math.round((total - subtotal) * 100) / 100,
      total,
      payments: paymentLines,
    };
  }
  const realtimePayload: Parameters<typeof saveSaleToRealtimeDatabase>[1] = {
    id: Number(saleId),
    receiptNo,
    store,
    type,
    subtotal,
    adjustment: Math.round((total - subtotal) * 100) / 100,
    total,
    cashAmount: cash,
    cardAmount: card,
    bankAmount: bank,
    giftAmount,
    customerId,
    fiscalDocumentType,
    createdAt,
    lines: items.map((item) => ({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      lineTotal: Math.round(item.quantity * item.unitPrice * (1 - item.discountPercent / 100) * 100) / 100,
      itemType: item.itemType,
    })),
  };
  const realtimeJob = await database().prepare(`INSERT OR REPLACE INTO realtime_sync_jobs (sale_id, store, payload, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`)
    .bind(saleId, store, JSON.stringify(realtimePayload), createdAt, createdAt).run();
  let realtimeSynced = false;
  let realtimeWarning: string | null = null;
  try {
    await saveSaleToRealtimeDatabase(firebaseIdentity, realtimePayload);
    realtimeSynced = true;
    await database().prepare(`UPDATE realtime_sync_jobs SET status = 'synced', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE sale_id = ?`)
      .bind(new Date().toISOString(), saleId).run();
  } catch (error) {
    realtimeWarning = "Vendita registrata: sincronizzazione Firebase in attesa.";
    await database().prepare(`UPDATE realtime_sync_jobs SET status = 'pending', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE sale_id = ?`)
      .bind(error instanceof Error ? error.message.slice(0, 500) : "Errore Firebase", new Date().toISOString(), saleId).run();
  }
  if (fiscalPayload) {
    const jobStatus = !realtimeSynced ? "error" : fiscalDevice?.enabled && fiscalDevice.tokenHash ? "queued" : "awaiting_setup";
    const deviceResponse = realtimeSynced ? null : "Stampa bloccata: sincronizzazione Firebase non ancora confermata.";
    const storedPayload = { ...fiscalPayload };
    if (jobStatus === "queued") {
      localFiscalTicket = randomLocalTicket();
      storedPayload.localTicketHash = await hashToken(localFiscalTicket);
      storedPayload.localTicketExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    }
    const inserted = await database().prepare(`INSERT OR IGNORE INTO fiscal_jobs (sale_id, store, job_type, payload, status, attempts, device_response, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .bind(saleId, store, type, JSON.stringify(storedPayload), jobStatus, deviceResponse, createdAt, createdAt).run();
    const job = inserted.meta?.last_row_id
      ? { id: Number(inserted.meta.last_row_id), status: jobStatus }
      : await database().prepare(`SELECT id, status FROM fiscal_jobs WHERE sale_id = ?`).bind(saleId).first<{ id: number; status: string }>();
    fiscalJob = job ?? null;
    await database().prepare(`UPDATE sales SET fiscal_status = ? WHERE id = ?`).bind(jobStatus, saleId).run();
  }
  return json({ ok: true, saleId, receiptNo, automaticFiscalDocument: bank > 0 ? fiscalDocumentType : null, invoiceDocument, fiscalJob, localFiscalTicket, localFiscalPayload: localFiscalTicket ? fiscalPayload : null, replacementGift, realtimeSynced, realtimeWarning, realtimeJobId: realtimeJob.meta?.last_row_id ?? null });
}

async function regenerateFiscalToken(user: SessionUser, body: JsonMap) {
  if (user.role !== "admin") return json({ error: "Funzione riservata all'amministratore." }, 403);
  const store = validStore(body.store) ? body.store : null;
  if (!store) return json({ error: "Negozio non valido." }, 400);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = `msrt_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  await database().prepare(`UPDATE fiscal_devices SET token_hash = ?, enabled = 0, last_status = 'token_generated', last_error = NULL, updated_at = ? WHERE store = ?`).bind(tokenHash, now, store).run();
  return json({ ok: true, store, token });
}

async function setFiscalDeviceEnabled(user: SessionUser, body: JsonMap) {
  if (user.role !== "admin") return json({ error: "Funzione riservata all'amministratore." }, 403);
  const store = validStore(body.store) ? body.store : null;
  if (!store) return json({ error: "Negozio non valido." }, 400);
  const enabled = body.enabled === true || body.enabled === 1;
  const device = await database().prepare(`SELECT token_hash AS tokenHash FROM fiscal_devices WHERE store = ?`).bind(store).first<{ tokenHash: string | null }>();
  if (enabled && !device?.tokenHash) return json({ error: "Genera prima la chiave del ponte Windows." }, 400);
  const now = new Date().toISOString();
  await database().prepare(`UPDATE fiscal_devices SET enabled = ?, last_status = ?, last_error = NULL, updated_at = ? WHERE store = ?`).bind(enabled ? 1 : 0, enabled ? "waiting_bridge" : "disabled", now, store).run();
  return json({ ok: true });
}

async function retryFiscalJob(request: Request, user: SessionUser, body: JsonMap) {
  const firebaseIdentity = await verifiedFirebaseIdentityFromRequest(request);
  if (!firebaseIdentity || !firebaseIdentityMatchesUser(firebaseIdentity, user)) return json({ error: "Sessione Firebase scaduta. Esci e accedi nuovamente." }, 401);
  const jobId = Math.round(numberValue(body.jobId));
  const job = await database().prepare(`SELECT id, store, sale_id AS saleId, status, payload, claimed_at AS claimedAt FROM fiscal_jobs WHERE id = ?`).bind(jobId).first<{ id: number; store: string; saleId: number; status: string; payload: string; claimedAt: string | null }>();
  if (!job) return json({ error: "Richiesta fiscale non trovata." }, 404);
  if (user.role !== "admin" && user.store !== job.store) return json({ error: "Operazione non autorizzata per questa cassa." }, 403);
  const staleProcessing = job.status === "processing" && job.claimedAt && Date.now() - new Date(job.claimedAt).getTime() > 120000;
  if (!["error", "awaiting_setup"].includes(job.status) && !staleProcessing) return json({ error: "Questa richiesta non può essere rimessa in coda. Attendi almeno due minuti se la stampa è rimasta bloccata." }, 409);
  const device = await database().prepare(`SELECT enabled, token_hash AS tokenHash FROM fiscal_devices WHERE store = ?`).bind(job.store).first<{ enabled: number; tokenHash: string | null }>();
  if (!device?.enabled || !device.tokenHash) return json({ error: "Il ponte Windows del negozio non è abilitato." }, 409);
  const realtime = await database().prepare(`SELECT status FROM realtime_sync_jobs WHERE sale_id = ?`).bind(job.saleId).first<{ status: string }>();
  if (realtime?.status !== "synced") return json({ error: "La vendita non è ancora confermata su Firebase: la stampa resta bloccata." }, 409);
  const localFiscalTicket = randomLocalTicket();
  const ticketHash = await hashToken(localFiscalTicket);
  const ticketExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  await database().prepare(`UPDATE fiscal_jobs SET status = 'queued', payload = json_set(payload, '$.localTicketHash', ?, '$.localTicketExpiresAt', ?), claimed_at = NULL, device_response = NULL, updated_at = ? WHERE id = ?`)
    .bind(ticketHash, ticketExpiresAt, now, job.id).run();
  await database().prepare(`UPDATE sales SET fiscal_status = 'queued' WHERE id = ?`).bind(job.saleId).run();
  const localFiscalPayload = JSON.parse(job.payload) as JsonMap;
  delete localFiscalPayload.localTicketHash;
  delete localFiscalPayload.localTicketExpiresAt;
  return json({ ok: true, localFiscalTicket, localFiscalPayload, store: job.store });
}

async function completeLocalFiscalJob(request: Request, user: SessionUser, body: JsonMap) {
  const firebaseIdentity = await verifiedFirebaseIdentityFromRequest(request);
  if (!firebaseIdentity || !firebaseIdentityMatchesUser(firebaseIdentity, user)) return json({ error: "Sessione Firebase scaduta. Esci e accedi nuovamente." }, 401);
  const jobId = Math.round(numberValue(body.jobId));
  const job = await database().prepare(`SELECT fj.id, fj.sale_id AS saleId, fj.store, fj.status, rsj.status AS realtimeStatus FROM fiscal_jobs fj LEFT JOIN realtime_sync_jobs rsj ON rsj.sale_id = fj.sale_id WHERE fj.id = ?`).bind(jobId).first<{ id: number; saleId: number; store: Store; status: string; realtimeStatus: string | null }>();
  if (!job || (user.role !== "admin" && user.store !== job.store)) return json({ error: "Richiesta fiscale non disponibile per questa cassa." }, 404);
  if (job.store !== "Viterbo") return json({ error: "Conferma diretta disponibile solo per la cassa RCH di Viterbo." }, 400);
  if (job.realtimeStatus !== "synced") return json({ error: "La vendita non è ancora confermata su Firebase." }, 409);
  if (job.status === "printed") return json({ ok: true, alreadyCompleted: true });
  if (!["queued", "processing"].includes(job.status)) return json({ error: "La richiesta fiscale non è pronta per la conferma." }, 409);
  const now = new Date().toISOString();
  const response = stringValue(body.response, "Comandi RCH confermati dal ponte WebSocket locale.").slice(0, 500);
  const db = database();
  await db.batch([
    db.prepare(`UPDATE fiscal_jobs SET status = 'printed', device_response = ?, completed_at = ?, updated_at = ? WHERE id = ?`).bind(response, now, now, job.id),
    db.prepare(`UPDATE sales SET fiscal_status = 'printed' WHERE id = ?`).bind(job.saleId),
    db.prepare(`UPDATE fiscal_devices SET last_seen_at = ?, last_status = 'online', last_error = NULL, updated_at = ? WHERE store = 'Viterbo'`).bind(now, now),
  ]);
  return json({ ok: true });
}

async function failLocalFiscalJob(request: Request, user: SessionUser, body: JsonMap) {
  const firebaseIdentity = await verifiedFirebaseIdentityFromRequest(request);
  if (!firebaseIdentity || !firebaseIdentityMatchesUser(firebaseIdentity, user)) return json({ error: "Sessione Firebase scaduta. Esci e accedi nuovamente." }, 401);
  const jobId = Math.round(numberValue(body.jobId));
  const job = await database().prepare(`SELECT id, sale_id AS saleId, store, status FROM fiscal_jobs WHERE id = ?`).bind(jobId).first<{ id: number; saleId: number; store: Store; status: string }>();
  if (!job || (user.role !== "admin" && user.store !== job.store)) return json({ error: "Richiesta fiscale non disponibile per questa cassa." }, 404);
  if (job.status === "printed") return json({ ok: true, alreadyCompleted: true });
  const message = stringValue(body.error, "Collegamento locale al registratore non disponibile.").slice(0, 500);
  const now = new Date().toISOString();
  await database().prepare(`UPDATE fiscal_jobs SET status = 'error', device_response = ?, updated_at = ? WHERE id = ?`).bind(message, now, job.id).run();
  await database().prepare(`UPDATE sales SET fiscal_status = 'error' WHERE id = ?`).bind(job.saleId).run();
  await database().prepare(`UPDATE fiscal_devices SET last_seen_at = ?, last_status = 'error', last_error = ?, updated_at = ? WHERE store = ?`).bind(now, message, now, job.store).run();
  return json({ ok: true });
}

async function createTransfer(user: SessionUser, body: JsonMap) {
  const fromStore = validStore(body.fromStore) ? body.fromStore : user.store;
  if (!fromStore) return json({ error: "Seleziona il magazzino di partenza." }, 400);
  if (user.role !== "admin" && user.store !== fromStore) return json({ error: "Puoi trasferire solo dal tuo negozio." }, 403);
  const toStore: Store = fromStore === "Viterbo" ? "Gran Sasso" : "Viterbo";
  const items = normalizeItems(body.items).filter((item) => item.productId && item.quantity > 0);
  if (!items.length) return json({ error: "Aggiungi almeno un prodotto." }, 400);
  const insufficient: { productId: number | null; description: string; requested: number; available: number }[] = [];
  for (const item of items) {
    const row = await database().prepare(`SELECT quantity, reserved FROM inventory WHERE product_id = ? AND store = ?`).bind(item.productId, fromStore).first<{ quantity: number; reserved: number }>();
    const available = (row?.quantity ?? 0) - (row?.reserved ?? 0);
    if (available < item.quantity) insufficient.push({ productId: item.productId, description: item.description, requested: item.quantity, available });
  }
  if (insufficient.length) return json({ error: "Quantità insufficiente per il trasferimento.", insufficient }, 409);

  const sender = stringValue(body.sender);
  const receiver = stringValue(body.receiver);
  const carrier = stringValue(body.carrier);
  if (!sender || !receiver || !carrier) return json({ error: "Compila mittente, ricevente e vettore." }, 400);
  const code = idCode("DDT");
  const transfer = await database().prepare(`INSERT INTO transfers (code, from_store, to_store, sender, receiver, carrier, transport_reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(code, fromStore, toStore, sender, receiver, carrier, stringValue(body.transportReason, "Trasferimento merce"), user.id, new Date().toISOString()).run();
  const transferId = transfer.meta?.last_row_id;
  if (!transferId) return json({ error: "Trasferimento non registrato." }, 500);
  for (const item of items) {
    await database().prepare(`INSERT INTO transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)`).bind(transferId, item.productId, item.quantity).run();
    await database().prepare(`UPDATE inventory SET quantity = quantity - ? WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, fromStore).run();
    await database().prepare(`UPDATE inventory SET quantity = quantity + ? WHERE product_id = ? AND store = ?`).bind(item.quantity, item.productId, toStore).run();
  }
  return json({ ok: true, transferId, code });
}

async function quickLoad(user: SessionUser, body: JsonMap) {
  const ean = stringValue(body.ean);
  const quantity = Math.max(1, Math.round(numberValue(body.quantity, 1)));
  const store = user.store ?? (validStore(body.store) ? body.store : "Viterbo");
  const product = await database().prepare(`SELECT p.id, p.name, p.color, p.size FROM products p JOIN product_eans pe ON pe.product_id = p.id WHERE pe.ean = ? AND p.active = 1`).bind(ean).first<{ id: number; name: string; color: string; size: string }>();
  if (!product) return json({ error: "EAN non riconosciuto." }, 404);
  await database().prepare(`UPDATE inventory SET quantity = quantity + ? WHERE product_id = ? AND store = ?`).bind(quantity, product.id, store).run();
  return json({ ok: true, product, quantity, store });
}

async function createProduct(user: SessionUser, body: JsonMap) {
  const name = stringValue(body.name);
  const brand = stringValue(body.brand);
  const sku = stringValue(body.sku);
  const eans = arrayValue(body.eans).map((value) => stringValue(value)).filter(Boolean);
  if (!name || !brand || !sku || !eans.length) return json({ error: "Nome, marca, SKU e almeno un EAN sono obbligatori." }, 400);
  const variantGroup = crypto.randomUUID();
  const category = stringValue(body.category);
  const price = numberValue(body.price);
  await database().prepare(`INSERT INTO catalog_products (id, name, brand, category, base_price, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .bind(variantGroup, name, brand, category, price, new Date().toISOString()).run();
  const result = await database().prepare(`INSERT INTO products (sku, name, brand, category, color, size, price, variant_group, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .bind(sku, name, brand, category, stringValue(body.color), stringValue(body.size), price, variantGroup).run();
  const productId = result.meta?.last_row_id;
  if (!productId) return json({ error: "Prodotto non creato. Controlla SKU ed EAN." }, 400);
  for (const ean of eans) await database().prepare(`INSERT INTO product_eans (product_id, ean) VALUES (?, ?)`).bind(productId, ean).run();
  const viterboQty = user.role === "admin" || user.store === "Viterbo" ? Math.max(0, Math.round(numberValue(body.viterboQty))) : 0;
  const granSassoQty = user.role === "admin" || user.store === "Gran Sasso" ? Math.max(0, Math.round(numberValue(body.granSassoQty))) : 0;
  await database().prepare(`INSERT INTO inventory (product_id, store, quantity, reserved) VALUES (?, 'Viterbo', ?, 0)`).bind(productId, viterboQty).run();
  await database().prepare(`INSERT INTO inventory (product_id, store, quantity, reserved) VALUES (?, 'Gran Sasso', ?, 0)`).bind(productId, granSassoQty).run();
  return json({ ok: true, productId });
}

async function createDocument(user: SessionUser, body: JsonMap) {
  if (user.role !== "admin") return json({ error: "Funzione riservata all'amministratore." }, 403);
  const type = stringValue(body.documentType) === "invoice" ? "invoice" : "quote";
  const items = normalizeDocumentLines(body.items);
  if (!items.length) return json({ error: "Aggiungi almeno una riga." }, 400);
  const recipient = stringValue(body.recipient);
  if (!recipient) return json({ error: "Inserisci il destinatario del documento." }, 400);
  const paymentMethod = ["cash", "bank", "card"].includes(stringValue(body.paymentMethod)) ? stringValue(body.paymentMethod) : "cash";
  const totals = items.reduce((sum, item) => {
    const net = Math.round(item.quantity * item.unitPrice * 100) / 100;
    const tax = Math.round(net * item.taxRate) / 100;
    return { net: sum.net + net, tax: sum.tax + tax };
  }, { net: 0, tax: 0 });
  const netTotal = Math.round(totals.net * 100) / 100;
  const taxTotal = Math.round(totals.tax * 100) / 100;
  const total = Math.round((netTotal + taxTotal) * 100) / 100;
  const number = idCode(type === "invoice" ? "FAT" : "PREV");
  const result = await database().prepare(`INSERT INTO business_documents (number, type, customer_id, recipient, recipient_vat_number, recipient_pec, recipient_sdi_code, recipient_address, recipient_postal_code, recipient_city, recipient_province, origin, payment_method, net_total, tax_total, total, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(number, type, body.customerId == null ? null : numberValue(body.customerId), recipient, stringValue(body.recipientVatNumber), stringValue(body.recipientPec), stringValue(body.recipientSdiCode), stringValue(body.recipientAddress), stringValue(body.recipientPostalCode), stringValue(body.recipientCity), stringValue(body.recipientProvince), stringValue(body.origin, "Ordine"), paymentMethod, netTotal, taxTotal, total, user.id, new Date().toISOString()).run();
  const documentId = result.meta?.last_row_id;
  if (!documentId) return json({ error: "Documento non creato." }, 500);
  for (const item of items) {
    const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
    const taxAmount = Math.round(lineTotal * item.taxRate) / 100;
    await database().prepare(`INSERT INTO business_document_items (document_id, product_id, description, quantity, unit_price, line_total, tax_rate, tax_amount, gross_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(documentId, item.productId, item.description, item.quantity, item.unitPrice, lineTotal, item.taxRate, taxAmount, lineTotal + taxAmount).run();
  }
  return json({ ok: true, documentId, number, netTotal, taxTotal, total });
}

async function resetData(request: Request, user: SessionUser, body: JsonMap) {
  if (user.role !== "admin") return json({ error: "Funzione riservata all'amministratore." }, 403);
  if (stringValue(body.confirmation) !== "AZZERA TUTTO") return json({ error: "Conferma non valida." }, 400);
  const firebaseIdentity = await verifiedFirebaseIdentityFromRequest(request);
  if (!firebaseIdentity || !firebaseIdentityMatchesUser(firebaseIdentity, user) || firebaseIdentity.profile.role !== "admin") {
    return json({ error: "Sessione Firebase amministratore non valida. Esci e accedi nuovamente." }, 401);
  }
  await clearRealtimeSales(firebaseIdentity);
  const db = database();
  const photoRows = await all<{ photoKey: string }>(`SELECT DISTINCT photo_key AS photoKey FROM products WHERE photo_key IS NOT NULL AND photo_key <> ''`);
  const { env } = await import("cloudflare:workers");
  const storage = (env as { BUCKET?: { delete(keys: string | string[]): Promise<void> } }).BUCKET;
  if (storage && photoRows.length) await storage.delete(photoRows.map((row) => row.photoKey));
  for (const table of ["business_document_items", "business_documents", "transfer_items", "transfers", "reservation_items", "reservations", "gift_cards", "fiscal_jobs", "realtime_sync_jobs", "sale_items", "sales", "customers", "inventory", "product_eans", "products", "catalog_products"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('initial_seed_completed', '1')`).run();
  return json({ ok: true });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const auth = await requireUser(request);
  if (auth.response || !auth.user) return auth.response;
  const body = objectValue(await request.json().catch(() => ({})));
  const action = stringValue(body.action);
  try {
    if (action === "createCustomer") return createCustomer(auth.user, body);
    if (action === "updateCustomer") return updateCustomer(auth.user, body);
    if (action === "deleteCustomer") return deleteCustomer(auth.user, body);
    if (action === "createSale") return createSale(request, auth.user, body);
    if (action === "createTransfer") return createTransfer(auth.user, body);
    if (action === "updateTransfer") return updateTransfer(auth.user, body);
    if (action === "deleteTransfer") return deleteTransfer(auth.user, body);
    if (action === "quickLoad") return quickLoad(auth.user, body);
    if (action === "createProduct") return createProduct(auth.user, body);
    if (action === "updateProduct") return updateProduct(auth.user, body);
    if (action === "deleteProduct") return deleteProduct(auth.user, body);
    if (action === "updateGift") return updateGift(auth.user, body);
    if (action === "deleteGift") return deleteGift(auth.user, body);
    if (action === "updateReservation") return updateReservation(auth.user, body);
    if (action === "deleteReservation") return deleteReservation(auth.user, body);
    if (action === "createDocument") return createDocument(auth.user, body);
    if (action === "regenerateFiscalToken") return regenerateFiscalToken(auth.user, body);
    if (action === "setFiscalDeviceEnabled") return setFiscalDeviceEnabled(auth.user, body);
    if (action === "retryFiscalJob") return retryFiscalJob(request, auth.user, body);
    if (action === "completeLocalFiscalJob") return completeLocalFiscalJob(request, auth.user, body);
    if (action === "failLocalFiscalJob") return failLocalFiscalJob(request, auth.user, body);
    if (action === "resetData") return resetData(request, auth.user, body);
    return json({ error: "Operazione non disponibile." }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore inatteso";
    return json({ error: message.includes("UNIQUE") ? "Dato già presente: controlla codice, SKU o EAN." : message }, 400);
  }
}
