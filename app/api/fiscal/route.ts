import { database, ensureDatabase, hashToken, json, type Store } from "../../../lib/runtime-db";

type Device = {
  id: number;
  store: Store;
  vendor: string;
  model: string;
  connector: string;
  tokenHash: string | null;
  enabled: number;
  lastStatus: string;
};

const stores: Store[] = ["Viterbo", "Gran Sasso"];

function storeValue(value: unknown): Store | null {
  return typeof value === "string" && stores.includes(value as Store) ? value as Store : null;
}

function textValue(value: unknown, max = 4000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

async function authenticate(request: Request, store: Store) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return null;
  const device = await database().prepare(`SELECT id, store, vendor, model, connector, token_hash AS tokenHash, enabled, last_status AS lastStatus FROM fiscal_devices WHERE store = ?`).bind(store).first<Device>();
  if (!device?.tokenHash || await hashToken(token) !== device.tokenHash) return null;
  if (!device.enabled) {
    if (device.lastStatus !== "token_generated") return null;
    const now = new Date().toISOString();
    await database().prepare(`UPDATE fiscal_devices SET enabled = 1, last_status = 'waiting_bridge', last_error = NULL, updated_at = ? WHERE id = ? AND enabled = 0 AND last_status = 'token_generated'`).bind(now, device.id).run();
    device.enabled = 1;
    device.lastStatus = "waiting_bridge";
  }
  return device;
}

async function heartbeat(device: Device, status = "online", error = "") {
  const now = new Date().toISOString();
  await database().prepare(`UPDATE fiscal_devices SET last_seen_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`).bind(now, status, error || null, now, device.id).run();
}

export async function GET(request: Request) {
  await ensureDatabase();
  const url = new URL(request.url);
  const store = storeValue(url.searchParams.get("store"));
  if (!store) return json({ error: "Negozio non valido." }, 400);
  const device = await authenticate(request, store);
  if (!device) return json({ error: "Ponte Windows non autorizzato o disabilitato." }, 401);
  await heartbeat(device);
  if ((url.searchParams.get("action") ?? "claim") !== "claim") return json({ ok: true, device: { store, vendor: device.vendor, model: device.model } });

  const notBeforeValue = url.searchParams.get("notBefore");
  const notBefore = notBeforeValue && Number.isFinite(new Date(notBeforeValue).getTime()) ? new Date(notBeforeValue).toISOString() : null;
  const statement = notBefore
    ? database().prepare(`SELECT id, sale_id AS saleId, store, job_type AS jobType, payload, attempts, created_at AS createdAt FROM fiscal_jobs WHERE store = ? AND status = 'queued' AND json_extract(payload, '$.localTicketHash') IS NULL AND created_at >= ? ORDER BY created_at LIMIT 1`).bind(store, notBefore)
    : database().prepare(`SELECT id, sale_id AS saleId, store, job_type AS jobType, payload, attempts, created_at AS createdAt FROM fiscal_jobs WHERE store = ? AND status = 'queued' AND json_extract(payload, '$.localTicketHash') IS NULL ORDER BY created_at LIMIT 1`).bind(store);
  const job = await statement.first<{ id: number; saleId: number; store: Store; jobType: string; payload: string; attempts: number; createdAt: string }>();
  if (!job) return json({ ok: true, job: null });
  const now = new Date().toISOString();
  const claimed = await database().prepare(`UPDATE fiscal_jobs SET status = 'processing', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).bind(now, now, job.id).run();
  if (!claimed.meta?.changes) return json({ ok: true, job: null });
  await database().prepare(`UPDATE sales SET fiscal_status = 'processing' WHERE id = ?`).bind(job.saleId).run();
  await heartbeat(device, "printing");
  return json({
    ok: true,
    job: {
      ...job,
      attempts: job.attempts + 1,
      printer: { vendor: device.vendor, model: device.model, connector: device.connector },
      payload: JSON.parse(job.payload),
    },
  });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const store = storeValue(body.store);
  if (!store) return json({ error: "Negozio non valido." }, 400);
  const device = await authenticate(request, store);
  if (!device) return json({ error: "Ponte Windows non autorizzato o disabilitato." }, 401);
  const action = textValue(body.action, 30);
  if (action === "heartbeat") {
    await heartbeat(device, textValue(body.status, 80) || "online", textValue(body.error));
    return json({ ok: true });
  }

  if (action === "claimTicket") {
    const ticket = textValue(body.ticket, 160);
    if (!ticket) return json({ error: "Ticket fiscale locale mancante." }, 400);
    const ticketHash = await hashToken(ticket);
    const now = new Date().toISOString();
    const job = await database().prepare(`SELECT id, sale_id AS saleId, store, job_type AS jobType, payload, attempts, created_at AS createdAt FROM fiscal_jobs WHERE store = ? AND status = 'queued' AND json_extract(payload, '$.localTicketHash') = ? AND json_extract(payload, '$.localTicketExpiresAt') > ? LIMIT 1`)
      .bind(store, ticketHash, now).first<{ id: number; saleId: number; store: Store; jobType: string; payload: string; attempts: number; createdAt: string }>();
    if (!job) return json({ error: "Ticket fiscale scaduto, già usato o non valido." }, 404);
    const claimed = await database().prepare(`UPDATE fiscal_jobs SET status = 'processing', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
      .bind(now, now, job.id).run();
    if (!claimed.meta?.changes) return json({ error: "La stampa è già stata presa in carico." }, 409);
    await database().prepare(`UPDATE sales SET fiscal_status = 'processing' WHERE id = ?`).bind(job.saleId).run();
    await heartbeat(device, "printing");
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    delete payload.localTicketHash;
    delete payload.localTicketExpiresAt;
    return json({ ok: true, job: { ...job, attempts: job.attempts + 1, payload, printer: { vendor: device.vendor, model: device.model, connector: device.connector } } });
  }

  const jobId = Math.round(Number(body.jobId));
  if (!Number.isFinite(jobId) || jobId <= 0) return json({ error: "Richiesta fiscale non valida." }, 400);
  const job = await database().prepare(`SELECT id, sale_id AS saleId, status FROM fiscal_jobs WHERE id = ? AND store = ?`).bind(jobId, store).first<{ id: number; saleId: number; status: string }>();
  if (!job) return json({ error: "Richiesta fiscale non trovata per questo negozio." }, 404);
  if (action === "complete") {
    if (job.status === "printed") return json({ ok: true, alreadyCompleted: true });
    if (job.status !== "processing") return json({ error: "La richiesta non è in lavorazione." }, 409);
    const now = new Date().toISOString();
    const response = textValue(typeof body.response === "string" ? body.response : JSON.stringify(body.response ?? {}));
    await database().prepare(`UPDATE fiscal_jobs SET status = 'printed', device_response = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'`).bind(response, now, now, job.id).run();
    await database().prepare(`UPDATE sales SET fiscal_status = 'printed' WHERE id = ?`).bind(job.saleId).run();
    await heartbeat(device, "online");
    return json({ ok: true });
  }
  if (action === "fail") {
    if (job.status === "printed") return json({ error: "Lo scontrino risulta già stampato." }, 409);
    const now = new Date().toISOString();
    const error = textValue(body.error) || "Errore non specificato dal ponte Windows.";
    await database().prepare(`UPDATE fiscal_jobs SET status = 'error', device_response = ?, updated_at = ? WHERE id = ?`).bind(error, now, job.id).run();
    await database().prepare(`UPDATE sales SET fiscal_status = 'error' WHERE id = ?`).bind(job.saleId).run();
    await heartbeat(device, "error", error);
    return json({ ok: true });
  }
  return json({ error: "Azione non disponibile." }, 404);
}
