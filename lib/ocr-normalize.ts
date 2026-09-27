import { isImplausibleOrganizationName } from './document-party-roles';

/** Normalizza testo OCR prima del parsing documenti. */
export function normalizeOcrText(rawText: string): string {
  return rawText
    .replace(/\r/g, '\n')
    .replace(/[|]/g, 'I')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * OCR repair for alphabetic document-number prefixes only.
 * Example: `0C-2025-0547` -> `OC-2025-0547`.
 *
 * Never rewrites `0` inside a numeric-only sequence.
 */
export function repairDocumentNumberPrefixOcr(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(
    /^0([A-Za-z][A-Za-z0-9]{0,3})(?=[-/](?:19|20)\d{2}\b)/,
    'O$1'
  );
}

const REA_OR_PROVINCE_CODE =
  /^(?:VI|VIA|RA|REA|IT|VR|PD|TV|VE|TN|BL|RO|FE|BO|MI|RM|NA|TO|GE|FI|BA|CT|PA|CA|NA|RE|MO|PR|PC|BO|BG|BS|VA|CO|LC|MB|SO|CR|MN|LO|PV|AL|AT|CN|NO|VC|BI|VB|AO|CN|SV|IM|SP|LU|PT|AR|SI|GR|LI|MS|PI|PO|AN|MC|AP|FM|PU|MC|TE|PE|CH|AQ|CB|IS|CE|BN|SA|AV|PZ|MT|CS|CZ|RC|KR|VV|TP|ME|AG|CL|EN|RG|SR|CT|TP|SU|OR|SS|NU|OT|CA|VS|CI|OG|OT|SS|NU|SU|OR|VS|CI|OG|PN|UD|GO|TS|BZ|BL|TN)$/i;

/** Evita falsi positivi tipo VI-126060 (R.E.A.) o VIA-126060 (Viale + REA). */
export function isLikelyReaOrAddressCode(code: string): boolean {
  const normalized = code.replace(/\s+/g, '-').toUpperCase();
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length < 2) return false;
  const prefix = parts[0];
  const digits = parts[parts.length - 1].replace(/\D/g, '');
  if (digits.length >= 5 && REA_OR_PROVINCE_CODE.test(prefix)) return true;
  if (/^VIA$/i.test(prefix) && digits.length >= 5) return true;
  return false;
}

const CURRENCY_DOCUMENT_CODE = /^(USD|EUR|GBP|CHF|USO|CAD|AUD)$/i;

/** Cerca codici tipo IT-001 anche con OCR impreciso (I7-001, IT 001). */
export function findDocumentCode(rawText: string): string {
  const patterns = [
    /\b([A-Z]{1,3}\s*-\s*\d{2,6})\b/i,
    /\b([A-Z]{1,3}\s+\d{2,6})\b/,
    /\b([A-Z]{2}\d{3,6})\b/,
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    if (match) {
      const code = match[1].replace(/\s+/g, '-').toUpperCase();
      const prefix = code.split('-')[0] ?? '';
      if (CURRENCY_DOCUMENT_CODE.test(prefix)) continue;
      if (!isLikelyReaOrAddressCode(code)) return code;
    }
  }

  return '';
}

/** Numero documento in formato italiano (812/Z). Esclude date tipo 04/05/2026. */
export function findSlashDocumentNumber(rawText: string): string {
  const labeled = rawText.match(
    /numero\s*documento\s*[:\-]?\s*(\d+\s*\/\s*[A-Z0-9]{1,4})/i
  );
  if (labeled?.[1]) {
    const value = labeled[1].replace(/\s+/g, '');
    if (!/^\d{1,2}\/\d{1,2}/.test(value)) return value;
  }

  const inline = rawText.match(/\b(\d{2,5}\s*\/\s*[A-Z][A-Z0-9]{0,3})\b/);
  if (inline?.[1]) return inline[1].replace(/\s+/g, '');

  return '';
}

const RECIPIENT_ANCHOR = /destinatario/i;
const CUSTOMER_LABEL =
  /(?:fatturare|fatturar|bill\s*to|inviare\s*a|spedire\s*a|cliente|customer|destinatario)/i;

const CUSTOMER_LABEL_ONLY =
  /^(?:destinatario|cliente|spett\.?|spett(?:abile)?\.?|fatturare|inviare\s*a|spedire\s*a|customer|bill\s*to|le)$/i;

const SALUTATION_FRAGMENT =
  /^(?:le|sig\.?ra?|sig\.?|spett\.?|spett(?:abile)?\.?|e\.?p\.?c\.?|all(?:a)?\s+c\.?a\.?)$/i;

const PERSON_NAME =
  /\b([A-ZÀ-ÿ][a-zà-ÿ]{1,24}(?:\s+[A-ZÀ-ÿ][a-zà-ÿ]{1,24}){1,3})\b/;

const PERSON_NAME_ALLCAPS =
  /\b([A-ZÀ-Ü]{2,}(?:\s+[A-ZÀ-Ü]{2,}){1,3})\b/;

const DATE_IN_LINE = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/;

const DOCUMENT_TYPE_HEADER =
  /^(?:conferma\s+ordine|ordine\s+cliente|ordine\s+di\s+acquisto|preventivo|fattura|nota\s+credito|offerta|quotazione|ddt|documento\s+di\s+trasporto|tipo\s+documento|tipo\s+documente|order\s+confirmation|purchase\s+order|sales\s+order|bon\s+de\s+commande|confirmation\s+de\s+commande)\b/i;

const DOCUMENT_TYPE_HEADER_EXACT =
  /^(?:ordine|preventivo|fattura|offerta|quote|quotation|invoice|devis|facture)(?:\s*(?:n[°º.]|no\.?|number|#).*)?$/i;

/** Intestazioni di documento OCR — non sono nomi cliente/destinatario. */
export function isDocumentTypeHeaderText(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (DOCUMENT_TYPE_HEADER.test(text)) return true;
  if (DOCUMENT_TYPE_HEADER_EXACT.test(text)) return true;
  if (/^(?:conferma|preventivo|fattura|ordine|offerta)\s+[a-zà-ü]{2,}/i.test(text)) return true;
  return false;
}

function isCustomerReferenceLabelLine(line: string): boolean {
  return /^(?:n\.?\s*)?riferimento\s+cl/i.test(line.trim());
}

function isSkippedRecipientContextLine(line: string): boolean {
  return (
    isCustomerReferenceLabelLine(line) ||
    /^(?:tipo|numero|data|pagina|valido|preventivo|ordine|targa|telaio|km|fabbrica|articolo|descrizione|importo|totale|materiale|manodopera|firme|immatricolazione|versione|marca|modello|dettaglio\s+documento|tipo\s+pagamento|tipo\s+documento)/i.test(line) ||
    isTaxOrFiscalLabelText(line) ||
    isDocumentTypeHeaderText(line) ||
    /^via\b/i.test(line) ||
    /^\d{5}\b/.test(line)
  );
}

function stripCustomerPrefix(value: string): string {
  return value
    .replace(/^spett\.?\s*(?:le\s+)?/i, '')
    .replace(/^destinatario\s*[:\-]?\s*/i, '')
    .replace(/^cliente\s*[:\-]?\s*/i, '')
    .trim();
}

function titleCaseToken(value: string): string {
  if (!value) return value;
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Mantiene l'ordine del documento (COGNOME NOME), senza scambiare. */
function formatRecipientName(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.every((p) => /^[A-ZÀ-Ü]{2,}$/.test(p))) {
    return parts.join(' ');
  }
  return parts.map(titleCaseToken).join(' ');
}

function isCustomerLabelOnly(value: string): boolean {
  const bare = value.replace(/[:\-–—.,\s]+$/g, '').trim();
  return CUSTOMER_LABEL_ONLY.test(bare);
}

function isSalutationFragment(value: string): boolean {
  const bare = value.replace(/[.:,\s]+$/g, '').trim();
  return SALUTATION_FRAGMENT.test(bare);
}

/** Etichette fiscali OCR (es. "Codice Fiecale", "Partite VA") — non sono nomi cliente/destinatario. */
export function isTaxOrFiscalLabelText(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^cod(?:ice)?\s*fisc/i.test(text)) return true;
  if (/\bpartit[eae]?\b/i.test(text) && /\b(?:iva|i\s*va|va|nnc|fisc)\b/i.test(text)) return true;
  if (
    /\b(?:cod(?:ice)?|partita|p\.?\s*iva|vat|tva|mwst|ust|nif|cif|c\.?\s*f\.?)\b/i.test(text) &&
    /\b(?:fisc(?:ale|ae|al[eé])?|fie?c(?:al)?e|fecale|fiscae|iva)\b/i.test(text)
  ) {
    return true;
  }
  if (/^(?:cod(?:ice)?|c\.?\s*f\.?)\s*(?:\/|e|-)?\s*(?:p\.?\s*iva|partita\s*iva|vat)?\s*:?\s*$/i.test(text)) {
    return true;
  }
  if (/\b(?:cod(?:ice)?|c\.?\s*f\.?)\b/i.test(text) && /\bfie?c/i.test(text)) return true;
  if (/^(?:cod(?:ice)?|c\.?\s*f\.?|partita\s*iva|p\.?\s*iva)\b/i.test(text)) return true;
  return false;
}

function isPlausibleRecipientName(value: string): boolean {
  const stripped = stripCustomerPrefix(value).trim();
  if (
    !stripped ||
    isCustomerReferenceLabelLine(stripped) ||
    /\briferimento\b/i.test(stripped) ||
    isCustomerLabelOnly(stripped) ||
    isTaxOrFiscalLabelText(stripped) ||
    isDocumentTypeHeaderText(stripped)
  ) {
    return false;
  }
  const parts = stripped.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    if (parts[0].length < 4 || isSalutationFragment(parts[0])) return false;
    if (/^(?:via|tipo|telaio|pagina|codice|articolo|importo|totale|preventivo|ordine)$/i.test(parts[0])) {
      return false;
    }
    return false;
  }
  if (parts.some((p) => isSalutationFragment(p) || isCustomerLabelOnly(p) || isTaxOrFiscalLabelText(p))) {
    return false;
  }
  if (parts.some((p) => /\d/.test(p))) return false;
  return parts.every((p) => /^[A-Za-zÀ-ü'.-]{2,}$/.test(p));
}

function extractAssociationName(line: string): string | null {
  const match = line.match(/^associazione\s+(.*)$/i);
  if (!match) return null;
  const name = match[1].replace(/^["']+|["']+$/g, '').trim();
  if (!isPlausibleRecipientName(name)) return null;
  return cleanName(formatRecipientName(name));
}

function extractNameFromLine(line: string): string | null {
  const association = extractAssociationName(line);
  if (association) return association;

  const normalized = stripCustomerPrefix(line);
  if (!normalized || !isPlausibleRecipientName(normalized)) return null;

  const titleCase = normalized.match(PERSON_NAME);
  if (titleCase) return cleanName(titleCase[1]);

  const allCaps = normalized.match(PERSON_NAME_ALLCAPS);
  if (allCaps && isPlausibleRecipientName(allCaps[1])) {
    return cleanName(formatRecipientName(allCaps[1]));
  }

  if (isPlausibleRecipientName(normalized)) {
    return cleanName(formatRecipientName(normalized));
  }

  return null;
}

function findRecipientNearAnchor(lines: string[], anchorIndex: number): string {
  for (let offset = 1; offset <= 12; offset++) {
    const idx = anchorIndex + offset;
    if (idx >= lines.length) break;
    const line = lines[idx];
    if (isSkippedRecipientContextLine(line)) continue;
    const fromLine = extractNameFromLine(line);
    if (fromLine) return fromLine;
  }
  return '';
}

function normalizeSpettLeCandidate(value: string): string {
  return value.trim().replace(/[.:,\s]+$/g, '');
}

function findSpettLeGlobally(lines: string[]): string {
  for (let i = 0; i < lines.length; i++) {
    const sameLine = lines[i].match(/^\s*spett\.?\s*le\s+(.+)$/i);
    if (sameLine) {
      const candidate = normalizeSpettLeCandidate(sameLine[1]);
      if (isPlausibleRecipientName(candidate)) {
        return cleanName(formatRecipientName(candidate));
      }
    }
    if (/^\s*spett\.?\s*le\s*\.?\s*$/i.test(lines[i])) {
      for (let offset = 1; offset <= 4 && i + offset < lines.length; offset += 1) {
        const next = lines[i + offset];
        if (isSkippedRecipientContextLine(next)) continue;
        const candidate = normalizeSpettLeCandidate(next);
        if (isPlausibleRecipientName(candidate)) {
          return cleanName(formatRecipientName(candidate));
        }
      }
    }
  }
  return '';
}

function findAssociationRecipient(lines: string[]): string {
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:spett(?:\.|abile|able)?|spettable)\b/i.test(lines[i])) {
      continue;
    }
    for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
      if (isSkippedRecipientContextLine(lines[j])) continue;
      const fromLine = extractNameFromLine(lines[j]);
      if (fromLine) return fromLine;
    }
  }
  return '';
}

function findRecipientInRawText(rawText: string): string {
  const patterns = [
    /spett\.?\s*le\s+([A-ZÀ-Üa-zà-ü'.-]{2,}(?:\s+[A-ZÀ-Üa-zà-ü'.-]{2,})+)/i,
    /destinatario\s*[:\-]?\s*(?:\n|\s)+(?:spett\.?\s*le\s*)?([A-ZÀ-Üa-zà-ü'.-]{2,}(?:\s+[A-ZÀ-Üa-zà-ü'.-]{2,})+)/i,
    /(?:fatturare|inviare\s*a|cliente)\s*[:\-]?\s*([A-ZÀ-Üa-zà-ü'.-]{2,}(?:\s+[A-ZÀ-Üa-zà-ü'.-]{2,})+)/i,
    /associazione\s+["']?([A-ZÀ-Üa-zà-ü'.-][A-ZÀ-Üa-zà-ü'.-\s]{2,80})["']?/i,
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && isPlausibleRecipientName(candidate)) {
      return cleanName(formatRecipientName(candidate));
    }
  }

  return '';
}

function findAllAssociationRecipients(lines: string[]): string {
  const names: string[] = [];
  for (const line of lines) {
    const name = extractAssociationName(line);
    if (name) names.push(name);
  }
  if (names.length === 0) return '';
  return names[names.length - 1];
}

function findSpettabileRecipient(lines: string[]): string {
  for (let i = 0; i < lines.length; i++) {
    if (!/^spett\.?(?:abile|ale|le)\b/i.test(lines[i])) continue;
    const candidates: string[] = [];
    for (let j = i + 1; j <= Math.min(i + 8, lines.length - 1); j++) {
      if (isSkippedRecipientContextLine(lines[j])) continue;
      if (/^firmato\b/i.test(lines[j])) break;
      if (/^via\b/i.test(lines[j])) break;
      const fromLine = extractNameFromLine(lines[j]);
      if (fromLine) candidates.push(fromLine);
    }
    if (candidates.length === 0) continue;
    const org = candidates.find((candidate) =>
      /\b(?:ASP|SRL|SPA|SNC|SAS|GMBH|AG|ASSOCIAZIONE|COOP|ONLUS|FONDAZIONE)\b/i.test(candidate)
    );
    if (org) return org;
    return candidates[candidates.length - 1];
  }
  return '';
}

function isEnglishPartyLabelNoise(line: string): boolean {
  const trimmed = line.trim();
  if (/invoice number amount due/i.test(trimmed)) return true;
  return /^(?:date issued|due date|invoice number|amount due|payment terms|description|rate|qty|amount)$/i.test(
    trimmed
  );
}

function findBillToCustomer(lines: string[]): string {
  const fromIndex = lines.findIndex((line) => /^from$/i.test(line.trim()));
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      !/^bill(?:ed)?\s*to$/i.test(trimmed) &&
      !/^customer$/i.test(trimmed) &&
      !/^client$/i.test(trimmed)
    ) {
      continue;
    }
    const stackedFromBillTo = fromIndex >= 0 && i === fromIndex + 1;
    const names: string[] = [];
    for (let j = i + 1; j <= Math.min(i + 12, lines.length - 1); j++) {
      const line = lines[j];
      if (
        /^(from|bill(?:ed)?\s*to|description|payment|notes|terms)$/i.test(line.trim())
      ) {
        break;
      }
      if (isEnglishPartyLabelNoise(line)) continue;
      if (isSkippedRecipientContextLine(line)) continue;
      const fromLine = extractNameFromLine(line);
      if (fromLine) names.push(cleanName(formatRecipientName(fromLine)));
    }
    if (stackedFromBillTo && names.length >= 2) return names[1];
    if (names.length >= 1) return names[0];
  }
  return '';
}

export function findCustomerName(rawText: string, lines: string[]): string {
  const resolved = findCustomerNameRaw(rawText, lines).trim();
  if (!resolved) return '';
  if (isDocumentTypeHeaderText(resolved)) return '';
  if (isImplausibleOrganizationName(resolved)) return '';
  if (/^(?:order confirmation|quote|invoice|quotation|purchase order)$/i.test(resolved)) return '';
  return resolved;
}

function findCustomerNameRaw(rawText: string, lines: string[]): string {
  const spettLeGlobal = findSpettLeGlobally(lines);
  if (spettLeGlobal) return spettLeGlobal;

  const associationDirect = findAllAssociationRecipients(lines);
  if (associationDirect) return associationDirect;

  const spettabileBlock = findSpettabileRecipient(lines);
  if (spettabileBlock) return spettabileBlock;

  const association = findAssociationRecipient(lines);
  if (association) return association;

  const billToCustomer = findBillToCustomer(lines);
  if (billToCustomer) return billToCustomer;

  for (let i = 0; i < lines.length; i++) {
    if (!RECIPIENT_ANCHOR.test(lines[i])) continue;
    const inline = extractNameFromLine(lines[i].replace(RECIPIENT_ANCHOR, ' ').trim());
    if (inline) return inline;
    const near = findRecipientNearAnchor(lines, i);
    if (near) return near;
  }

  const fromRaw = findRecipientInRawText(rawText);
  if (fromRaw) return fromRaw;

  for (let i = 0; i < lines.length; i++) {
    if (!CUSTOMER_LABEL.test(lines[i]) || RECIPIENT_ANCHOR.test(lines[i])) continue;
    const inline = extractNameFromLine(lines[i].replace(CUSTOMER_LABEL, ' ').trim());
    if (inline) return inline;
    const near = findRecipientNearAnchor(lines, i);
    if (near) return near;
  }

  return '';
}

export function findLabeledDocumentDate(
  rawText: string,
  lines: string[],
  labelPatterns: RegExp[],
  excludePatterns: RegExp[] = []
): string | undefined {
  for (const label of labelPatterns) {
    const inline = rawText.match(
      new RegExp(`${label.source}[^\\n]{0,48}?(${DATE_IN_LINE.source})`, 'i')
    );
    if (inline?.[1] && !excludePatterns.some((p) => p.test(inline[0]))) {
      return inline[1];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const isLabel = labelPatterns.some((p) => p.test(lines[i]));
    if (!isLabel) continue;
    if (excludePatterns.some((p) => p.test(lines[i]))) continue;

    const inlineDate = lines[i].match(
      new RegExp(`${DATE_IN_LINE.source}`, 'i')
    );
    if (inlineDate?.[1]) return inlineDate[1];

    for (const offset of [-1, -2, 1, 2, -3, 3]) {
      const idx = i + offset;
      if (idx < 0 || idx >= lines.length) continue;
      const neighbor = lines[idx];
      if (excludePatterns.some((p) => p.test(neighbor))) continue;
      if (/valido\s+fino/i.test(neighbor)) continue;
      const match = neighbor.match(DATE_IN_LINE);
      if (match?.[1]) return match[1];
    }
  }

  return undefined;
}

function cleanName(value: string): string {
  const stripped = stripCustomerPrefix(value);
  if (!stripped || !isPlausibleRecipientName(stripped)) return '';
  return stripped
    .replace(/\s+via\b.*/i, '')
    .replace(/\s+\d{5}\b.*/i, '')
    .replace(/[,\-–—:]\s*$/, '')
    .trim();
}
