import { currentUser, database, ensureDatabase, json } from "../../../lib/runtime-db";

type R2ObjectBodyLike = {
  body: ReadableStream;
  httpEtag?: string;
  writeHttpMetadata?: (headers: Headers) => void;
};

type R2BucketLike = {
  get: (key: string) => Promise<R2ObjectBodyLike | null>;
  put: (key: string, value: ReadableStream, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }) => Promise<unknown>;
  delete: (keys: string | string[]) => Promise<void>;
};

type VariantInput = {
  sku: string;
  color: string;
  size: string;
  eans: string[];
  viterboQty: number;
  granSassoQty: number;
};

const allowedImageTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

async function bucket() {
  const { env } = await import("cloudflare:workers");
  return (env as { BUCKET?: R2BucketLike }).BUCKET;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function quantity(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function slug(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "colore";
}

function parseVariants(value: unknown): VariantInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return {
      sku: text(item.sku),
      color: text(item.color),
      size: text(item.size),
      eans: Array.isArray(item.eans) ? item.eans.map(text).filter(Boolean) : [],
      viterboQty: quantity(item.viterboQty),
      granSassoQty: quantity(item.granSassoQty),
    };
  });
}

async function requireUser(request: Request) {
  const user = await currentUser(request);
  return user && !user.mustChangePassword ? user : null;
}

export async function GET(request: Request) {
  await ensureDatabase();
  const user = await requireUser(request);
  if (!user) return json({ error: "Sessione scaduta." }, 401);
  const key = text(new URL(request.url).searchParams.get("key"));
  if (!key) return json({ error: "Immagine non valida." }, 400);
  const product = await database().prepare(`SELECT id FROM products WHERE photo_key = ? LIMIT 1`).bind(key).first();
  if (!product) return json({ error: "Immagine non trovata." }, 404);
  const storage = await bucket();
  if (!storage) return json({ error: "Archivio immagini non disponibile." }, 503);
  const object = await storage.get(key);
  if (!object) return json({ error: "Immagine non trovata." }, 404);
  const headers = new Headers({ "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline" });
  object.writeHttpMetadata?.(headers);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const user = await requireUser(request);
  if (!user) return json({ error: "Sessione scaduta." }, 401);

  const formData = await request.formData();
  const payloadRaw = formData.get("payload");
  if (typeof payloadRaw !== "string") return json({ error: "Dati articolo mancanti." }, 400);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(payloadRaw) as Record<string, unknown>; }
  catch { return json({ error: "Dati articolo non validi." }, 400); }

  const name = text(payload.name);
  const brand = text(payload.brand);
  const category = text(payload.category);
  const price = Number(payload.price);
  const variants = parseVariants(payload.variants);
  if (!name || !brand || !category || !Number.isFinite(price) || price <= 0) return json({ error: "Nome, marca, categoria e prezzo sono obbligatori." }, 400);
  if (!variants.length || variants.length > 50) return json({ error: "Aggiungi da 1 a 50 varianti." }, 400);
  if (variants.some((variant) => !variant.sku || !variant.color || !variant.size || !variant.eans.length)) return json({ error: "Ogni variante richiede colore, taglia, SKU e almeno un EAN." }, 400);

  const skuValues = variants.map((variant) => variant.sku.toLowerCase());
  const eanValues = variants.flatMap((variant) => variant.eans);
  if (new Set(skuValues).size !== skuValues.length) return json({ error: "Gli SKU delle varianti devono essere diversi." }, 400);
  if (new Set(eanValues).size !== eanValues.length) return json({ error: "Ogni EAN può appartenere a una sola variante." }, 400);
  for (const variant of variants) {
    if (await database().prepare(`SELECT id FROM products WHERE LOWER(sku) = LOWER(?)`).bind(variant.sku).first()) return json({ error: `SKU già presente: ${variant.sku}.` }, 409);
    for (const ean of variant.eans) if (await database().prepare(`SELECT id FROM product_eans WHERE ean = ?`).bind(ean).first()) return json({ error: `EAN già presente: ${ean}.` }, 409);
  }

  const filesByColor = new Map<string, File>();
  for (let index = 0; index < variants.length; index += 1) {
    const entry = formData.get(`photo-${index}`);
    if (!(entry instanceof File) || entry.size === 0) continue;
    if (!allowedImageTypes.has(entry.type)) return json({ error: "Le foto devono essere JPG, PNG o WebP." }, 400);
    if (entry.size > 6 * 1024 * 1024) return json({ error: "Ogni foto può pesare al massimo 6 MB." }, 400);
    const colorKey = variants[index].color.toLowerCase();
    if (!filesByColor.has(colorKey)) filesByColor.set(colorKey, entry);
  }

  const storage = await bucket();
  if (filesByColor.size && !storage) return json({ error: "Archivio immagini non disponibile." }, 503);
  const variantGroup = crypto.randomUUID();
  const photoKeys = new Map<string, string>();
  const uploadedKeys: string[] = [];
  const createdIds: number[] = [];
  let catalogCreated = false;

  try {
    await database().prepare(`INSERT INTO catalog_products (id, name, brand, category, base_price, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .bind(variantGroup, name, brand, category, price, new Date().toISOString()).run();
    catalogCreated = true;
    for (const [colorKey, file] of filesByColor) {
      const extension = allowedImageTypes.get(file.type) ?? "jpg";
      const key = `products/${variantGroup}/${slug(colorKey)}-${crypto.randomUUID()}.${extension}`;
      await storage!.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: "private, max-age=86400" } });
      photoKeys.set(colorKey, key); uploadedKeys.push(key);
    }

    for (const variant of variants) {
      const viterboQty = user.role === "admin" || user.store === "Viterbo" ? variant.viterboQty : 0;
      const granSassoQty = user.role === "admin" || user.store === "Gran Sasso" ? variant.granSassoQty : 0;
      const result = await database().prepare(`INSERT INTO products (sku, name, brand, category, color, size, price, variant_group, photo_key, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .bind(variant.sku, name, brand, category, variant.color, variant.size, price, variantGroup, photoKeys.get(variant.color.toLowerCase()) ?? null).run();
      const productId = result.meta?.last_row_id;
      if (!productId) throw new Error("Variante non creata.");
      createdIds.push(productId);
      for (const ean of variant.eans) await database().prepare(`INSERT INTO product_eans (product_id, ean) VALUES (?, ?)`).bind(productId, ean).run();
      await database().prepare(`INSERT INTO inventory (product_id, store, quantity, reserved) VALUES (?, 'Viterbo', ?, 0)`).bind(productId, viterboQty).run();
      await database().prepare(`INSERT INTO inventory (product_id, store, quantity, reserved) VALUES (?, 'Gran Sasso', ?, 0)`).bind(productId, granSassoQty).run();
    }
  } catch (error) {
    for (const productId of createdIds) {
      await database().prepare(`DELETE FROM inventory WHERE product_id = ?`).bind(productId).run();
      await database().prepare(`DELETE FROM product_eans WHERE product_id = ?`).bind(productId).run();
      await database().prepare(`DELETE FROM products WHERE id = ?`).bind(productId).run();
    }
    if (uploadedKeys.length && storage) await storage.delete(uploadedKeys);
    if (catalogCreated) await database().prepare(`DELETE FROM catalog_products WHERE id = ?`).bind(variantGroup).run();
    return json({ error: error instanceof Error ? error.message : "Articolo non creato." }, 400);
  }

  return json({ ok: true, productId: variantGroup, productCount: 1, variantCount: createdIds.length, photos: photoKeys.size });
}
