import type { AiField, AiParty, AiStructuredDocumentExtract } from './document-ai-contract';
import type { GeminiDocumentExtract } from './gemini-document-extract';

/**
 * Chi emette il documento e di cosa parla sono le due informazioni che il
 * servizio AI omette piu' spesso sui PDF. Le regole qui sotto le ricavano dal
 * testo solo quando l'evidenza e' chiara: in caso di dubbio si resta senza valore.
 * Vale unicamente per l'import PDF; fotocamera e biglietti non passano di qui.
 */

/** Forme societarie: distinguono una ragione sociale da un contatto o da un indirizzo. */
const LEGAL_ENTITY = /(?:^|[\s.,])(?:gmbh(?:\s*&\s*co\.?\s*kg)?|mbh|ag|kg|ohg|ug|e\.?k\.?|s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?c\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|s\.?s\.?|ltd\.?|limited|plc|inc\.?|llc|llp|corp\.?|corporation|company|sarl|sasu|sas|s\.?a\.?|b\.?v\.?|n\.?v\.?|ab|a\/s|oy|aps|sp\.\s*z\s*o\.?o\.?|d\.?o\.?o\.?|kft|s\.?l\.?u?\.?|coop(?:erativa)?)(?=$|[\s.,])/i;

/** Etichette e recapiti: non sono mai il nome di un'azienda. */
const CONTACT_LABEL = /^(?:e-?mail|mail|web|website|sito|tel\.?|telefono|phone|fax|mobile|cell\.?|contatto|contact|referente|your\s+contact|ansprechpartner|managing\s+director|amministratore|ceo|sales|vendite|reparto|department|abteilung)\b/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE = /^[+()\d][\d\s()./-]{6,}$/;
const WEBSITE = /^(?:https?:\/\/|www\.)\S+$/i;

/** Parole che nominano il tipo di documento: nell'oggetto sono rumore. */
const DOCUMENT_TYPE_WORD =
  /\b(?:preventivo|offerta|proposta|quotation|quote|proposal|estimate|invoice|fattura|rechnung|facture|factura|order|ordine|bestellung|auftrag|commande|pedido|angebot|devis|presupuesto|documento|document)\b/gi;
const DOCUMENT_NUMBER_TOKEN = /\b(?:n[.°rossup]{0,4}\s*)?[A-Z]{0,4}[-/]?\d[\dA-Z]*(?:[-/][\dA-Z]+)*\b/gi;
const SUBJECT_LABEL =
  /^(?:oggetto|soggetto|subject|object|objet|betreff|asunto|assunto|re)\s*[:\-]\s*(.+)$/i;

/**
 * Indirizzi e dati fiscali: se compaiono nella riga non è un titolo. I nomi di
 * strada tedeschi sono composti, quindi la ricerca accetta anche il suffisso.
 */
const ADDRESS_HINT =
  /\b(?:via|viale|piazza|p\.?zza|corso|strada|localit[aà]|rue|avenue|boulevard|calle|avenida|road|street|st\.|ave\.|suite|postfach|p\.?o\.?\s*box)\b|\S*(?:stra(?:ss|ß)e|weg|platz|allee|gasse)\b/i;
const FISCAL_HINT =
  /\b(?:vat|iva|ust|tva|mwst|nif|cif|iban|bic|swift|steuernummer|codice\s+fiscale|tax|p\.?\s*iva)\b/i;

/** Il letterhead sta in testa al documento: oltre si entra nel corpo. */
const LETTERHEAD_LINES = 12;
const MIN_SUBJECT_LENGTH = 10;
const MIN_SUBJECT_WORDS = 2;

export function looksLikeLegalEntityName(value: string): boolean {
  return LEGAL_ENTITY.test(value.trim());
}

/** Vero per recapiti, etichette e persone usati al posto della ragione sociale. */
export function isUnusableCompanyName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 2) return true;
  if (EMAIL.test(trimmed) || PHONE.test(trimmed) || WEBSITE.test(trimmed)) return true;
  if (CONTACT_LABEL.test(trimmed)) return true;
  if (/@/.test(trimmed)) return true;
  return false;
}

function textLines(rawText: string): string[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Da "Alltena GmbH - Schwalbenweg 16 - 71404 Korb" tiene solo la ragione sociale. */
function companySegment(line: string): string | undefined {
  const segments = line.split(/\s+[-–|·]\s+|,\s+/).map((part) => part.trim()).filter(Boolean);
  const candidates = segments.length > 0 ? segments : [line.trim()];
  return candidates.find((segment) => looksLikeLegalEntityName(segment) && !isUnusableCompanyName(segment));
}

export function deriveIssuerName(rawText: string, exclude?: string): string | undefined {
  const excluded = exclude?.trim().toLowerCase();
  for (const line of textLines(rawText).slice(0, LETTERHEAD_LINES)) {
    const candidate = companySegment(line);
    if (!candidate) continue;
    if (excluded && candidate.toLowerCase() === excluded) continue;
    return candidate;
  }
  return undefined;
}

function cleanedSubject(line: string, documentNumber?: string): string | undefined {
  let text = line;
  if (documentNumber) text = text.split(documentNumber).join(' ');
  text = text.replace(DOCUMENT_TYPE_WORD, ' ').replace(DOCUMENT_NUMBER_TOKEN, ' ');
  const normalized = text.replace(/\s{2,}/g, ' ').replace(/^[\s:\-–.]+|[\s:\-–.]+$/g, '');
  if (normalized.length < MIN_SUBJECT_LENGTH) return undefined;
  if (normalized.split(/\s+/).length < MIN_SUBJECT_WORDS) return undefined;
  if (!/[A-Za-z\u00c0-\u024f]{3}/.test(normalized)) return undefined;
  return normalized;
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((word) => word.length > 2);
}

/** Da un terzo di parole in comune in su, il candidato ripete un dato già noto. */
const MAX_PARTY_OVERLAP = 1 / 3;

function overlapsWith(candidate: string, other?: string): boolean {
  if (!other?.trim()) return false;
  const otherWords = new Set(words(other));
  if (otherWords.size === 0) return false;
  const candidateWords = words(candidate);
  if (candidateWords.length === 0) return false;
  const shared = candidateWords.filter((word) => otherWords.has(word)).length;
  return shared / candidateWords.length >= MAX_PARTY_OVERLAP;
}

export interface SubjectContext {
  documentNumber?: string;
  issuerName?: string;
  customerName?: string;
}

/**
 * Un oggetto sbagliato è peggio di un oggetto assente: il candidato passa solo
 * se non ripete le parti, i recapiti o un indirizzo, e se la riga di origine è
 * davvero il titolo del documento.
 */
function acceptableSubject(
  candidate: string,
  sourceLine: string,
  context: SubjectContext
): boolean {
  if (ADDRESS_HINT.test(sourceLine) || FISCAL_HINT.test(sourceLine)) return false;
  if (isUnusableCompanyName(sourceLine) || /@|https?:\/\/|www\./i.test(sourceLine)) return false;
  if (looksLikeLegalEntityName(candidate)) return false;
  if (overlapsWith(candidate, context.issuerName)) return false;
  if (overlapsWith(candidate, context.customerName)) return false;
  return true;
}

export function deriveSubject(
  rawText: string,
  context: SubjectContext = {}
): string | undefined {
  const lines = textLines(rawText);
  for (const line of lines.slice(0, LETTERHEAD_LINES)) {
    const labelled = line.match(SUBJECT_LABEL)?.[1]?.trim();
    if (!labelled || labelled.length < MIN_SUBJECT_LENGTH) continue;
    return acceptableSubject(labelled, labelled, context) ? labelled : undefined;
  }

  // Senza etichetta esplicita si accetta solo il titolo legato al tipo o al
  // numero del documento, nell'ordine di lettura: la riga più lunga non conta.
  for (const line of lines.slice(0, LETTERHEAD_LINES)) {
    const isTitleLine =
      (!!context.documentNumber && line.includes(context.documentNumber))
      || DOCUMENT_TYPE_WORD.test(line);
    DOCUMENT_TYPE_WORD.lastIndex = 0;
    if (!isTitleLine) continue;
    const candidate = cleanedSubject(line, context.documentNumber);
    if (candidate && acceptableSubject(candidate, line, context)) return candidate;
  }
  return undefined;
}

function heuristicField<T>(value: T, evidenceText: string): AiField<T> {
  return {
    value,
    pageIndex: 0,
    evidenceText,
    confidenceType: 'heuristic',
    requiresReview: true,
    alternatives: [],
  };
}

function emptyStructured(): AiStructuredDocumentExtract {
  return {
    schemaVersion: 2,
    document: {},
    items: [],
    summary: {},
    conditions: {},
    conflicts: [],
    requiresReview: false,
  };
}

function partyWithName(party: AiParty | undefined, name: AiField<string>): AiParty {
  return { ...(party ?? {}), name };
}

/**
 * Completa emittente, cliente e oggetto quando il servizio AI li lascia vuoti e
 * scarta i nomi societari che in realta' sono recapiti o etichette.
 */
export function hardenPdfExtract(extract: GeminiDocumentExtract): GeminiDocumentExtract {
  const rawText = extract.rawText ?? '';
  if (!rawText.trim()) return extract;

  const structured = extract.structured ?? emptyStructured();
  const customerFromFlat = extract.customerName?.trim();
  const customerField = structured.customer?.name;
  const customerName = customerField && !isUnusableCompanyName(customerField.value)
    ? customerField.value
    : customerFromFlat;

  const issuerField = structured.issuer?.name;
  const issuerUsable = issuerField && !isUnusableCompanyName(issuerField.value);
  const issuerIsLegalEntity = issuerUsable && looksLikeLegalEntityName(issuerField.value);
  const derivedIssuer = issuerIsLegalEntity ? undefined : deriveIssuerName(rawText, customerName);
  const issuerName = derivedIssuer ?? (issuerUsable ? issuerField.value : undefined);

  // L'oggetto riconosciuto dal servizio AI ha la precedenza: il completamento
  // locale interviene solo dove manca.
  const subjectField = structured.document.subject?.value?.trim()
    ? structured.document.subject
    : undefined;
  const subjectName = subjectField?.value
    ?? deriveSubject(rawText, {
      ...(extract.documentNumber ? { documentNumber: extract.documentNumber } : {}),
      ...(issuerName ? { issuerName } : {}),
      ...(customerName ? { customerName } : {}),
    });

  const nextIssuer = issuerName
    ? partyWithName(structured.issuer, heuristicField(issuerName, issuerName))
    : structured.issuer;
  const nextCustomer = customerName && (!customerField || customerField.value !== customerName)
    ? partyWithName(structured.customer, heuristicField(customerName, customerName))
    : structured.customer;

  const next: AiStructuredDocumentExtract = {
    ...structured,
    document: {
      ...structured.document,
      ...(subjectName ? { subject: subjectField ?? heuristicField(subjectName, subjectName) } : {}),
    },
    ...(nextIssuer ? { issuer: nextIssuer } : {}),
    ...(nextCustomer ? { customer: nextCustomer } : {}),
  };

  return { ...extract, structured: next };
}
