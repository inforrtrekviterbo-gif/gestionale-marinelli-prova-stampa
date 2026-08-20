import { createPdf, euro } from "../../../lib/pdf";
import { currentUser, database, ensureDatabase, json } from "../../../lib/runtime-db";

async function all<T>(sql: string, ...bindings: unknown[]) {
  const result = await database().prepare(sql).bind(...bindings).all<T>();
  return result.results ?? [];
}

function pdfResponse(bytes: Uint8Array, filename: string) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9_.-]/g, "-")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  await ensureDatabase();
  const user = await currentUser(request);
  if (!user || user.mustChangePassword) return json({ error: "Sessione scaduta o cambio password obbligatorio." }, 401);
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "";
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) return json({ error: "Documento non valido." }, 400);

  if (type === "receipt" || type === "courtesy" || type === "fiscal-receipt") {
    const sale = await database().prepare(`SELECT s.id, s.receipt_no AS receiptNo, s.store, s.total, s.cash_amount AS cashAmount, s.card_amount AS cardAmount, s.bank_amount AS bankAmount, s.gift_amount AS giftAmount, s.fiscal_document_type AS fiscalDocumentType, s.created_at AS createdAt, COALESCE(CASE WHEN c.customer_type = 'company' THEN c.company_name ELSE TRIM(c.first_name || ' ' || c.last_name) END, 'Cliente non associato') AS customerName FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`).bind(id).first<{ id: number; receiptNo: string; store: string; total: number; cashAmount: number; cardAmount: number; bankAmount: number; giftAmount: number; fiscalDocumentType: string; createdAt: string; customerName: string }>();
    if (!sale) return json({ error: "Vendita non trovata." }, 404);
    if (user.role !== "admin" && sale.store !== user.store) return json({ error: "Documento non disponibile per questa cassa." }, 403);
    if (type === "fiscal-receipt" && (sale.bankAmount <= 0 || sale.fiscalDocumentType !== "receipt")) return json({ error: "Scontrino fiscale automatico non disponibile per questa vendita." }, 404);
    const items = await all<{ description: string; quantity: number; unitPrice: number; lineTotal: number }>(`SELECT description, quantity, unit_price AS unitPrice, line_total AS lineTotal FROM sale_items WHERE sale_id = ? ORDER BY id`, id);
    const lines = [
      `Negozio: ${sale.store}`,
      `Data: ${new Date(sale.createdAt).toLocaleString("it-IT")}`,
      `Cliente: ${sale.customerName}`,
      `Numero vendita: ${sale.receiptNo}`,
      "------------------------------------------------------------",
      ...items.map((item) => `${item.quantity} x ${item.description.slice(0, 42)}  ${euro(item.lineTotal)}`),
      "------------------------------------------------------------",
      `TOTALE: ${euro(sale.total)}`,
      `Contanti: ${euro(sale.cashAmount)}   Carta: ${euro(sale.cardAmount)}   Bonifico: ${euro(sale.bankAmount)}   Buono: ${euro(sale.giftAmount)}`,
      type === "courtesy" ? "Documento di cortesia senza indicazione dei prezzi fiscali." : type === "fiscal-receipt" ? "Scontrino generato automaticamente per incasso tramite bonifico bancario." : "Ristampa interna di una vendita gia effettuata.",
    ];
    const title = type === "courtesy" ? "Scontrino di cortesia" : type === "fiscal-receipt" ? "Scontrino fiscale" : "Scontrino interno";
    const subtitle = type === "fiscal-receipt" ? "Pagamento tramite bonifico bancario" : "Copia non fiscale";
    return pdfResponse(createPdf({ title, subtitle, lines }), `${type}-${sale.receiptNo}.pdf`);
  }

  if (type === "gift") {
    const gift = await database().prepare(`SELECT code, beneficiary, initial_value AS initialValue, balance, expires_at AS expiresAt, store, created_at AS createdAt FROM gift_cards WHERE id = ?`).bind(id).first<{ code: string; beneficiary: string; initialValue: number; balance: number; expiresAt: string; store: string; createdAt: string }>();
    if (!gift) return json({ error: "Buono non trovato." }, 404);
    if (user.role !== "admin" && gift.store !== user.store) return json({ error: "Documento non disponibile per questa cassa." }, 403);
    return pdfResponse(createPdf({
      title: "Buono regalo",
      lines: [`Valore: ${euro(gift.initialValue)}`, `Intestatario: ${gift.beneficiary}`, `Scadenza: ${new Date(gift.expiresAt).toLocaleDateString("it-IT")}`, `Emesso da: ${gift.store}`, `Saldo attuale: ${euro(gift.balance)}`, "Presentare il codice alla cassa."],
      barcode: gift.code,
    }), `buono-${gift.code}.pdf`);
  }

  if (type === "reservation") {
    const reservation = await database().prepare(`SELECT r.id, r.code, r.store, r.description, r.kind, r.total_price AS totalPrice, r.deposit_amount AS depositAmount, r.balance_due AS balanceDue, r.status, r.created_at AS createdAt, COALESCE(CASE WHEN c.customer_type = 'company' THEN c.company_name ELSE TRIM(c.first_name || ' ' || c.last_name) END, 'Cliente non associato') AS customerName, COALESCE(c.phone, '') AS customerPhone FROM reservations r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`).bind(id).first<{ id: number; code: string; store: string; description: string; kind: string; totalPrice: number; depositAmount: number; balanceDue: number; status: string; createdAt: string; customerName: string; customerPhone: string }>();
    if (!reservation) return json({ error: "Prenotazione non trovata." }, 404);
    if (user.role !== "admin" && reservation.store !== user.store) return json({ error: "Documento non disponibile per questa cassa." }, 403);
    const items = await all<{ description: string; quantity: number; unitPrice: number; discountPercent: number }>(`SELECT description, quantity, unit_price AS unitPrice, discount_percent AS discountPercent FROM reservation_items WHERE reservation_id = ? ORDER BY id`, reservation.id);
    const productLines = items.length
      ? [reservation.kind === "repair" ? "Prodotti da risuolare:" : "Prodotti prenotati:", ...items.map((item) => `${item.quantity} x ${item.description.slice(0, 38)} - ${euro(item.unitPrice)} cad.${item.discountPercent > 0 ? ` - Sc. ${item.discountPercent}%` : ""} - ${euro(item.quantity * item.unitPrice * (1 - item.discountPercent / 100))}`)]
      : [`Descrizione: ${reservation.description}`];
    return pdfResponse(createPdf({
      title: reservation.kind === "repair" ? "Scheda risuolatura" : "Prenotazione multiprodotto",
      subtitle: "Documento operativo con richiamo EAN",
      lines: [`Codice operazione: ${reservation.code}`, `Data: ${new Date(reservation.createdAt).toLocaleString("it-IT")}`, `Cliente: ${reservation.customerName}${reservation.customerPhone ? ` · ${reservation.customerPhone}` : ""}`, `Negozio: ${reservation.store}`, ...productLines, "------------------------------------------------------------", `Totale concordato: ${euro(reservation.totalPrice)}`, `Acconto versato: ${euro(reservation.depositAmount)}`, `SALDO AL RITIRO: ${euro(reservation.balanceDue)}`, `Stato: ${reservation.status}`, "Scansionare questo EAN in Cassa per richiamare e saldare l'operazione."],
      barcode: reservation.code,
    }), `${reservation.kind === "repair" ? "risuolatura" : "prenotazione"}-${reservation.code}.pdf`);
  }

  if (type === "ddt") {
    const transfer = await database().prepare(`SELECT id, code, from_store AS fromStore, to_store AS toStore, sender, receiver, carrier, transport_reason AS transportReason, created_at AS createdAt FROM transfers WHERE id = ?`).bind(id).first<{ id: number; code: string; fromStore: string; toStore: string; sender: string; receiver: string; carrier: string; transportReason: string; createdAt: string }>();
    if (!transfer) return json({ error: "Trasferimento non trovato." }, 404);
    if (user.role !== "admin" && transfer.fromStore !== user.store) return json({ error: "Documento non disponibile per questa cassa." }, 403);
    const items = await all<{ sku: string; name: string; color: string; size: string; quantity: number }>(`SELECT p.sku, p.name, p.color, p.size, ti.quantity FROM transfer_items ti JOIN products p ON p.id = ti.product_id WHERE ti.transfer_id = ?`, id);
    const lines = [`Numero DDT: ${transfer.code}`, `Data: ${new Date(transfer.createdAt).toLocaleString("it-IT")}`, `Mittente: ${transfer.sender}`, `Ricevente: ${transfer.receiver}`, `Vettore: ${transfer.carrier}`, `Causale: ${transfer.transportReason}`, `Da ${transfer.fromStore} a ${transfer.toStore}`, "------------------------------------------------------------", ...items.map((item) => `${item.quantity} x ${item.sku} - ${item.name} ${item.color ?? ""} ${item.size ?? ""}`)];
    return pdfResponse(createPdf({ title: "Documento di trasporto", lines }), `DDT-${transfer.code}.pdf`);
  }

  if (type === "document") {
    if (user.role !== "admin") return json({ error: "Funzione riservata all'amministratore." }, 403);
    const document = await database().prepare(`SELECT id, number, type, recipient, recipient_vat_number AS recipientVatNumber, recipient_pec AS recipientPec, recipient_sdi_code AS recipientSdiCode, recipient_address AS recipientAddress, recipient_postal_code AS recipientPostalCode, recipient_city AS recipientCity, recipient_province AS recipientProvince, origin, payment_method AS paymentMethod, net_total AS netTotal, tax_total AS taxTotal, total, created_at AS createdAt FROM business_documents WHERE id = ?`).bind(id).first<{ id: number; number: string; type: string; recipient: string; recipientVatNumber: string; recipientPec: string; recipientSdiCode: string; recipientAddress: string; recipientPostalCode: string; recipientCity: string; recipientProvince: string; origin: string; paymentMethod: string; netTotal: number; taxTotal: number; total: number; createdAt: string }>();
    if (!document) return json({ error: "Documento non trovato." }, 404);
    const items = await all<{ description: string; quantity: number; unitPrice: number; lineTotal: number; taxRate: number; taxAmount: number; grossTotal: number }>(`SELECT description, quantity, unit_price AS unitPrice, line_total AS lineTotal, tax_rate AS taxRate, tax_amount AS taxAmount, gross_total AS grossTotal FROM business_document_items WHERE document_id = ? ORDER BY id`, id);
    const location = [document.recipientPostalCode, document.recipientCity, document.recipientProvince].filter(Boolean).join(" ");
    const recipientLines = [
      `Destinatario: ${document.recipient}`,
      document.recipientVatNumber ? `P.IVA destinatario: ${document.recipientVatNumber}` : "",
      document.recipientAddress ? `Indirizzo: ${document.recipientAddress}${location ? ` - ${location}` : ""}` : (location ? `Localita: ${location}` : ""),
      document.recipientPec ? `PEC: ${document.recipientPec}` : "",
      document.recipientSdiCode ? `Codice SDI: ${document.recipientSdiCode}` : "",
    ].filter(Boolean);
    const lines = [
      `Numero: ${document.number}`,
      `Data: ${new Date(document.createdAt).toLocaleDateString("it-IT")}`,
      ...recipientLines,
      `Origine merce: ${document.origin}`,
      `Pagamento: ${document.paymentMethod === "bank" ? "Bonifico bancario" : document.paymentMethod === "card" ? "Carta" : "Contanti"}`,
      "------------------------------------------------------------",
      "ARTICOLI - PREZZI UNITARI E IMPONIBILI IVA ESCLUSA",
      ...items.map((item) => `${item.quantity} x ${item.description.slice(0, 32)} - ${euro(item.unitPrice)} - IVA ${item.taxRate}% - ${euro(item.grossTotal)}`),
      "------------------------------------------------------------",
      `Imponibile: ${euro(document.netTotal)}`,
      `IVA: ${euro(document.taxTotal)}`,
      `TOTALE DOCUMENTO: ${euro(document.total)}`,
    ];
    return pdfResponse(createPdf({ title: document.type === "invoice" ? "Fattura" : "Preventivo", subtitle: document.number, lines }), `${document.number}.pdf`);
  }
  return json({ error: "Tipo di documento non disponibile." }, 404);
}
