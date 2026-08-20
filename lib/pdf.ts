type PdfOptions = {
  title: string;
  subtitle?: string;
  lines: string[];
  barcode?: string | null;
};

const eanL = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const eanG = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const eanR = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const eanParity = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function ascii(value: string) {
  return value.replaceAll("·", "-").replaceAll("€", "EUR").replace(/[’‘]/g, "'").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
}

function escapePdf(value: string) {
  return ascii(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function barcodeBits(code: string) {
  if (!/^\d{13}$/.test(code)) return null;
  const first = Number(code[0]);
  const parity = eanParity[first];
  let bits = "101";
  for (let index = 1; index <= 6; index += 1) {
    const digit = Number(code[index]);
    bits += parity[index - 1] === "L" ? eanL[digit] : eanG[digit];
  }
  bits += "01010";
  for (let index = 7; index <= 12; index += 1) bits += eanR[Number(code[index])];
  return `${bits}101`;
}

function textCommand(value: string, x: number, y: number, size: number, bold = false, gray = "0") {
  return `${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${escapePdf(value)}) Tj ET`;
}

export function createPdf(options: PdfOptions) {
  const commands: string[] = [
    "q 0 g 0 724 595 118 re f Q",
    "q 1 g 0 G 1.5 w 36 758 48 48 re B Q",
    textCommand("MS", 48, 775, 16, true, "0"),
    textCommand("MARINELLI STEFANO", 102, 788, 19, true, "1"),
    textCommand("P.IVA 02504600566", 102, 769, 10, false, "1"),
    textCommand("STRADA CASSIA NORD KM 85+800", 102, 753, 10, false, "1"),
    "q 1 g 0 G 1.2 w 35 667 525 42 re B Q",
    textCommand(options.title, 48, 682, 20, true, "0"),
  ];
  if (options.subtitle) commands.push(textCommand(options.subtitle, 365, 684, 9, false, "0.28"));

  const visibleLines = options.lines.slice(0, 42);
  const lowerBoundary = options.barcode ? 186 : 58;
  const lineHeight = Math.max(11, Math.min(17, (646 - lowerBoundary) / Math.max(visibleLines.length, 1)));
  let y = 646;
  visibleLines.forEach((line, index) => {
    if (line.startsWith("---")) {
      commands.push(`0.55 G 48 ${y + 4} m 547 ${y + 4} l S`);
      y -= Math.max(8, lineHeight * .65);
      return;
    }
    const totalLine = /^(TOTALE|SALDO|IMPORTO DA PAGARE)/i.test(line);
    if (totalLine) {
      commands.push(`q 0 g 42 ${y - 5} 511 ${lineHeight + 5} re f Q`);
      commands.push(textCommand(line.slice(0, 92), 51, y, Math.min(11, lineHeight - 2), true, "1"));
    } else {
      if (index % 2 === 1) commands.push(`q 0.94 g 42 ${y - 5} 511 ${lineHeight + 4} re f Q`);
      const emphasized = /^(Numero|Codice|Cliente|Data|Negozio|Valore|Acconto|Totale concordato|Prodotti prenotati|Prodotti da risuolare|Descrizione|Mittente|Ricevente|Vettore|Causale)/i.test(line);
      commands.push(textCommand(line.slice(0, 92), 51, y, Math.min(10, lineHeight - 1), emphasized));
    }
    y -= lineHeight;
  });
  if (options.lines.length > visibleLines.length) commands.push(textCommand(`Altre ${options.lines.length - visibleLines.length} voci non visualizzate`, 51, y, 9, true, "0"));

  const bits = options.barcode ? barcodeBits(options.barcode) : null;
  if (bits && options.barcode) {
    const moduleWidth = 1.9;
    const startX = (595 - bits.length * moduleWidth) / 2;
    const panelBottom = Math.max(46, y - 150);
    const startY = panelBottom + 25;
    commands.push(
      `q 1 g 0 G 1.5 w 145 ${panelBottom} 305 122 re B Q`,
      textCommand("EAN PER RICHIAMO RAPIDO IN CASSA", 196, panelBottom + 102, 8, true, "0"),
      "0 g",
    );
    for (let index = 0; index < bits.length; index += 1) {
      if (bits[index] !== "1") continue;
      const guard = index < 3 || (index >= 45 && index < 50) || index >= 92;
      commands.push(`${startX + index * moduleWidth} ${startY} ${moduleWidth} ${guard ? 58 : 50} re f`);
    }
    commands.push(textCommand(options.barcode, 249, panelBottom + 9, 10, true, "0"));
  }

  commands.push(
    "0.55 G 35 35 m 560 35 l S",
    textCommand("Marinelli Stefano · Documento generato dal gestionale", 42, 20, 8, false, "0.35"),
    textCommand("Pagina 1", 510, 20, 8, false, "0.35"),
  );

  const stream = `${commands.join("\n")}\n`;
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n`,
    `6 0 obj\n<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let content = "%PDF-1.4\n%1234\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(new TextEncoder().encode(content).length);
    content += object;
  }
  const xref = new TextEncoder().encode(content).length;
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) content += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(content);
}

export function euro(value: number) {
  return `${value.toFixed(2)} EUR`;
}
