import { countDocumentProcessPerf, documentProcessPerfStageEnd, documentProcessPerfStageStart } from './document-process-perf';

export type DocumentLanguage = 'it' | 'en' | 'fr' | 'de' | 'es';
export type CanonicalCommercialDocumentType = 'quotation' | 'order' | 'invoice' | 'credit_note' | 'free_document';

export type DocumentLabelConcept =
  | 'documentTypeQuotation' | 'documentTypeOrder' | 'documentTypeInvoice' | 'documentTypeCreditNote'
  | 'issuer' | 'customer' | 'recipient'
  | 'documentNumber' | 'issueDate' | 'dueDate' | 'validityDate'
  | 'itemCode' | 'description' | 'quantity' | 'unit' | 'unitPrice' | 'discount' | 'vatRate' | 'lineTotal'
  | 'subtotal' | 'taxableAmount' | 'vatAmount' | 'total'
  | 'paymentTerms' | 'deliveryDate' | 'deliveryTerms'
  | 'iban' | 'bic' | 'bankName';

export interface DocumentLabelDefinition {
  value: string;
  language: DocumentLanguage;
  priority: number;
  expectedValue: 'text' | 'identifier' | 'date' | 'amount' | 'percentage' | 'none';
  context: 'document' | 'party' | 'table' | 'summary' | 'conditions' | 'bank';
}

const definitions = (
  language: DocumentLanguage,
  context: DocumentLabelDefinition['context'],
  expectedValue: DocumentLabelDefinition['expectedValue'],
  values: readonly string[],
): DocumentLabelDefinition[] => values.map((value, index) => ({
  value,
  language,
  priority: Math.max(1, 100 - index),
  expectedValue,
  context,
}));

export const DOCUMENT_LABEL_DICTIONARY: Readonly<Record<DocumentLabelConcept, readonly DocumentLabelDefinition[]>> = {
  documentTypeQuotation: [
    ...definitions('it', 'document', 'none', ['preventivo', 'offerta', 'quotazione']),
    ...definitions('en', 'document', 'none', ['quotation', 'quote', 'estimate', 'proposal']),
    ...definitions('fr', 'document', 'none', ['devis', 'offre de prix']),
    ...definitions('de', 'document', 'none', ['angebot', 'kostenvoranschlag']),
    ...definitions('es', 'document', 'none', ['presupuesto', 'cotización']),
  ],
  documentTypeOrder: [
    ...definitions('it', 'document', 'none', ['ordine', 'conferma ordine', 'ordine cliente']),
    ...definitions('en', 'document', 'none', ['purchase order', 'sales order', 'order confirmation', 'customer order', 'order']),
    ...definitions('fr', 'document', 'none', ['confirmation de commande', 'commande']),
    ...definitions('de', 'document', 'none', ['auftragsbestätigung', 'bestellung']),
    ...definitions('es', 'document', 'none', ['confirmación de pedido', 'pedido']),
  ],
  documentTypeInvoice: [
    ...definitions('it', 'document', 'none', ['fattura']),
    ...definitions('en', 'document', 'none', ['commercial invoice', 'tax invoice', 'invoice']),
    ...definitions('fr', 'document', 'none', ['facture']),
    ...definitions('de', 'document', 'none', ['rechnung', 'faktura']),
    ...definitions('es', 'document', 'none', ['factura']),
  ],
  documentTypeCreditNote: [
    ...definitions('it', 'document', 'none', ['nota di credito']),
    ...definitions('en', 'document', 'none', ['credit note']),
    ...definitions('fr', 'document', 'none', ['avoir']),
    ...definitions('de', 'document', 'none', ['gutschrift']),
    ...definitions('es', 'document', 'none', ['nota de crédito']),
  ],
  issuer: [
    ...definitions('it', 'party', 'text', ['emittente', 'fornitore', 'venditore']),
    ...definitions('en', 'party', 'text', ['supplier', 'vendor', 'seller', 'issued by', 'from']),
    ...definitions('fr', 'party', 'text', ['fournisseur', 'vendeur']),
    ...definitions('de', 'party', 'text', ['lieferant', 'verkäufer']),
    ...definitions('es', 'party', 'text', ['proveedor', 'vendedor']),
  ],
  customer: [
    ...definitions('it', 'party', 'text', ['cliente', 'committente', 'spett.le', 'spettabile', 'addetto vendite']),
    ...definitions('en', 'party', 'text', ['customer', 'client', 'bill to', 'bill-to', 'billed to', 'sold to', 'buyer', 'sales representative']),
    ...definitions('fr', 'party', 'text', ['facturé à', 'client', 'représentant commercial']),
    ...definitions('de', 'party', 'text', ['rechnung an', 'kunde', 'vertreter']),
    ...definitions('es', 'party', 'text', ['facturar a', 'comprador', 'cliente', 'datos del cliente']),
  ],
  recipient: [
    ...definitions('it', 'party', 'text', ['destinatario', 'destinatario merce', 'consegna a']),
    ...definitions('en', 'party', 'text', ['delivery address', 'ship to', 'ship-to', 'consignee', 'deliver to']),
    ...definitions('fr', 'party', 'text', ['adresse de livraison', 'destinataire']),
    ...definitions('de', 'party', 'text', ['lieferadresse', 'warenempfänger']),
    ...definitions('es', 'party', 'text', ['dirección de entrega', 'destinatario']),
  ],
  documentNumber: [
    ...definitions('it', 'document', 'identifier', ['numero documento', 'n. documento', 'preventivo n.', 'ordine n.', 'fattura n.']),
    ...definitions('en', 'document', 'identifier', ['document number', 'document no.', 'quotation no.', 'quote no.', 'order confirmation no.', 'order no.', 'invoice no.']),
    ...definitions('fr', 'document', 'identifier', ['numéro de devis', 'n° devis', 'n° commande', 'n° facture']),
    ...definitions('de', 'document', 'identifier', ['belegnummer', 'auftragsnummer', 'rechnungsnummer', 'angebotsnummer']),
    ...definitions('es', 'document', 'identifier', ['número de documento', 'nº presupuesto', 'nº pedido', 'nº factura']),
  ],
  issueDate: [
    ...definitions('it', 'document', 'date', ['data ordine', 'data fattura', 'data preventivo', 'data documento']),
    ...definitions('en', 'document', 'date', ['order date', 'invoice date', 'quote date', 'quotation date', 'document date', 'issue date']),
    ...definitions('fr', 'document', 'date', ['date devis', "date d'émission", 'date commande', 'date facture']),
    ...definitions('de', 'document', 'date', ['belegdatum', 'rechnungsdatum', 'auftragsdatum', 'angebotsdatum']),
    ...definitions('es', 'document', 'date', ['fecha presupuesto', 'fecha de emisión', 'fecha pedido', 'fecha factura', 'fecha']),
  ],
  dueDate: [
    ...definitions('it', 'document', 'date', ['scadenza']), ...definitions('en', 'document', 'date', ['payment due', 'due date']),
    ...definitions('fr', 'document', 'date', ['échéance']), ...definitions('de', 'document', 'date', ['zahlungsziel', 'fällig am']),
    ...definitions('es', 'document', 'date', ['vencimiento']),
  ],
  validityDate: [
    ...definitions('it', 'document', 'date', ['validità offerta', 'valido fino a']), ...definitions('en', 'document', 'date', ['quotation valid until', 'valid until']),
    ...definitions('fr', 'document', 'date', ["valable jusqu'au"]), ...definitions('de', 'document', 'date', ['gültig bis']),
    ...definitions('es', 'document', 'date', ['válido hasta']),
  ],
  itemCode: [
    ...definitions('it', 'table', 'identifier', ['codice', 'cod.', 'articolo']), ...definitions('en', 'table', 'identifier', ['item code', 'product code', 'sku', 'reference']),
    ...definitions('fr', 'table', 'identifier', ['code article', 'référence']), ...definitions('de', 'table', 'identifier', ['artikelnummer', 'art.-nr.']),
    ...definitions('es', 'table', 'identifier', ['código', 'referencia']),
  ],
  description: [
    ...definitions('it', 'table', 'text', ['descrizione', 'articolo', 'prodotto']), ...definitions('en', 'table', 'text', ['item description', 'description', 'article', 'product']),
    ...definitions('fr', 'table', 'text', ['désignation', 'designation', 'article']), ...definitions('de', 'table', 'text', ['beschreibung', 'bezeichnung', 'artikel', 'produkt']),
    ...definitions('es', 'table', 'text', ['descripción', 'concepto', 'artículo']),
  ],
  quantity: [
    ...definitions('it', 'table', 'amount', ['quantità', 'q.tà', 'qta']), ...definitions('en', 'table', 'amount', ['quantity', 'qty']),
    ...definitions('fr', 'table', 'amount', ['quantité', 'qté', 'qte']), ...definitions('de', 'table', 'amount', ['menge', 'anzahl']),
    ...definitions('es', 'table', 'amount', ['cantidad', 'cant.']),
  ],
  unit: [
    ...definitions('it', 'table', 'text', ['udm', 'um']), ...definitions('en', 'table', 'text', ['uom', 'unit']),
    ...definitions('fr', 'table', 'text', ['unité']), ...definitions('de', 'table', 'text', ['einheit']), ...definitions('es', 'table', 'text', ['unidad']),
  ],
  unitPrice: [
    ...definitions('it', 'table', 'amount', ['prezzo unitario', 'prezzo', 'prezzo unit.', 'pu ht', 'p.u.']),
    ...definitions('en', 'table', 'amount', ['unit price', 'price']),
    ...definitions('fr', 'table', 'amount', ['prix unitaire', 'pu ht', 'prix unitaire ht', 'p.u.']),
    ...definitions('de', 'table', 'amount', ['einzelpreis', 'stückpreis', 'preis']),
    ...definitions('es', 'table', 'amount', ['precio unitario', 'precio unit.', 'p. unitario']),
  ],
  discount: [
    ...definitions('it', 'table', 'percentage', ['sconto', 'sc.']), ...definitions('en', 'table', 'percentage', ['discount', 'disc.']),
    ...definitions('fr', 'table', 'percentage', ['remise', 'rem.']), ...definitions('de', 'table', 'percentage', ['rabatt']), ...definitions('es', 'table', 'percentage', ['descuento', 'desc.', 'dto.']),
  ],
  vatRate: [
    ...definitions('it', 'table', 'percentage', ['aliquota iva', 'iva', 'iva %']), ...definitions('en', 'table', 'percentage', ['vat rate', 'vat', 'vat %', 'tax']),
    ...definitions('fr', 'table', 'percentage', ['taux de tva', 'tva', 'tva %']), ...definitions('de', 'table', 'percentage', ['mehrwertsteuer', 'mwst.', 'mwst %', 'ust.']),
    ...definitions('es', 'table', 'percentage', ['tipo iva', 'impuesto', 'iva', 'iva %', 'va %']),
  ],
  lineTotal: [
    ...definitions('it', 'table', 'amount', ['totale riga', 'importo', 'totale']),
    ...definitions('en', 'table', 'amount', ['line total', 'net amount', 'amount']),
    ...definitions('fr', 'table', 'amount', ['total ligne', 'montant ht', 'montant', 'montant net']),
    ...definitions('de', 'table', 'amount', ['gesamt', 'betrag', 'nettobetrag']),
    ...definitions('es', 'table', 'amount', ['total línea', 'importe', 'importe neto']),
  ],
  subtotal: [
    ...definitions('it', 'summary', 'amount', ['subtotale']), ...definitions('en', 'summary', 'amount', ['subtotal']),
    ...definitions('fr', 'summary', 'amount', ['sous-total']), ...definitions('de', 'summary', 'amount', ['zwischensumme']), ...definitions('es', 'summary', 'amount', ['subtotal']),
  ],
  taxableAmount: [
    ...definitions('it', 'summary', 'amount', ['totale imponibile', 'imponibile']), ...definitions('en', 'summary', 'amount', ['taxable amount', 'net amount']),
    ...definitions('fr', 'summary', 'amount', ['montant hors taxes', 'total ht']), ...definitions('de', 'summary', 'amount', ['nettobetrag']),
    ...definitions('es', 'summary', 'amount', ['base imponible', 'neto imponible']),
  ],
  vatAmount: [
    ...definitions('it', 'summary', 'amount', ['importo iva', 'totale iva', 'totale imposta']),
    ...definitions('en', 'summary', 'amount', ['vat amount', 'tax amount', 'total vat']),
    ...definitions('fr', 'summary', 'amount', ['montant tva', 'total tva']),
    ...definitions('de', 'summary', 'amount', ['mwst.-betrag', 'ust.-betrag']),
    ...definitions('es', 'summary', 'amount', ['importe iva']),
  ],
  total: [
    ...definitions('it', 'summary', 'amount', ['totale documento', 'totale complessivo', 'totale']),
    ...definitions('en', 'summary', 'amount', ['grand total', 'total due', 'amount due', 'total']),
    ...definitions('fr', 'summary', 'amount', ['total général', 'total ttc', 'total']),
    ...definitions('de', 'summary', 'amount', ['gesamtbetrag', 'rechnungsbetrag', 'gesamt']),
    ...definitions('es', 'summary', 'amount', ['importe total', 'total presupuesto', 'total']),
  ],
  paymentTerms: [
    ...definitions('it', 'conditions', 'text', ['condizioni di pagamento', 'pagamento']), ...definitions('en', 'conditions', 'text', ['terms of payment', 'payment terms', 'payment']),
    ...definitions('fr', 'conditions', 'text', ['conditions de paiement']), ...definitions('de', 'conditions', 'text', ['zahlungsbedingungen']),
    ...definitions('es', 'conditions', 'text', ['condiciones de pago', 'forma de pago']),
  ],
  deliveryDate: [
    ...definitions('it', 'conditions', 'date', ['data consegna']), ...definitions('en', 'conditions', 'date', ['expected delivery', 'delivery date']),
    ...definitions('fr', 'conditions', 'date', ['date de livraison']), ...definitions('de', 'conditions', 'date', ['lieferdatum']),
    ...definitions('es', 'conditions', 'date', ['fecha de entrega']),
  ],
  deliveryTerms: [
    ...definitions('it', 'conditions', 'text', ['condizioni di consegna', 'consegna', 'resa', 'porto']), ...definitions('en', 'conditions', 'text', ['delivery terms', 'shipping terms', 'incoterms']),
    ...definitions('fr', 'conditions', 'text', ['conditions de livraison']), ...definitions('de', 'conditions', 'text', ['lieferbedingungen']),
    ...definitions('es', 'conditions', 'text', ['condiciones de entrega']),
  ],
  iban: definitions('it', 'bank', 'identifier', ['iban']),
  bic: definitions('en', 'bank', 'identifier', ['bic/swift', 'swift', 'bic']),
  bankName: [
    ...definitions('it', 'bank', 'text', ['banca']), ...definitions('en', 'bank', 'text', ['bank']),
    ...definitions('fr', 'bank', 'text', ['banque']), ...definitions('de', 'bank', 'text', ['bankverbindung']), ...definitions('es', 'bank', 'text', ['banco']),
  ],
};

const NORMALIZED_LABEL_CACHE = new Map<string, string>();
const FIND_LABEL_CACHE = new Map<string, DocumentLabelDefinition | undefined>();

export function normalizeDocumentLabel(value: string): string {
  const cached = NORMALIZED_LABEL_CACHE.get(value);
  if (cached !== undefined) return cached;
  const normalized = value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`´]/g, "'")
    .toLocaleLowerCase('en-US')
    .replace(/\bno\s*[º°]\b/g, 'no')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  NORMALIZED_LABEL_CACHE.set(value, normalized);
  return normalized;
}

const NORMALIZED_DICTIONARY: Record<DocumentLabelConcept, Array<{
  entry: DocumentLabelDefinition;
  normalized: string;
}>> = Object.fromEntries(
  (Object.entries(DOCUMENT_LABEL_DICTIONARY) as Array<[DocumentLabelConcept, readonly DocumentLabelDefinition[]]>)
    .map(([concept, entries]) => [
      concept,
      entries.map((entry) => ({ entry, normalized: normalizeDocumentLabel(entry.value) })),
    ]),
) as Record<DocumentLabelConcept, Array<{ entry: DocumentLabelDefinition; normalized: string }>>;

function labelBoundaryMatch(text: string, label: string): boolean {
  return text === label || text.startsWith(`${label} `) || text.endsWith(` ${label}`) || text.includes(` ${label} `);
}

type NormalizedLabelEntry = {
  entry: DocumentLabelDefinition;
  normalized: string;
};

const ALL_NORMALIZED_LABELS: NormalizedLabelEntry[] = Object.values(NORMALIZED_DICTIONARY).flat();

/** First-token index so language detection is O(tokens), not O(dictionary × lines). */
const LABELS_BY_FIRST_TOKEN = new Map<string, NormalizedLabelEntry[]>();
for (const item of ALL_NORMALIZED_LABELS) {
  const firstToken = item.normalized.split(' ')[0];
  if (!firstToken) continue;
  const bucket = LABELS_BY_FIRST_TOKEN.get(firstToken);
  if (bucket) bucket.push(item);
  else LABELS_BY_FIRST_TOKEN.set(firstToken, [item]);
}

export function findDocumentLabel(value: string, concepts: readonly DocumentLabelConcept[]): DocumentLabelDefinition | undefined {
  countDocumentProcessPerf('findDocumentLabel');
  const cacheKey = `${value}\0${concepts.join(',')}`;
  if (FIND_LABEL_CACHE.has(cacheKey)) return FIND_LABEL_CACHE.get(cacheKey);
  const text = normalizeDocumentLabel(value);
  const match = concepts.flatMap((concept) => NORMALIZED_DICTIONARY[concept])
    .filter((entry) => labelBoundaryMatch(text, entry.normalized))
    .sort((left, right) => right.entry.priority - left.entry.priority || right.entry.value.length - left.entry.value.length)[0]?.entry;
  FIND_LABEL_CACHE.set(cacheKey, match);
  return match;
}

export function matchesDocumentLabel(value: string, concept: DocumentLabelConcept): boolean {
  return !!findDocumentLabel(value, [concept]);
}

export function inferCanonicalDocumentType(value: string): { type: CanonicalCommercialDocumentType; label: DocumentLabelDefinition } | undefined {
  const concepts: Array<[DocumentLabelConcept, CanonicalCommercialDocumentType]> = [
    ['documentTypeCreditNote', 'credit_note'], ['documentTypeInvoice', 'invoice'],
    ['documentTypeOrder', 'order'], ['documentTypeQuotation', 'quotation'],
  ];
  for (const [concept, type] of concepts) {
    const label = findDocumentLabel(value, [concept]);
    if (label) return { type, label };
  }
  return undefined;
}

export interface DocumentLanguageDetection {
  detectedLanguages: DocumentLanguage[];
  primaryLanguage?: DocumentLanguage;
  confidence: number;
  mixedLanguage: boolean;
  scores: Partial<Record<DocumentLanguage, number>>;
  timeoutReason?: 'structured_language_timeout';
}

const STRUCTURED_LANGUAGE_HARD_MS = 500;
const STRUCTURED_LANGUAGE_MAX_LINES = 80;
const STRUCTURED_LANGUAGE_MAX_CHECKS = 8_000;
const STRUCTURED_LANGUAGE_CONFIDENT_SCORE = 6;

function languageClockMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/** Header then footer first — inverted OCR often puts labels after dense item rows. */
function languageScanOrder(lines: readonly string[]): string[] {
  const limited = lines.slice(0, STRUCTURED_LANGUAGE_MAX_LINES);
  if (limited.length <= 24) return [...limited];
  const head = limited.slice(0, 24);
  const tail = limited.slice(Math.max(24, limited.length - 16));
  const middle = limited.slice(24, Math.max(24, limited.length - 16));
  return [...head, ...tail, ...middle];
}

function logStructuredLanguage(
  event: string,
  detail?: Record<string, unknown>,
): void {
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[StructuredLanguage] ${event}${suffix}`);
}

function emptyLanguageDetection(
  timeoutReason?: 'structured_language_timeout',
): DocumentLanguageDetection {
  return {
    detectedLanguages: [],
    confidence: 0,
    mixedLanguage: false,
    scores: {},
    ...(timeoutReason ? { timeoutReason } : {}),
  };
}

export function detectDocumentLanguages(
  lines: readonly string[],
  options?: { deadline?: number },
): DocumentLanguageDetection {
  const started = languageClockMs();
  const wallStarted = Date.now();
  const hardDeadline = options?.deadline ?? wallStarted + STRUCTURED_LANGUAGE_HARD_MS;
  const pastBy = options?.deadline === undefined ? undefined : wallStarted - options.deadline;
  const intentionalExpire = pastBy !== undefined && pastBy >= 0 && pastBy < 50;
  const reallyExpired = pastBy !== undefined && pastBy >= 2_000;
  documentProcessPerfStageStart('language_detection', {
    inputLineCount: lines.length,
    deadlineRemainingMs: Math.max(0, hardDeadline - wallStarted),
  });
  logStructuredLanguage('start', { input_lines: lines.length });
  const scores: Partial<Record<DocumentLanguage, number>> = {};
  let checks = 0;
  let aborted = intentionalExpire || reallyExpired;
  const ordered = languageScanOrder(lines);
  for (let lineIndex = 0; !aborted && lineIndex < ordered.length; lineIndex += 1) {
    const elapsed = languageClockMs() - started;
    if (checks >= STRUCTURED_LANGUAGE_MAX_CHECKS || elapsed >= STRUCTURED_LANGUAGE_HARD_MS) {
      aborted = true;
      break;
    }
    const normalized = normalizeDocumentLabel(ordered[lineIndex]);
    if (!/[a-z\u00c0-\u024f]{3}/i.test(normalized)) continue;
    const tokens = normalized.split(' ');
    const matchedLabels = new Set<string>();
    for (const token of tokens) {
      const candidates = LABELS_BY_FIRST_TOKEN.get(token);
      if (!candidates) continue;
      for (const item of candidates) {
        checks += 1;
        if (checks >= STRUCTURED_LANGUAGE_MAX_CHECKS) {
          aborted = true;
          break;
        }
        if (matchedLabels.has(item.normalized)) continue;
        if (!labelBoundaryMatch(normalized, item.normalized)) continue;
        matchedLabels.add(item.normalized);
        const label = item.normalized;
        const specificityWeight = label.split(' ').length > 1 || label.length >= 12
          ? Math.max(2, Math.min(4, label.split(' ').length))
          : 1;
        scores[item.entry.language] = (scores[item.entry.language] ?? 0) + specificityWeight;
      }
      if (aborted) break;
    }
    if (aborted) break;
    const leading = Math.max(0, ...Object.values(scores));
    if (leading >= STRUCTURED_LANGUAGE_CONFIDENT_SCORE) break;
  }
  const ranked = (Object.entries(scores) as Array<[DocumentLanguage, number]>).sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0 && aborted) {
    logStructuredLanguage('done', {
      ms: languageClockMs() - started,
      partial: true,
      reason: 'structured_language_timeout',
    });
    documentProcessPerfStageEnd('language_detection', {
      inputLineCount: lines.length,
      outputCandidateCount: 0,
      deadlineRemainingMs: Math.max(0, hardDeadline - Date.now()),
    });
    return emptyLanguageDetection('structured_language_timeout');
  }
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const primaryLanguage = ranked[0]?.[0];
  const detectedLanguages = ranked.filter(([, score]) => score >= 1 || score === ranked[0]?.[1]).map(([language]) => language);
  logStructuredLanguage('done', { ms: languageClockMs() - started, ...(aborted ? { partial: true } : {}) });
  documentProcessPerfStageEnd('language_detection', {
    inputLineCount: lines.length,
    outputCandidateCount: detectedLanguages.length,
    deadlineRemainingMs: Math.max(0, hardDeadline - Date.now()),
  });
  return {
    detectedLanguages,
    ...(primaryLanguage ? { primaryLanguage } : {}),
    confidence: total > 0 ? Math.min(1, (ranked[0]?.[1] ?? 0) / Math.max(4, total)) : 0,
    mixedLanguage: detectedLanguages.length > 1 && (ranked[1]?.[1] ?? 0) >= Math.max(2, (ranked[0]?.[1] ?? 0) * 0.35),
    scores,
  };
}

export function resetDocumentLabelCaches(): void {
  NORMALIZED_LABEL_CACHE.clear();
  FIND_LABEL_CACHE.clear();
}
