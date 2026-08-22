"use client";

import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { firebaseAuthenticatedFetch } from "../lib/firebase-client";

type Store = "Viterbo" | "Gran Sasso";
type User = { role: "admin" | "viterbo" | "gran_sasso"; store: Store | null };
type Product = {
  id: number;
  sku: string;
  name: string;
  brand: string;
  color: string;
  size: string;
  price: number;
  eans: string;
  viterboQty: number;
  viterboReserved: number;
  granSassoQty: number;
  granSassoReserved: number;
};
type Customer = { id: number; customerType: "private" | "company"; firstName: string; lastName: string; companyName: string; vatNumber: string; pec: string; sdiCode: string; city: string; phone: string; scope: string };
type Gift = { id: number; issuedSaleId: number };
type Reservation = { id: number; issuedSaleId: number; kind: string };
type FiscalDevice = { id: number; store: Store; vendor: string; model: string; enabled: number; hasToken: number; lastSeenAt: string | null; lastStatus: string; lastError: string | null };
type FiscalJob = { id: number; saleId: number; store: Store; status: string; attempts: number; deviceResponse: string | null; receiptNo: string };
type CashData = { user: User; products: Product[]; customers: Customer[]; gifts: Gift[]; reservations: Reservation[]; fiscalDevices: FiscalDevice[]; fiscalJobs: FiscalJob[]; generatedAt: string };
type CartItem = {
  key: string;
  productId: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  itemType: string;
  locked?: boolean;
  metadata: Record<string, unknown>;
};

type ReservationDraftLine = {
  key: string;
  productId: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
};

const money = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
const productLabel = (product: Product) => `${product.brand ? `${product.brand} · ` : ""}${product.name} · ${product.color} ${product.size}`;
const customerLabel = (customer: Customer) => customer.customerType === "company" ? customer.companyName : `${customer.firstName} ${customer.lastName}`.trim();
const keyId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const todayPlusYear = () => new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const fiscalJobLabel: Record<string, string> = { awaiting_setup: "Configurazione RT da completare", queued: "Scontrino in coda", processing: "Stampa RT in corso", printed: "Scontrino RT stampato", error: "Errore stampa RT" };
let localFiscalPrintActive = false;

type LocalFiscalPayload = {
  documentType?: string;
  total: number;
  adjustment?: number;
  lines: Array<{ description: string; quantity: number; lineTotal: number; itemType?: string; metadata?: Record<string, unknown> }>;
  payments: Array<{ method: string; amount: number }>;
};

function eurosToRchCents(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().replace(",", ".") : value;
  const euros = Number(normalized);
  if (!Number.isFinite(euros)) throw new Error("Importo non valido per la cassa RCH.");
  const cents = Math.round(euros * 100);
  if (!Number.isSafeInteger(cents)) throw new Error("Importo in centesimi non valido per la cassa RCH.");
  return cents;
}

function rchDescription(value: unknown) {
  return String(value || "ARTICOLO")
    .replace(/[\r\n/()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20) || "ARTICOLO";
}

function buildRchPaymentCommands(payload: LocalFiscalPayload) {
  const paymentIndexes: Record<string, number> = { cash: 1, card: 4, bank: 8, gift: 10 };
  const paymentOrder = ["gift", "cash", "bank", "card"];
  const amounts = new Map<string, number>();

  for (const payment of payload.payments ?? []) {
    const amount = eurosToRchCents(payment.amount);
    if (amount <= 0) continue;
    if (!(payment.method in paymentIndexes)) throw new Error(`Pagamento RCH non configurato: ${payment.method}.`);
    amounts.set(payment.method, (amounts.get(payment.method) ?? 0) + amount);
  }

  const expectedTotal = eurosToRchCents(payload.total);
  const paymentTotal = [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
  if (paymentTotal !== expectedTotal) throw new Error("La somma dei pagamenti RCH non coincide con il totale dello scontrino.");

  const activeMethods = paymentOrder.filter((method) => (amounts.get(method) ?? 0) > 0);
  if (!activeMethods.length) throw new Error("Lo scontrino RCH non contiene un pagamento valido.");
  if (activeMethods.length === 1) return [`=T${paymentIndexes[activeMethods[0]]}`];

  return activeMethods.map((method) => `=T${paymentIndexes[method]}/$${amounts.get(method)}`);
}

function buildRchReceiptCommands(payload: LocalFiscalPayload | null | undefined) {
  if (!payload || !Array.isArray(payload.lines)) throw new Error("Dati fiscali RCH non disponibili.");
  const lines = payload.lines.filter((line) => Number(line.quantity) > 0 && line.itemType !== "return");
  if (!lines.length) throw new Error("Lo scontrino RCH non contiene prodotti stampabili.");
  if (payload.lines.some((line) => Number(line.quantity) < 0 || line.itemType === "return")) {
    throw new Error("Il reso richiede il protocollo fiscale RCH dedicato e non può essere inviato come vendita standard.");
  }

  const amounts = lines.map((line) => eurosToRchCents(line.lineTotal));
  if (amounts.some((amount) => amount <= 0)) throw new Error("Gli importi dello scontrino RCH devono essere maggiori di zero.");

  const commands = ["=C1"];
  lines.forEach((line, index) => {
    const descPulita = rchDescription(line.description).replace(/[\(\)]/g, "").trim().substring(0, 20);
    // Sostituiamo /1/ con /a/ prima della descrizione per mappare l'aliquota IVA standard 22% richiesta dal tracciato
    commands.push(`=R22/$${amounts[index]}/a/${descPulita}`);
  });
  commands.push("=S", ...buildRchPaymentCommands(payload));

  return `${commands.join("\r\n")}\r\n`;
}

// --- UNIVERSAL LOCAL BRIDGE CONNECTOR ---
function localFiscalBridgeRequest(message: Record<string, unknown> | string, responseTimeout = 200000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const isPrint = typeof message === "object" && message !== null && message.action === "printFiscalReceipt";
    if (isPrint) localFiscalPrintActive = true;
    let settled = false;
    const socket = new WebSocket("ws://localhost:8085/", "marinelli-rt");
    const openTimer = window.setTimeout(() => finish(new Error("Collegamento locale al registratore non disponibile. Verificare l'Agent locale.")), 6000);
    const responseTimer = window.setTimeout(() => finish(new Error("Il registratore non ha concluso la stampa entro il tempo previsto.")), responseTimeout);

    function finish(result: Record<string, unknown> | Error) {
      if (settled) return;
      settled = true;
      window.clearTimeout(openTimer);
      window.clearTimeout(responseTimer);
      if (isPrint) localFiscalPrintActive = false;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      if (result instanceof Error) reject(result); else resolve(result);
    }

    socket.addEventListener("open", () => {
      window.clearTimeout(openTimer);
      socket.send(typeof message === "string" ? message : JSON.stringify(message));
    });

    socket.addEventListener("message", (event) => {
      void (async () => {
        const raw = event.data instanceof Blob ? await event.data.text() : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : String(event.data);
        if (raw.includes("\x15") || /\bNACK\b/i.test(raw)) {
          finish(Object.assign(new Error("Errore Cassa RCH/EPSON"), { code: "RT_NACK" }));
          return;
        }
        try {
          const result = JSON.parse(raw) as Record<string, unknown>;
          if (result.ok === true) finish(result);
          else {
            const code = String(result.code || "");
            const message = ["RT_NACK", "RCH_NACK"].includes(code) ? "Errore Cassa RCH" : String(result.error || "Errore registratore fiscale.");
            finish(Object.assign(new Error(message), { code }));
          }
        } catch {
          if (/\b(?:ERRORE|ERROR|FAIL|KO)\b/i.test(raw)) finish(new Error(raw.trim() || "Errore registratore fiscale."));
          else if (raw.includes("\x06") || /\b(?:ACK|OK|SUCCESS)\b/i.test(raw)) finish({ ok: true, response: raw });
          else finish(new Error("Risposta non valida dal collegamento locale del registratore."));
        }
      })();
    });

    socket.addEventListener("error", () => finish(new Error("Collegamento locale al registratore non disponibile.")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("Il collegamento locale al registratore si è interrotto."));
    });
  });
}

async function confirmPhysicalRchPrint(jobId: number, bridgeResult: Record<string, unknown>) {
  if (bridgeResult.requiresPhysicalConfirmation !== true) return;
  const printed = window.confirm("La RCH ha stampato e fatto avanzare lo scontrino completo? Conferma soltanto dopo averlo verificato fisicamente.");
  if (!printed) {
    throw Object.assign(new Error("Comandi inviati alla RCH, ma stampa fisica non confermata. Verifica il display e NON ristampare senza controllo."), { code: "PHYSICAL_PRINT_NOT_CONFIRMED" });
  }
  try {
    await post("completeLocalFiscalJob", { jobId, response: "Stampa RCH verificata fisicamente dall'operatore." });
  } catch {
    throw Object.assign(new Error("Stampa RCH confermata, ma aggiornamento del gestionale non riuscito. NON RISTAMPARE."), { code: "CONFIRMATION_PENDING" });
  }
}

function makeEan13() {
  const base = `29${Date.now().toString().slice(-10)}`.slice(0, 12);
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(base[index]) * (index % 2 === 0 ? 1 : 3);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({ error: "Risposta non valida." }));
  if (!response.ok) throw Object.assign(new Error(data.error ?? "Operazione non riuscita."), { data, status: response.status });
  return data;
}

async function post(action: string, values: Record<string, unknown> = {}) {
  return readJson(await firebaseAuthenticatedFetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...values }),
  }));
}

type ClearableProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  label?: string;
  value: string | number;
  onChange: (value: string) => void;
  compact?: boolean;
};

function ClearableInput({ label, value, onChange, compact, className = "", ...props }: ClearableProps) {
  return (
    <label className={`field ${compact ? "field-compact" : ""} ${className}`}>
      {label && <span>{label}</span>}
      <span className="input-wrap">
        <input {...props} value={value} onChange={(event) => onChange(event.target.value)} />
        {String(value).length > 0 && <button type="button" className="clear-input" aria-label={`Cancella ${label ?? "campo"}`} onClick={() => onChange("")}>×</button>}
      </span>
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal"><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></div>{children}</div></div>;
}

function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

function lineTotal(item: CartItem) {
  return Math.round(item.quantity * item.unitPrice * (1 - item.discountPercent / 100) * 100) / 100;
}

function reservationLineTotal(item: ReservationDraftLine) {
  return Math.round(item.quantity * item.unitPrice * (1 - item.discountPercent / 100) * 100) / 100;
}

type CartDetailLine = { description: string; quantity: number; unitPrice: number; discountPercent: number };

function cartDetailLines(item: CartItem): CartDetailLine[] {
  const rows = item.metadata.reservationItems;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const detail = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return {
      description: String(detail.description ?? "Prodotto"),
      quantity: Math.max(1, Number(detail.quantity) || 1),
      unitPrice: Math.max(0, Number(detail.unitPrice) || 0),
      discountPercent: Math.min(100, Math.max(0, Number(detail.discountPercent) || 0)),
    };
  }).filter((row) => row.description.trim());
}

function Scanner({ onScan }: { onScan: (code: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  const lastAutomatic = useRef("");
  async function scan(value: string) {
    const normalized = value.trim();
    if (!normalized || normalized === lastAutomatic.current) return;
    lastAutomatic.current = normalized;
    await onScan(normalized);
    setCode("");
    window.setTimeout(() => { lastAutomatic.current = ""; }, 500);
  }
  function change(value: string) {
    setCode(value);
    if (/^\d{13}$/.test(value.trim())) void scan(value);
  }
  return <ClearableInput label="Inserimento EAN" value={code} onChange={change} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void scan(code); } }} placeholder="Scansiona prodotto, buono o acconto…" inputMode="numeric" autoFocus />;
}

function CustomerForm({ store, reload, close }: { store: Store; reload: () => Promise<void>; close: () => void }) {
  const [form, setForm] = useState({ customerType: "private" as "private" | "company", firstName: "", lastName: "", companyName: "", vatNumber: "", pec: "", sdiCode: "", phone: "", email: "", address: "", postalCode: "", city: "", province: "", taxCode: "" });
  const [error, setError] = useState("");
  const set = (name: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try { await post("createCustomer", { ...form, store }); await reload(); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Errore."); }
  }
  return <form className="stack" onSubmit={save}><div className="customer-type-tabs"><button type="button" className={form.customerType === "private" ? "active" : ""} onClick={() => setForm((current) => ({ ...current, customerType: "private" }))}>Privato</button><button type="button" className={form.customerType === "company" ? "active" : ""} onClick={() => setForm((current) => ({ ...current, customerType: "company" }))}>Azienda / Società</button></div><div className="form-grid">{form.customerType === "private" ? <><ClearableInput label="Nome" value={form.firstName} onChange={set("firstName")} required /><ClearableInput label="Cognome" value={form.lastName} onChange={set("lastName")} required /><ClearableInput label="Codice fiscale" value={form.taxCode} onChange={set("taxCode")} /></> : <><ClearableInput className="full" label="Ragione sociale" value={form.companyName} onChange={set("companyName")} required /><ClearableInput label="Partita IVA" value={form.vatNumber} onChange={set("vatNumber")} required /><ClearableInput label="PEC" value={form.pec} onChange={set("pec")} /><ClearableInput label="Codice SDI" value={form.sdiCode} onChange={set("sdiCode")} /></>}<ClearableInput label="Telefono" value={form.phone} onChange={set("phone")} /><ClearableInput label="Email" value={form.email} onChange={set("email")} /><ClearableInput className="full" label="Indirizzo" value={form.address} onChange={set("address")} /><ClearableInput label="CAP" value={form.postalCode} onChange={set("postalCode")} /><ClearableInput label="Comune" value={form.city} onChange={set("city")} /><ClearableInput label="Provincia" value={form.province} onChange={set("province")} />{error && <div className="alert danger full">{error}</div>}<div className="form-actions full"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Salva {form.customerType === "company" ? "azienda" : "privato"}</button></div></div></form>;
}

function GiftForm({ add, close }: { add: (item: CartItem) => void; close: () => void }) {
  const [beneficiary, setBeneficiary] = useState("");
  const [amount, setAmount] = useState("");
  const [expiresAt, setExpiresAt] = useState(todayPlusYear());
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); const value = Number(amount); if (value <= 0) return; add({ key: keyId(), productId: null, description: `Buono regalo · ${beneficiary || "Non indicato"}`, quantity: 1, unitPrice: value, discountPercent: 0, itemType: "gift", metadata: { beneficiary: beneficiary || "Non indicato", expiresAt, code: makeEan13() } }); }}><p className="muted">Il buono viene creato soltanto al completamento della vendita.</p><ClearableInput label="Intestatario" value={beneficiary} onChange={setBeneficiary} /><ClearableInput label="Valore" type="number" step="0.01" value={amount} onChange={setAmount} required /><ClearableInput label="Scadenza" type="date" value={expiresAt} onChange={setExpiresAt} required /><div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Aggiungi al carrello</button></div></form>;
}

function ServiceForm({ title, defaultDescription, add, close }: { title: string; defaultDescription: string; add: (item: CartItem) => void; close: () => void }) {
  const isVarious = defaultDescription === "Varie";
  const [description, setDescription] = useState(isVarious ? "" : defaultDescription);
  const [amount, setAmount] = useState("");
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); const article = description.trim(); if (!article || Number(amount) <= 0) return; add({ key: keyId(), productId: null, description: isVarious ? `Varie · ${article}` : article, quantity: 1, unitPrice: Number(amount), discountPercent: 0, itemType: "service", metadata: { category: defaultDescription, articleDescription: article } }); }}><p className="muted">{title}</p><ClearableInput label={isVarious ? "Descrizione articolo venduto" : "Descrizione"} value={description} onChange={setDescription} required /><ClearableInput label="Importo" type="number" min="0" step="0.01" value={amount} onChange={setAmount} required /><div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Aggiungi al carrello</button></div></form>;
}

function DepositForm({ products, store, repair, add, close }: { products: Product[]; store: Store; repair: boolean; add: (item: CartItem) => void; close: () => void }) {
  const [description, setDescription] = useState(repair ? "Risuolatura multiprodotto" : "Prenotazione prodotti");
  const [lines, setLines] = useState<ReservationDraftLine[]>([]);
  const [ean, setEan] = useState("");
  const [repairArticle, setRepairArticle] = useState("");
  const [repairQuantity, setRepairQuantity] = useState("1");
  const [repairCost, setRepairCost] = useState("");
  const [total, setTotal] = useState("");
  const [deposit, setDeposit] = useState("");
  const [error, setError] = useState("");
  const lastAutomatic = useRef("");

  function availability(product: Product) {
    return store === "Viterbo" ? product.viterboQty - product.viterboReserved : product.granSassoQty - product.granSassoReserved;
  }

  function updateLines(next: ReservationDraftLine[]) {
    setLines(next);
    setTotal(String(Math.round(next.reduce((sum, item) => sum + reservationLineTotal(item), 0) * 100) / 100));
  }

  function scan(value: string) {
    const code = value.trim();
    if (!code || code === lastAutomatic.current) return;
    lastAutomatic.current = code;
    const product = products.find((item) => item.eans.split(",").includes(code));
    if (!product) {
      setError("EAN non riconosciuto.");
    } else {
      const existing = lines.find((item) => item.productId === product.id);
      const nextQuantity = (existing?.quantity ?? 0) + 1;
      if (nextQuantity > availability(product)) {
        setError(`${product.name}: disponibili ${availability(product)} pezzi a ${store}.`);
      } else {
        const next = existing
          ? lines.map((item) => item.productId === product.id ? { ...item, quantity: nextQuantity } : item)
          : [...lines, { key: keyId(), productId: product.id, description: productLabel(product), quantity: 1, unitPrice: product.price, discountPercent: 0 }];
        updateLines(next); setError("");
      }
    }
    setEan("");
    window.setTimeout(() => { lastAutomatic.current = ""; }, 400);
  }

  function addRepairLine() {
    const article = repairArticle.trim();
    const quantity = Math.max(1, Math.round(Number(repairQuantity) || 1));
    const cost = Math.max(0, Number(repairCost) || 0);
    if (!article || cost <= 0) { setError("Inserisci descrizione e costo del prodotto da risuolare."); return; }
    updateLines([...lines, { key: keyId(), productId: null, description: article, quantity, unitPrice: cost, discountPercent: 0 }]);
    setRepairArticle(""); setRepairQuantity("1"); setRepairCost(""); setError("");
  }

  function changeLine(key: string, change: Partial<Pick<ReservationDraftLine, "description" | "quantity" | "unitPrice" | "discountPercent">>) {
    const line = lines.find((item) => item.key === key);
    const product = products.find((item) => item.id === line?.productId);
    if (!line) return;
    const nextLine = {
      ...line,
      ...change,
      quantity: Math.max(1, Math.round(change.quantity ?? line.quantity)),
      unitPrice: Math.max(0, change.unitPrice ?? line.unitPrice),
      discountPercent: Math.min(100, Math.max(0, change.discountPercent ?? line.discountPercent)),
    };
    if (!repair && (!product || nextLine.quantity > availability(product))) { setError(product ? `${product.name}: disponibili ${availability(product)} pezzi a ${store}.` : "Prodotto non valido."); return; }
    updateLines(lines.map((item) => item.key === key ? nextLine : item)); setError("");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const totalValue = Number(total); const depositValue = Number(deposit || 0);
    if (!lines.length) { setError(repair ? "Aggiungi almeno un prodotto da risuolare." : "Scansiona almeno un prodotto da prenotare."); return; }
    if (lines.some((line) => !line.description.trim() || line.unitPrice <= 0)) { setError("Controlla descrizione e costo di tutti i prodotti."); return; }
    if (!description || totalValue <= 0 || depositValue < 0 || depositValue > totalValue) { setError("Controlla descrizione, totale e acconto."); return; }
    const articleCount = lines.reduce((sum, item) => sum + item.quantity, 0);
    add({
      key: keyId(),
      productId: null,
      description: repair ? `Risuolatura · ${articleCount} ${articleCount === 1 ? "articolo" : "articoli"}` : `Prenotazione · ${articleCount} ${articleCount === 1 ? "articolo" : "articoli"}`,
      quantity: 1,
      unitPrice: depositValue,
      discountPercent: 0,
      itemType: repair ? "repair_deposit" : "deposit",
      metadata: { totalPrice: totalValue, code: makeEan13(), reservationItems: lines.map(({ productId, description: lineDescription, quantity, unitPrice, discountPercent }) => ({ productId, description: lineDescription, quantity, unitPrice, discountPercent })) },
    });
  }

  return <form className="stack" onSubmit={submit}>
    {repair ? <div className="reservation-scanner"><p className="muted">Aggiungi tutti i prodotti affidati dal cliente: resteranno riuniti nella stessa risuolatura e nello stesso PDF.</p><div className="repair-entry-grid"><ClearableInput label="Descrizione prodotto da risuolare" value={repairArticle} onChange={setRepairArticle} placeholder="Es. Scarponcino marrone uomo" /><ClearableInput label="Quantità" type="number" min="1" step="1" value={repairQuantity} onChange={setRepairQuantity} /><ClearableInput label="Costo unitario" type="number" min="0" step="0.01" value={repairCost} onChange={setRepairCost} /><button type="button" className="secondary align-end" onClick={addRepairLine}>＋ Aggiungi prodotto</button></div></div> : <div className="reservation-scanner"><ClearableInput label="Scansiona EAN prodotto" value={ean} onChange={(value) => { setEan(value); if (/^\d{13}$/.test(value.trim())) scan(value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); scan(ean); } }} placeholder="Scansiona un prodotto alla volta…" inputMode="numeric" autoFocus /><p className="muted">Ogni scansione aggiunge il prodotto alla stessa prenotazione e aggiorna automaticamente il totale.</p></div>}
    {lines.length > 0 && <>{repair ? <div className="repair-draft-header"><span>Prodotto da risuolare</span><span>Qtà</span><span>Costo</span><span>Totale</span><span /></div> : <div className="reservation-draft-header"><span>Prodotto</span><span>Qtà</span><span>Importo</span><span>Sconto %</span><span>Totale</span><span /></div>}<div className="reservation-draft-list">{lines.map((line) => repair ? <div className="repair-draft-row" key={line.key}><ClearableInput compact aria-label="Descrizione prodotto da risuolare" value={line.description} onChange={(value) => changeLine(line.key, { description: value })} /><ClearableInput compact aria-label="Quantità da risuolare" type="number" min="1" step="1" value={line.quantity} onChange={(value) => changeLine(line.key, { quantity: Number(value) || 1 })} /><ClearableInput compact aria-label="Costo unitario risuolatura" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(value) => changeLine(line.key, { unitPrice: Number(value) || 0 })} /><b>{money(reservationLineTotal(line))}</b><button type="button" className="icon-button" onClick={() => updateLines(lines.filter((item) => item.key !== line.key))}>×</button></div> : <div className="reservation-draft-row" key={line.key}><div className="cart-desc"><strong>{line.description}</strong><small>Disponibili: {availability(products.find((item) => item.id === line.productId)!)}</small></div><ClearableInput compact aria-label="Quantità prenotata" type="number" min="1" step="1" value={line.quantity} onChange={(value) => changeLine(line.key, { quantity: Number(value) || 1 })} /><ClearableInput compact aria-label="Importo unitario prenotazione" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(value) => changeLine(line.key, { unitPrice: Number(value) || 0 })} /><ClearableInput compact aria-label="Sconto prodotto prenotazione" type="number" min="0" max="100" step="0.01" value={line.discountPercent} onChange={(value) => changeLine(line.key, { discountPercent: Number(value) || 0 })} /><b>{money(reservationLineTotal(line))}</b><button type="button" className="icon-button" onClick={() => updateLines(lines.filter((item) => item.key !== line.key))}>×</button></div>)}</div></>}
    <ClearableInput label={repair ? "Descrizione / note lavorazione" : "Descrizione / note"} value={description} onChange={setDescription} />
    <ClearableInput label={repair ? "Totale risuolatura automatico e modificabile" : "Totale prenotazione automatico e modificabile"} type="number" min="0" step="0.01" value={total} onChange={setTotal} />
    <ClearableInput label="Acconto da incassare ora" type="number" min="0" step="0.01" value={deposit} onChange={setDeposit} placeholder="0,00" />
    {error && <div className="alert danger">⚠ {error}</div>}<p className="muted">Verrà generato un unico PDF con tutti i prodotti e un solo EAN per richiamare rapidamente l’operazione al saldo.</p><div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary">Aggiungi al carrello</button></div>
  </form>;
}

type ReturnProduct = Pick<Product, "id" | "name" | "color" | "size">;
type ReturnableLine = { saleItemId: number; saleId: number; productId: number | null; description: string; itemType: string; receiptNo: string; createdAt: string; customerName: string; originalGiftCode: string | null; unitPrice: number; discountPercent: number; finalUnitPrice: number; purchasedQty: number; returnedQty: number; returnableQty: number };

function ReturnForm({ store, add, close }: { store: Store; add: (item: CartItem) => void; close: () => void }) {
  const [ean, setEan] = useState(""); const [receipt, setReceipt] = useState(""); const [selectedLine, setSelectedLine] = useState<ReturnableLine | null>(null); const [receiptLines, setReceiptLines] = useState<ReturnableLine[]>([]); const [quantity, setQuantity] = useState("1"); const [error, setError] = useState(""); const lastAutomatic = useRef("");
  async function recognize(value = ean) {
    const code = value.trim();
    if (!code || code === lastAutomatic.current) return;
    lastAutomatic.current = code; setError(""); setSelectedLine(null); setReceiptLines([]);
    try {
      const result = await readJson(await fetch(`/api/data?view=returnPrice&q=${encodeURIComponent(code)}&store=${encodeURIComponent(store)}&receipt=${encodeURIComponent(receipt)}`));
      const found = result.product as ReturnProduct;
      const foundSale = result.sale as ReturnableLine;
      setSelectedLine({ ...foundSale, productId: found.id, description: foundSale.description || `${found.name} · ${found.color} ${found.size}`, itemType: "product" }); setReceipt(foundSale.receiptNo); setQuantity("1");
    } catch (reason) { setSelectedLine(null); setError(reason instanceof Error ? reason.message : "EAN non riconosciuto."); }
    window.setTimeout(() => { lastAutomatic.current = ""; }, 500);
  }
  async function loadReceipt() {
    setError(""); setSelectedLine(null); setReceiptLines([]);
    try {
      const result = await readJson(await fetch(`/api/data?view=returnReceipt&store=${encodeURIComponent(store)}&receipt=${encodeURIComponent(receipt)}`));
      setReceiptLines(result.items as ReturnableLine[]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Scontrino non trovato."); }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const returnQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
    if (!selectedLine || returnQuantity > selectedLine.returnableQty) { setError(`Puoi restituire al massimo ${selectedLine?.returnableQty ?? 0} pezzi.`); return; }
    add({ key: keyId(), productId: selectedLine.productId, description: `Reso ${selectedLine.description} · ${selectedLine.receiptNo}`, quantity: -returnQuantity, unitPrice: selectedLine.finalUnitPrice, discountPercent: 0, itemType: "return", locked: true, metadata: { originalSaleItemId: selectedLine.saleItemId, originalSaleId: selectedLine.saleId, originalReceipt: selectedLine.receiptNo, originalItemType: selectedLine.itemType, originalPurchasePrice: selectedLine.finalUnitPrice, originalGiftCode: selectedLine.originalGiftCode, store } });
  }
  return <form className="stack" onSubmit={submit}><p className="muted">Scansiona l’EAN di un prodotto oppure inserisci lo scontrino per scegliere anche una vendita “Varie”. Il prezzo di reso è sempre quello finale realmente pagato.</p><div className="return-receipt-search"><ClearableInput label="Scontrino originale" value={receipt} onChange={(value) => { setReceipt(value); setSelectedLine(null); setReceiptLines([]); }} placeholder="Es. VT-… o GS-…" /><button type="button" className="secondary align-end" onClick={() => void loadReceipt()}>Carica righe scontrino</button></div>{receiptLines.length > 0 && <div className="choice-list return-line-list">{receiptLines.map((line) => <button type="button" className={selectedLine?.saleItemId === line.saleItemId ? "selected" : ""} key={line.saleItemId} onClick={() => { setSelectedLine(line); setQuantity("1"); }}><span><strong>{line.description}</strong><small>{line.itemType === "service" ? "Vendita Varie" : "Prodotto"} · restituibili {line.returnableQty}</small></span><b>{money(line.finalUnitPrice)}</b></button>)}</div>}<div className="return-divider"><span>oppure usa l’EAN prodotto</span></div><ClearableInput label="EAN prodotto restituito" value={ean} onChange={(value) => { setEan(value); if (/^\d{13}$/.test(value.trim())) void recognize(value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void recognize(); } }} inputMode="numeric" autoFocus /><button type="button" className="secondary" onClick={() => void recognize()}>Trova vendita e prezzo finale</button>{selectedLine && <div className="return-sale-card"><div><span>Riga da restituire</span><strong>{selectedLine.description}</strong></div><div><span>Vendita originale</span><strong>{selectedLine.receiptNo}</strong><small>{new Date(selectedLine.createdAt).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })} · {selectedLine.customerName}</small></div><div><span>Prezzo finale pagato</span><strong>{money(selectedLine.finalUnitPrice)}</strong><small>Prezzo riga {money(selectedLine.unitPrice)} · sconto {selectedLine.discountPercent}%</small></div><div><span>Quantità restituibile</span><strong>{selectedLine.returnableQty} di {selectedLine.purchasedQty}</strong><small>Già restituiti: {selectedLine.returnedQty}</small></div>{selectedLine.originalGiftCode && <div><span>Pagamento originale</span><strong>Buono regalo</strong><small>Se resta credito verrà generato automaticamente un nuovo buono intestato alla stessa persona.</small></div>}</div>}{error && <div className="alert danger">{error}</div>}{selectedLine && <ClearableInput label="Quantità da rendere" type="number" min="1" max={selectedLine.returnableQty} step="1" value={quantity} onChange={setQuantity} />}<div className="form-actions"><button type="button" className="secondary" onClick={close}>Annulla</button><button className="primary" disabled={!selectedLine}>Aggiungi reso al cambio</button></div></form>;
}

export default function CashRegister({ data, reload }: { data: CashData; reload: () => Promise<void> }) {
  const [adminStore, setAdminStore] = useState<Store>("Viterbo");
  const store = data.user.store ?? adminStore;
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [modal, setModal] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [cartDiscount, setCartDiscount] = useState("");
  const [totalOverride, setTotalOverride] = useState("");
  const [payment, setPayment] = useState("cash");
  const [cashAmount, setCashAmount] = useState("");
  const [cardAmount, setCardAmount] = useState("");
  const [giftCode, setGiftCode] = useState("");
  const [giftAmount, setGiftAmount] = useState("");
  const [fiscalDocumentType, setFiscalDocumentType] = useState<"receipt" | "invoice">("receipt");
  const [lastSale, setLastSale] = useState<{ id: number; receiptNo: string; automaticFiscalDocument: string | null; invoiceDocument: { id: number; number: string } | null; fiscalJob: { id: number; status: string } | null; replacementGift: { id: number; code: string; value: number; beneficiary: string } | null } | null>(null);

  const priceBeforeDiscounts = useMemo(() => Math.round(cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) * 100) / 100, [cart]);
  const subtotal = useMemo(() => Math.round(cart.reduce((sum, item) => sum + lineTotal(item), 0) * 100) / 100, [cart]);
  const totalAfterCartDiscount = Math.round(subtotal * (1 - Math.min(100, Math.max(0, Number(cartDiscount) || 0)) / 100) * 100) / 100;
  const total = totalOverride === "" ? totalAfterCartDiscount : Number(totalOverride) || 0;
  const hasReturn = cart.some((item) => item.itemType === "return");
  const returnCredit = Math.round(Math.abs(cart.filter((item) => item.itemType === "return").reduce((sum, item) => sum + lineTotal(item), 0)) * 100) / 100;
  const exchangePurchase = Math.round(cart.filter((item) => item.itemType !== "return").reduce((sum, item) => sum + lineTotal(item), 0) * 100) / 100;
  const hasGiftOriginReturn = cart.some((item) => item.itemType === "return" && Boolean(item.metadata.originalGiftCode));
  const createsResidualGift = hasGiftOriginReturn && total < -0.001;
  const customerMatches = useMemo(() => { const query = customerQuery.trim().toLocaleLowerCase("it"); return query ? data.customers.filter((item) => `${customerLabel(item)} ${item.vatNumber}`.toLocaleLowerCase("it").includes(query)).slice(0, 8) : []; }, [data.customers, customerQuery]);
  const fiscalDevice = data.fiscalDevices.find((device) => device.store === store);
  const fiscalRecent = Boolean(fiscalDevice?.enabled && fiscalDevice.lastSeenAt && new Date(data.generatedAt).getTime() - new Date(fiscalDevice.lastSeenAt).getTime() < 15000);
  const fiscalOnline = Boolean(fiscalRecent && fiscalDevice?.lastStatus === "online");
  const fiscalNetworkReady = Boolean(fiscalRecent && fiscalDevice?.lastStatus === "network_ready");
  const lastFiscalJob = lastSale ? data.fiscalJobs.find((job) => job.saleId === lastSale.id) ?? (lastSale.fiscalJob ? { ...lastSale.fiscalJob, saleId: lastSale.id, store, attempts: 0, deviceResponse: null, receiptNo: lastSale.receiptNo } : null) : null;

  useEffect(() => {
    let active = true;
    const ping = () => { if (active && !localFiscalPrintActive) void localFiscalBridgeRequest({ action: "ping", store }, 8000).catch(() => undefined); };
    ping();
    const interval = window.setInterval(ping, 10000);
    return () => { active = false; window.clearInterval(interval); };
  }, [store]);

  function available(product: Product) {
    return store === "Viterbo" ? product.viterboQty - product.viterboReserved : product.granSassoQty - product.granSassoReserved;
  }

  function addProduct(product: Product) {
    const alreadyInCart = cart
      .filter((item) => item.productId === product.id && item.itemType === "product")
      .reduce((sum, item) => sum + item.quantity, 0);
    if (alreadyInCart + 1 > available(product)) { setError(`${product.name}: quantità disponibile a ${store} esaurita.`); return; }
    setCart((current) => {
      const existing = current.find((item) => item.productId === product.id && item.itemType === "product");
      return existing ? current.map((item) => item.key === existing.key ? { ...item, quantity: item.quantity + 1 } : item) : [...current, { key: keyId(), productId: product.id, description: productLabel(product), quantity: 1, unitPrice: product.price, discountPercent: 0, itemType: "product", metadata: {} }];
    });
    setTotalOverride(""); setError(""); setNotice(`${product.name} aggiunto automaticamente al carrello.`);
  }

  function addDraft(item: CartItem) { setCart((current) => [...current, item]); setTotalOverride(""); setModal(null); }
  function updateItem(key: string, change: Partial<CartItem>) { setCart((current) => current.map((item) => item.key === key ? { ...item, ...change } : item)); setTotalOverride(""); }
  function updateItemTotal(item: CartItem, value: string) {
    const base = item.quantity * item.unitPrice;
    if (base <= 0) return;
    const requested = Math.min(base, Math.max(0, Number(value) || 0));
    const discountPercent = Math.round((1 - requested / base) * 10000) / 100;
    updateItem(item.key, { discountPercent });
  }
  function removeItem(key: string) { setCart((current) => current.filter((item) => item.key !== key)); setTotalOverride(""); }

  async function scan(code: string) {
    setError(""); setNotice("");
    try {
      const result = await readJson(await fetch(`/api/data?view=code&q=${encodeURIComponent(code)}`));
      if (result.kind === "product") {
        const product = data.products.find((item) => item.id === Number(result.record.id));
        if (!product) throw new Error("Prodotto non disponibile nell'elenco attuale.");
        addProduct(product);
      } else if (result.kind === "gift") {
        const amount = Math.min(Number(result.record.balance) || 0, Math.max(0, total));
        setPayment("gift"); setGiftCode(result.record.code); setGiftAmount(String(amount)); setCashAmount(String(Math.max(0, total - amount))); setCardAmount("");
        setNotice(`Buono riconosciuto automaticamente. Saldo disponibile: ${money(result.record.balance)}.`);
      } else if (result.kind === "reservation") {
        if (result.record.status !== "open") throw new Error("Questa prenotazione o risuolatura risulta già saldata.");
        if (result.record.store !== store) throw new Error(`Acconto emesso dalla cassa ${result.record.store}.`);
        if (cart.some((item) => item.itemType === "reservation_balance" && item.metadata.code === result.record.code)) throw new Error("Questa operazione è già presente nel carrello.");
        setCart((current) => [...current, { key: keyId(), productId: null, description: `Saldo ${result.record.kind === "repair" ? "risuolatura" : "prenotazione"}: ${result.record.description}`, quantity: 1, unitPrice: Number(result.record.balanceDue), discountPercent: 0, itemType: "reservation_balance", locked: true, metadata: { code: result.record.code, reservationKind: result.record.kind, totalPrice: result.record.totalPrice, reservationItems: result.items ?? [] } }]);
        setTotalOverride(""); setNotice("Acconto riconosciuto: il saldo è stato aggiunto al carrello.");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "EAN non riconosciuto."); }
  }

  function payments() {
    if (createsResidualGift) return { cashAmount: 0, cardAmount: 0, bankAmount: 0, giftAmount: total, giftCodeUsed: "" };
    if (payment === "cash") return { cashAmount: total, cardAmount: 0, bankAmount: 0, giftAmount: 0, giftCodeUsed: "" };
    if (payment === "card") return { cashAmount: 0, cardAmount: total, bankAmount: 0, giftAmount: 0, giftCodeUsed: "" };
    if (payment === "bank") return { cashAmount: 0, cardAmount: 0, bankAmount: total, giftAmount: 0, giftCodeUsed: "" };
    if (payment === "mixed") return { cashAmount: Number(cashAmount) || 0, cardAmount: Number(cardAmount) || 0, bankAmount: 0, giftAmount: 0, giftCodeUsed: "" };
    return { cashAmount: Number(cashAmount) || 0, cardAmount: Number(cardAmount) || 0, bankAmount: 0, giftAmount: Number(giftAmount) || 0, giftCodeUsed: giftCode };
  }

  async function completeSale() {
    setError(""); setNotice("");
    try {
      const result = await post("createSale", { store, customerId: customer?.id ?? null, items: cart, total, fiscalDocumentType, ...payments() });
      let fiscalError = "";
      let fiscalMessage = result.fiscalJob?.status === "awaiting_setup" ? "Registratore RT da configurare: la richiesta resta salvata." : "";
      if (result.realtimeSynced && result.localFiscalTicket && result.fiscalJob?.id) {
        try {
          const bridgeResult = await localFiscalBridgeRequest({
            action: "printFiscalReceipt",
            store,
            ticket: result.localFiscalTicket,
            ...(store === "Viterbo" ? { rchCommands: buildRchReceiptCommands(result.localFiscalPayload as LocalFiscalPayload) } : {}),
          });
          if (store === "Viterbo") await confirmPhysicalRchPrint(result.fiscalJob.id, bridgeResult);
          result.fiscalJob.status = "printed";
          fiscalMessage = typeof bridgeResult.warning === "string" ? bridgeResult.warning : "Scontrino RT stampato.";
        } catch (reason) {
          fiscalError = reason instanceof Error ? reason.message : "Errore registratore fiscale.";
          result.fiscalJob.status = "error";
          if ((reason as Error & { code?: string })?.code !== "CONFIRMATION_PENDING") {
            await post("failLocalFiscalJob", { jobId: result.fiscalJob.id, error: fiscalError }).catch(() => undefined);
          }
        }
      }
      setLastSale({ id: result.saleId, receiptNo: result.receiptNo, automaticFiscalDocument: result.automaticFiscalDocument ?? null, invoiceDocument: result.invoiceDocument ?? null, fiscalJob: result.fiscalJob ?? null, replacementGift: result.replacementGift ?? null });
      setCart([]); setCartDiscount(""); setTotalOverride(""); setCashAmount(""); setCardAmount(""); setGiftAmount(""); setGiftCode(""); setCustomer(null); setCustomerQuery(""); setPayment("cash"); setFiscalDocumentType("receipt");
      const realtimeMessage = result.realtimeSynced ? "Vendita sincronizzata in tempo reale." : result.realtimeWarning ?? "Sincronizzazione Firebase in attesa.";
      setNotice(hasReturn ? `Cambio ${result.receiptNo} registrato. ${result.replacementGift ? `Buono precedente stornato: nuovo buono da ${money(result.replacementGift.value)} intestato a ${result.replacementGift.beneficiary}.` : total > 0 ? `Differenza incassata: ${money(total)}.` : total < 0 ? `Rimborso registrato: ${money(Math.abs(total))}.` : "Cambio alla pari."} ${fiscalMessage} ${realtimeMessage}` : payment === "bank" ? `Vendita ${result.receiptNo} registrata con bonifico. ${result.invoiceDocument ? `Fattura ${result.invoiceDocument.number} generata automaticamente.` : fiscalMessage} ${realtimeMessage}` : `Vendita ${result.receiptNo} registrata. ${fiscalMessage} ${realtimeMessage}`);
      if (fiscalError) setError(fiscalError);
      await reload();
    } catch (reason) {
      const extended = reason as Error & { data?: { insufficient?: string[] } };
      setError(`${extended.message}${extended.data?.insufficient?.length ? `: ${extended.data.insufficient.join(", ")}` : ""}`);
    }
  }

  async function retryFiscal() {
    if (!lastFiscalJob || !["error", "awaiting_setup"].includes(lastFiscalJob.status)) return;
    if (!confirm("Verifica che il registratore non abbia già stampato lo scontrino. Confermi la rimessa in coda?")) return;
    setError("");
    try {
      const result = await post("retryFiscalJob", { jobId: lastFiscalJob.id });
      const retryStore = (result.store ?? store) as Store;
      const bridgeResult = await localFiscalBridgeRequest({
        action: "printFiscalReceipt",
        store: retryStore,
        ticket: result.localFiscalTicket,
        ...(retryStore === "Viterbo" ? { rchCommands: buildRchReceiptCommands(result.localFiscalPayload as LocalFiscalPayload) } : {}),
      });
      if (retryStore === "Viterbo") await confirmPhysicalRchPrint(lastFiscalJob.id, bridgeResult);
      setNotice(typeof bridgeResult.warning === "string" ? bridgeResult.warning : "Scontrino RT stampato.");
      await reload();
    }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : "Errore durante la rimessa in coda.";
      if ((reason as Error & { code?: string })?.code !== "CONFIRMATION_PENDING") {
        await post("failLocalFiscalJob", { jobId: lastFiscalJob.id, error: message }).catch(() => undefined);
      }
      setError(message);
      await reload();
    }
  }

  return (
    <section className="screen">
      <div className="screen-head"><div><p className="eyebrow">POSTAZIONE OPERATIVA</p><h1>Cassa {store}</h1><span className={`cash-fiscal-status ${fiscalOnline || fiscalNetworkReady ? "ready" : fiscalDevice?.lastStatus === "error" ? "failed" : "waiting"}`}><i />{fiscalOnline ? `${fiscalDevice?.vendor} ${fiscalDevice?.model} collegato` : fiscalNetworkReady ? `Rete ${fiscalDevice?.vendor} verificata · ${fiscalDevice?.model}` : fiscalDevice?.lastStatus === "error" ? `Errore collegamento locale · ${fiscalDevice.vendor} ${fiscalDevice.model}` : fiscalDevice?.enabled ? `Registratore non raggiungibile · ${fiscalDevice.vendor} ${fiscalDevice.model}` : `Registratore RT non abilitato · ${fiscalDevice?.vendor ?? ""} ${fiscalDevice?.model ?? ""}`}</span></div>{data.user.role === "admin" && <label className="field inline"><span>Negozio</span><select value={adminStore} onChange={(event) => setAdminStore(event.target.value as Store)}><option>Viterbo</option><option>Gran Sasso</option></select></label>}</div>
      {notice && <div className="alert success">{notice}</div>}
      {error && <div className="alert danger visual-alert">⚠ {error}</div>}
      <div className="cash-grid">
        <div className="cash-main">
          <div className="panel scanner-panel"><div><p className="eyebrow">SCANNER UNICO</p><h2>Prodotti, buoni e acconti</h2><p className="muted">La lettura EAN aggiunge automaticamente il prodotto disponibile oppure riconosce buoni, prenotazioni e acconti risuolatura.</p></div><Scanner onScan={scan} /></div>
          <div className="panel"><div className="panel-title"><div><p className="eyebrow">CLIENTE</p><h2>{customer ? customerLabel(customer) : "Associa cliente o azienda"}</h2></div>{customer && <button className="text-button" onClick={() => setCustomer(null)}>Rimuovi</button>}</div><ClearableInput value={customerQuery} onChange={setCustomerQuery} placeholder="Nome, società o P.IVA…" />{customerMatches.length > 0 && <div className="customer-dropdown">{customerMatches.map((item) => <button key={item.id} onClick={() => { setCustomer(item); setCustomerQuery(""); }}><strong>{customerLabel(item)}</strong><small>{item.vatNumber || item.city || item.phone || item.scope}</small></button>)}</div>}</div>
          <div className="actions-strip"><button onClick={() => setModal("customer")}>＋<span>Nuovo cliente</span></button><button onClick={() => setModal("gift")}>🎁<span>Buono regalo</span></button><button onClick={() => setModal("varie")}>＋<span>Varie</span></button>{store === "Viterbo" ? <button onClick={() => setModal("repair")}>↗<span>Risuolatura</span></button> : <button onClick={() => setModal("shirt")}>◫<span>Maglie Gran Sasso</span></button>}<button onClick={() => setModal("reservation")}>▣<span>Prenotazione</span></button><button onClick={() => setModal("return")}>↩<span>Reso / cambio</span></button></div>
          <div className="panel cart-panel"><div className="panel-title"><div><p className="eyebrow">VENDITA</p><h2>Prodotti nel carrello</h2></div><span className="count-pill">{cart.length} righe</span></div>{!cart.length ? <Empty>Scansiona un EAN per inserire automaticamente il prodotto.</Empty> : <><div className="cart-header"><span>Prodotto</span><span>Qtà</span><span>Prezzo vendita</span><span>Sconto %</span><span>Totale modificabile</span><span /></div><div className="cart-list">{cart.map((item) => { const details = cartDetailLines(item); const editableTotal = !item.locked && item.quantity > 0 && !["gift", "deposit", "repair_deposit"].includes(item.itemType); return <div className={`cart-row cash-cart-row ${item.itemType === "return" ? "return-row" : ""}`} key={item.key}><div className="cart-desc"><strong>{item.description}</strong><small>{item.itemType.replaceAll("_", " ")}</small></div><ClearableInput compact aria-label="Quantità" type="number" step="1" value={item.quantity} onChange={(value) => updateItem(item.key, { quantity: Number(value) || 0 })} disabled={item.locked} /><ClearableInput compact aria-label="Prezzo di vendita unitario" type="number" step="0.01" value={item.unitPrice} onChange={(value) => updateItem(item.key, { unitPrice: Number(value) || 0 })} disabled={item.locked} /><ClearableInput compact aria-label="Sconto percentuale" type="number" min="0" max="100" step="0.01" value={item.discountPercent} onChange={(value) => updateItem(item.key, { discountPercent: Math.min(100, Math.max(0, Number(value) || 0)) })} disabled={item.locked} />{editableTotal ? <ClearableInput compact aria-label="Importo totale prodotto" type="number" min="0" max={item.quantity * item.unitPrice} step="0.01" value={lineTotal(item)} onChange={(value) => updateItemTotal(item, value)} /> : <b>{money(lineTotal(item))}</b>}<button className="icon-button" onClick={() => removeItem(item.key)}>×</button>{details.length > 0 && <div className="cart-subitems"><div className="cart-subitems-head"><span>Dettaglio prodotti</span><span>Qtà</span><span>Costo</span></div>{details.map((detail, index) => <div className="cart-subitem" key={`${item.key}-detail-${index}`}><span>{detail.description}</span><span>{detail.quantity}</span><b>{money(detail.quantity * detail.unitPrice * (1 - detail.discountPercent / 100))}</b></div>)}<div className="cart-subitems-total"><span>Totale operazione</span><b>{money(Number(item.metadata.totalPrice) || details.reduce((sum, detail) => sum + detail.quantity * detail.unitPrice * (1 - detail.discountPercent / 100), 0))}</b></div></div>}</div>; })}</div></>}</div>
        </div>
        <aside className="checkout">
          <div><p className="eyebrow">RIEPILOGO</p>{hasReturn && <div className="exchange-summary"><div><span>Valore reso</span><b>− {money(returnCredit)}</b></div><div><span>Nuovi articoli</span><b>{money(exchangePurchase)}</b></div><div className={total < 0 ? "refund" : "difference"}><span>{total > 0 ? "Differenza da incassare" : total < 0 ? createsResidualGift ? "Credito su nuovo buono" : "Rimborso al cliente" : "Cambio alla pari"}</span><strong>{money(Math.abs(total))}</strong></div></div>}<div className="total-line"><span>Prezzo prima degli sconti</span><b>{money(priceBeforeDiscounts)}</b></div><div className="total-line"><span>Dopo sconti prodotti</span><b>{money(subtotal)}</b></div><ClearableInput label="Sconto totale carrello %" type="number" min="0" max="100" step="0.01" value={cartDiscount} onChange={(value) => { setCartDiscount(value); setTotalOverride(""); }} /><ClearableInput label="Totale carrello modificabile" type="number" step="0.01" value={totalOverride} onChange={setTotalOverride} placeholder={totalAfterCartDiscount.toFixed(2)} /><div className="grand-total"><span>{hasReturn ? "Differenza finale" : "Totale"}</span><strong>{money(total)}</strong></div></div>
          <div><p className="eyebrow">PAGAMENTO</p>{createsResidualGift && <div className="gift-credit-notice"><strong>Buono residuo automatico</strong><span>Il buono originale verrà stornato. Il credito sarà trasferito su un nuovo buono intestato alla stessa persona.</span></div>}<div className="payment-tabs">{[["cash", "Contanti"], ["card", "Carta"], ["mixed", "Misto"], ["gift", "Buono"], ...(data.user.role === "admin" ? [["bank", "Bonifico"]] : [])].map(([value, label]) => <button key={value} className={payment === value ? "active" : ""} onClick={() => setPayment(value)} disabled={createsResidualGift}>{label}</button>)}</div>{!createsResidualGift && payment === "mixed" && <div className="split-fields"><ClearableInput label="Contanti" type="number" step="0.01" value={cashAmount} onChange={setCashAmount} /><ClearableInput label="Carta" type="number" step="0.01" value={cardAmount} onChange={setCardAmount} /></div>}{!createsResidualGift && payment === "gift" && <div className="stack compact-stack"><ClearableInput label="Codice EAN buono" value={giftCode} onChange={setGiftCode} /><ClearableInput label="Importo da scalare" type="number" step="0.01" value={giftAmount} onChange={setGiftAmount} /><ClearableInput label="Residuo contanti" type="number" step="0.01" value={cashAmount} onChange={setCashAmount} /><ClearableInput label="Residuo carta" type="number" step="0.01" value={cardAmount} onChange={setCardAmount} /></div>}{!createsResidualGift && payment === "bank" && <div className="bank-payment-box"><label className="field"><span>Documento collegato al bonifico</span><select value={fiscalDocumentType} onChange={(event) => setFiscalDocumentType(event.target.value as "receipt" | "invoice")}><option value="receipt">Scontrino fiscale automatico</option><option value="invoice">Fattura automatica</option></select></label>{fiscalDocumentType === "invoice" && !customer && <div className="alert danger">Associa prima un cliente o un’azienda per intestare la fattura.</div>}<p className="muted">Importo bonifico: <strong>{money(total)}</strong></p></div>}</div>
          <button className="primary checkout-button" disabled={!cart.length || (!createsResidualGift && payment === "bank" && fiscalDocumentType === "invoice" && !customer)} onClick={completeSale}>{hasReturn ? total < 0 ? createsResidualGift ? `Registra reso · genera buono ${money(Math.abs(total))}` : `Registra reso · rimborso ${money(Math.abs(total))}` : `Completa cambio · ${money(total)}` : `Completa vendita · ${money(total)}`}</button>
          {lastSale && <div className="last-sale"><strong>Vendita {lastSale.receiptNo}</strong>{lastFiscalJob && <div className={`fiscal-job-result ${lastFiscalJob.status}`}><i />{fiscalJobLabel[lastFiscalJob.status] ?? lastFiscalJob.status}{lastFiscalJob.status === "error" && lastFiscalJob.deviceResponse && <small>{lastFiscalJob.deviceResponse}</small>}{["error", "awaiting_setup"].includes(lastFiscalJob.status) && <button className="text-button" onClick={retryFiscal}>Rimetti in coda dopo verifica</button>}</div>}{lastSale.automaticFiscalDocument === "receipt" && <a className="secondary" href={`/api/pdf?type=fiscal-receipt&id=${lastSale.id}`}>Copia scontrino fiscale</a>}{lastSale.invoiceDocument && <a className="secondary" href={`/api/pdf?type=document&id=${lastSale.invoiceDocument.id}`}>Fattura {lastSale.invoiceDocument.number}</a>}<a className="secondary" href={`/api/pdf?type=courtesy&id=${lastSale.id}`}>Scontrino cortesia PDF</a><a className="text-button" href={`/api/pdf?type=receipt&id=${lastSale.id}`}>Scontrino interno</a>{lastSale.replacementGift && <a className="secondary" href={`/api/pdf?type=gift&id=${lastSale.replacementGift.id}`}>PDF nuovo buono · {money(lastSale.replacementGift.value)}</a>}{!lastSale.replacementGift && data.gifts.filter((gift) => gift.issuedSaleId === lastSale.id).map((gift) => <a key={gift.id} className="secondary" href={`/api/pdf?type=gift&id=${gift.id}`}>PDF buono regalo</a>)}{data.reservations.filter((reservation) => reservation.issuedSaleId === lastSale.id).map((reservation) => <a key={reservation.id} className="secondary" href={`/api/pdf?type=reservation&id=${reservation.id}`}>{reservation.kind === "repair" ? "PDF risuolatura con EAN" : "PDF prenotazione con EAN"}</a>)}</div>}
          <p className="fine-print">Il bonifico è disponibile soltanto all’amministratore e genera il documento selezionato.</p>
        </aside>
      </div>
      {modal && <Modal title={modal === "customer" ? "Nuovo cliente" : modal === "gift" ? "Buono regalo" : modal === "repair" ? "Risuolatura multiprodotto" : modal === "reservation" ? "Prenotazione multiprodotto" : modal === "return" ? "Reso o cambio" : modal === "shirt" ? "Maglie Gran Sasso" : "Varie"} onClose={() => setModal(null)}>{modal === "customer" && <CustomerForm store={store} reload={reload} close={() => setModal(null)} />}{modal === "gift" && <GiftForm add={addDraft} close={() => setModal(null)} />}{modal === "varie" && <ServiceForm title="Vendita varie" defaultDescription="Varie" add={addDraft} close={() => setModal(null)} />}{modal === "shirt" && <ServiceForm title="Vendita dedicata Gran Sasso" defaultDescription="Maglie Gran Sasso" add={addDraft} close={() => setModal(null)} />}{modal === "repair" && <DepositForm products={[]} store={store} repair add={addDraft} close={() => setModal(null)} />}{modal === "reservation" && <DepositForm products={data.products} store={store} repair={false} add={addDraft} close={() => setModal(null)} />}{modal === "return" && <ReturnForm store={store} add={addDraft} close={() => setModal(null)} />}</Modal>}
    </section>
  );
}
