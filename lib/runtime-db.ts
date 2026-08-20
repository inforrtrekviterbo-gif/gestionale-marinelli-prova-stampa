import { getRequestBindings } from "./request-env";

export type Role = "admin" | "viterbo" | "gran_sasso";
export type Store = "Viterbo" | "Gran Sasso";

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  store: Store | null;
  mustChangePassword: number;
};

type D1RunResult = { success?: boolean; meta?: { last_row_id?: number; changes?: number } };
type D1AllResult<T> = { results?: T[] };

export type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T = Record<string, unknown>>(columnName?: string) => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<D1AllResult<T>>;
  run: () => Promise<D1RunResult>;
};

export type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1RunResult[]>;
};

export function database(): D1Database {
  const db = getRequestBindings()?.DB as D1Database | undefined;
  if (!db) throw new Error("Database non disponibile");
  return db;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL, store TEXT, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, password_iterations INTEGER NOT NULL DEFAULT 100000, must_change_password INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_type TEXT NOT NULL DEFAULT 'private', first_name TEXT NOT NULL, last_name TEXT NOT NULL, company_name TEXT, vat_number TEXT, pec TEXT, sdi_code TEXT, phone TEXT, email TEXT, address TEXT, postal_code TEXT, city TEXT, province TEXT, tax_code TEXT, scope TEXT NOT NULL, created_store TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS catalog_products (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', category TEXT, base_price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', category TEXT, color TEXT, size TEXT, price REAL NOT NULL, variant_group TEXT, photo_key TEXT, active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS product_eans (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, ean TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, store TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, UNIQUE(product_id, store))`,
  `CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_no TEXT NOT NULL UNIQUE, store TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id), type TEXT NOT NULL, subtotal REAL NOT NULL, adjustment REAL NOT NULL DEFAULT 0, total REAL NOT NULL, cash_amount REAL NOT NULL DEFAULT 0, card_amount REAL NOT NULL DEFAULT 0, bank_amount REAL NOT NULL DEFAULT 0, gift_amount REAL NOT NULL DEFAULT 0, gift_code_used TEXT, fiscal_status TEXT NOT NULL DEFAULT 'pending', fiscal_document_type TEXT NOT NULL DEFAULT 'receipt', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, quantity REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL, discount_percent REAL NOT NULL DEFAULT 0, item_type TEXT NOT NULL, metadata TEXT)`,
  `CREATE TABLE IF NOT EXISTS fiscal_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL, model TEXT NOT NULL, connector TEXT NOT NULL, token_hash TEXT, enabled INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, last_status TEXT NOT NULL DEFAULT 'not_configured', last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fiscal_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE, store TEXT NOT NULL, job_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, device_response TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS realtime_sync_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE, store TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gift_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, beneficiary TEXT NOT NULL, initial_value REAL NOT NULL, balance REAL NOT NULL, expires_at TEXT NOT NULL, store TEXT NOT NULL, issued_sale_id INTEGER NOT NULL REFERENCES sales(id), status TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, store TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id), product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, kind TEXT NOT NULL, total_price REAL NOT NULL, deposit_amount REAL NOT NULL, balance_due REAL NOT NULL, status TEXT NOT NULL, issued_sale_id INTEGER NOT NULL REFERENCES sales(id), redeemed_sale_id INTEGER REFERENCES sales(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_items (id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price REAL NOT NULL, discount_percent REAL NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, from_store TEXT NOT NULL, to_store TEXT NOT NULL, sender TEXT NOT NULL, receiver TEXT NOT NULL, carrier TEXT NOT NULL, transport_reason TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS transfer_items (id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, type TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id), recipient TEXT NOT NULL, recipient_vat_number TEXT, recipient_pec TEXT, recipient_sdi_code TEXT, recipient_address TEXT, recipient_postal_code TEXT, recipient_city TEXT, recipient_province TEXT, origin TEXT NOT NULL, payment_method TEXT NOT NULL DEFAULT 'cash', sale_id INTEGER REFERENCES sales(id), net_total REAL NOT NULL DEFAULT 0, tax_total REAL NOT NULL DEFAULT 0, total REAL NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_document_items (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES business_documents(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, quantity REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL, tax_rate REAL NOT NULL DEFAULT 22, tax_amount REAL NOT NULL DEFAULT 0, gross_total REAL NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS customers_name_idx ON customers(last_name, first_name)`,
  `CREATE INDEX IF NOT EXISTS sales_customer_idx ON sales(customer_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS sales_store_date_idx ON sales(store, created_at)`,
  `CREATE INDEX IF NOT EXISTS product_eans_product_idx ON product_eans(product_id)`,
  `CREATE INDEX IF NOT EXISTS reservation_items_reservation_idx ON reservation_items(reservation_id)`,
  `CREATE INDEX IF NOT EXISTS fiscal_jobs_store_status_idx ON fiscal_jobs(store, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS realtime_sync_jobs_status_idx ON realtime_sync_jobs(status, created_at)`,
];

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Cloudflare Workers Web Crypto currently accepts at most 100,000 PBKDF2 iterations.
export const PASSWORD_HASH_ITERATIONS = 100_000;

export async function hashPassword(password: string, salt: string, iterations = PASSWORD_HASH_ITERATIONS) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function passwordStrengthError(password: string) {
  if (password.length < 12) return "Usa almeno 12 caratteri.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return "Usa almeno una lettera maiuscola, una minuscola, un numero e un simbolo.";
  }
  return null;
}

export async function createPasswordCredential(password: string) {
  const salt = randomToken(24);
  return {
    salt,
    hash: await hashPassword(password, salt, PASSWORD_HASH_ITERATIONS),
    iterations: PASSWORD_HASH_ITERATIONS,
  };
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedProducts() {
  const db = database();
  const rows = [
    ["SCARP-TRK-BLU-42", "Scarpa Trekking Alta", "Calzature", "Blu", "42", 129.9, ["8051000000013", "8051000000112"]],
    ["SCARP-TRK-BLU-43", "Scarpa Trekking Alta", "Calzature", "Blu", "43", 129.9, ["8051000000020"]],
    ["SCARP-TRK-NER-42", "Scarpa Trekking Alta", "Calzature", "Nero", "42", 129.9, ["8051000000037"]],
    ["MAG-GS-BLU-M", "Maglia Gran Sasso", "Abbigliamento", "Blu", "M", 39.9, ["8051000000044"]],
    ["MAG-GS-VER-L", "Maglia Gran Sasso", "Abbigliamento", "Verde", "L", 39.9, ["8051000000051"]],
    ["ZAINO-TRAIL-30", "Zaino Trail 30L", "Attrezzatura", "Rosso", "Unica", 89, ["8051000000068", "8051000000167"]],
  ] as const;

  for (const row of rows) {
    await db.prepare(`INSERT OR IGNORE INTO products (sku, name, category, color, size, price, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .bind(row[0], row[1], row[2], row[3], row[4], row[5]).run();
    const product = await db.prepare(`SELECT id FROM products WHERE sku = ?`).bind(row[0]).first<{ id: number }>();
    if (!product) continue;
    for (const ean of row[6]) {
      await db.prepare(`INSERT OR IGNORE INTO product_eans (product_id, ean) VALUES (?, ?)`).bind(product.id, ean).run();
    }
    await db.prepare(`INSERT OR IGNORE INTO inventory (product_id, store, quantity, reserved) VALUES (?, 'Viterbo', 6, 0)`).bind(product.id).run();
    await db.prepare(`INSERT OR IGNORE INTO inventory (product_id, store, quantity, reserved) VALUES (?, 'Gran Sasso', 4, 0)`).bind(product.id).run();
  }
}

export async function ensureDatabase() {
  const db = database();
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'firebase_auth_cutover_v1')`),
    db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('firebase_auth_cutover_v1', ?)` ).bind(new Date().toISOString()),
  ]);
  const userColumns = await db.prepare(`PRAGMA table_info(users)`).all<{ name: string }>();
  const columnNames = new Set((userColumns.results ?? []).map((column) => column.name));
  if (!columnNames.has("password_iterations")) {
    try { await db.prepare(`ALTER TABLE users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 100000`).run(); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error; }
  }
  if (!columnNames.has("must_change_password")) {
    try { await db.prepare(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1`).run(); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error; }
  }
  const customerColumns = await db.prepare(`PRAGMA table_info(customers)`).all<{ name: string }>();
  const customerColumnNames = new Set((customerColumns.results ?? []).map((column) => column.name));
  if (!customerColumnNames.has("active")) {
    try { await db.prepare(`ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1`).run(); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error; }
  }
  await db.prepare(`UPDATE users SET username = 'admin', display_name = 'Amministratore', role = 'admin', store = NULL, must_change_password = 0 WHERE username = 'amministratore' AND NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin')`).run();
  await db.prepare(`UPDATE users SET display_name = 'Cassa Viterbo', role = 'viterbo', store = 'Viterbo', must_change_password = 0 WHERE username = 'viterbo'`).run();
  await db.prepare(`UPDATE users SET display_name = 'Cassa Gran Sasso', role = 'gran_sasso', store = 'Gran Sasso', must_change_password = 0 WHERE username = 'gran-sasso'`).run();
  const seeded = await db.prepare(`SELECT value FROM app_settings WHERE key = 'initial_seed_completed'`).first<{ value: string }>();
  if (!seeded) {
    const products = await db.prepare(`SELECT COUNT(*) AS count FROM products`).first<{ count: number }>();
    if (!products?.count) await seedProducts();
    await db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('initial_seed_completed', '1')`).run();
  }
  await db.prepare(`UPDATE products SET variant_group = 'legacy-' || (
    SELECT MIN(p2.id) FROM products p2
    WHERE LOWER(COALESCE(p2.brand, '')) = LOWER(COALESCE(products.brand, ''))
      AND LOWER(p2.name) = LOWER(products.name)
      AND LOWER(COALESCE(p2.category, '')) = LOWER(COALESCE(products.category, ''))
  ) WHERE variant_group IS NULL OR variant_group = ''`).run();
  await db.prepare(`INSERT OR IGNORE INTO catalog_products (id, name, brand, category, base_price, active, created_at)
    SELECT variant_group, MIN(name), MIN(brand), MIN(category), MIN(price), MAX(active), ?
    FROM products WHERE variant_group IS NOT NULL AND variant_group <> '' GROUP BY variant_group`).bind(new Date().toISOString()).run();
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO fiscal_devices (store, vendor, model, connector, enabled, last_status, created_at, updated_at) VALUES ('Viterbo', 'RCH', 'PRINT! 3.0 RT', 'rch_standard_tcp', 0, 'not_configured', ?, ?)`).bind(now, now).run();
  await db.prepare(`UPDATE fiscal_devices SET connector = 'rch_standard_tcp', updated_at = ? WHERE store = 'Viterbo' AND connector = 'rch_webservice'`).bind(now).run();
  await db.prepare(`INSERT OR IGNORE INTO fiscal_devices (store, vendor, model, connector, enabled, last_status, created_at, updated_at) VALUES ('Gran Sasso', 'Epson', 'FP-81 II RT', 'epson_fpmate', 0, 'not_configured', ?, ?)`).bind(now, now).run();
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const cookie of cookies.split(";")) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function currentUser(request: Request): Promise<SessionUser | null> {
  await ensureDatabase();
  const token = cookieValue(request, "gestionale_session");
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await database().prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.role, u.store, u.must_change_password AS mustChangePassword FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token IN (?, ?) AND s.expires_at > ?`)
    .bind(tokenHash, token, new Date().toISOString()).first<SessionUser>();
  if (row) await database().prepare(`UPDATE OR IGNORE sessions SET token = ? WHERE token = ?`).bind(tokenHash, token).run();
  return row ?? null;
}

export async function createSession(userId: number, maxAgeSeconds = 55 * 60) {
  const token = randomToken(32);
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expires = new Date(now.getTime() + maxAgeSeconds * 1000);
  await database().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now.toISOString()).run();
  await database().prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .bind(tokenHash, userId, expires.toISOString(), now.toISOString()).run();
  return {
    token,
    cookie: `gestionale_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
  };
}

export async function removeSession(request: Request) {
  const token = cookieValue(request, "gestionale_session");
  if (token) await database().prepare(`DELETE FROM sessions WHERE token IN (?, ?)`).bind(await hashToken(token), token).run();
}

export function idCode(prefix: string) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  return `${prefix}-${stamp}-${Math.floor(100 + Math.random() * 900)}`;
}

export function ean13() {
  const base = `29${Date.now().toString().slice(-10)}`.slice(0, 12);
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(base[index]) * (index % 2 === 0 ? 1 : 3);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}
