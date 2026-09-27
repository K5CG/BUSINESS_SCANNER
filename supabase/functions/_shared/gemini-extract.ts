import { edgeLogger } from './safe-logging.ts';
import type { SupportedGeminiModel } from './gemini-model-config.ts';
import {
  generateGeminiJson,
  type GeminiOperationOutcome,
  type GeminiPart,
  type GenerateGeminiJsonOptions,
  type GeminiTokenUsage,
} from './gemini-provider.ts';
import { UNTRUSTED_DATA_PREAMBLE } from './ai-credit-edge.ts';
import {
  MAX_DOCUMENT_ITEMS,
  MAX_DOCUMENT_RAW_TEXT_CHARS,
} from './edge-request-guard.ts';
import { aggregateGeminiTokenUsage } from './gemini-token-usage.ts';

export const STRUCTURED_DOCUMENT_SCHEMA_PROMPT = `
Oltre ai campi di compatibilità, aggiungi "structured" con schemaVersion 2, language e
le sezioni document, issuer, customer, recipient, prospect, vehicle, project,
delivery, shipping, bank, publicAdministrationData, items, summary, conditions,
conflicts e requiresReview.

Il documento può essere italiano, inglese, francese, tedesco, spagnolo o misto.
In language restituisci detectedLanguages, primaryLanguage, confidence,
mixedLanguage e la lingua per pagina. Usa documentType canonico: quotation,
order, invoice, credit_note o free_document. Non tradurre nomi, indirizzi,
descrizioni o evidence. Distingui identificativi VAT/TVA/MwSt/USt/IVA dagli
importi fiscali e restituisci null quando data, numero o associazione sono incerti.

Campi document: documentType, documentNumber, internalReference,
customerReference, issueDate, dueDate, validityDate, currency, subject,
references, cup, cig, pageCount.
Campi soggetto: name, legalForm, department, address, billingAddress, shippingAddress,
postalCode, city, region, country, vatNumber, taxCode, email, phone, website,
registrationNumber, iban, bic, bankName, contactPerson.
Campi veicolo: make, model, plate, vin, registrationDate, kilometers, engine.
Campi progetto: name, reference, office.
Campi consegna: date, terms, recipient, address.
Campi spedizione: terms, carrier, cost.
Campi banca: bankName, branch, iban, bic, ownerRole.
Campi PA: cup, cig, entityReference, office.
Campi riga: itemCode, description, quantity, unit, unitPrice, discount,
discountType (percentage oppure amount, ometti se non è esplicito),
taxableAmount, vatRate, vatNature, vatIncluded, lineTotal, currency, pageIndex,
evidenceText, requiresReview.
Campi riepilogo: materialTotal, laborTotal, externalWorkTotal, subtotal,
discountTotal, shippingCost, logisticsContribution, additionalCharges,
taxableAmount, vatAmount, taxSummaries, total, deposit, balance, currency.
Campi condizioni: paymentTerms, deliveryDate, deliveryTerms, shippingTerms,
bankDetails, iban, notes, signatures.

Ogni campo scalare deve essere un oggetto con value, pageIndex, evidenceText,
confidenceType (unknown oppure heuristic), requiresReview e alternatives.
Estrai solo valori visibili. Non inventare, non correggere matematicamente e
non usare zero per un valore assente. Se incerto restituisci null o ometti il
campo. Se valori o associazioni divergono, aggiungi un conflitto e richiedi
review. Distingui emittente da cliente, VIN da IBAN e identificativi fiscali
da importi. Associa quantità, prezzo, IVA e totale alla stessa riga usando il
layout visivo. Non salvare automaticamente alcun valore.`;

export const EXTRACT_PROMPT = `${UNTRUSTED_DATA_PREAMBLE}

Sei un OCR per documenti commerciali in qualsiasi lingua.
Analizza l'IMMAGINE del documento (non solo testo disordinato) e rispondi SOLO con JSON valido (nessun markdown):
{
  "rawText": "tutto il testo leggibile, righe separate da \\n, ordine di lettura naturale dall'alto verso il basso",
  "documentNumber": null,
  "customerName": null,
  "date": null,
  "subtotal": null,
  "vatAmount": null,
  "total": null,
  "items": [
    {
      "description": null,
      "quantity": null,
      "unitPrice": null,
      "total": null
    }
  ]
}
Regole:
- Il documento può essere italiano, inglese, francese, tedesco, spagnolo o misto; rileva la lingua per pagina.
- Mantieni nomi, indirizzi, descrizioni ed evidence nel testo originale, senza tradurli.
- Usa lo schema canonico e separa identificativi fiscali dagli importi VAT/TVA/MwSt/USt/IVA.
- Importi numerici nel JSON (punto decimale). Es. 1400.00 per 1.400,00 €.
- Per ogni campo assente usa null oppure ometti la proprietà. Non usare stringhe vuote, 0 o 1 come segnaposto.
- Zero è un valore valido solo quando è scritto esplicitamente nel documento.
- Non inventare quantità, prezzi, totali o righe articolo. Se gli articoli non sono presenti usa null oppure ometti items.
- customerName: priorità DESTINATARIO / SPETT. LE (nome e cognome, es. CHIOZZA TOMMASO). NON scrivere la parola Destinatario, Cliente o Le.
- date: campo Data documento / Data preventivo. NON usare Valido fino al.
- documentNumber: Numero documento (es. 812/Z, IT-001, PREVENTIVO n. …). NON confondere con R.E.A., P.IVA o date.
- total: importo finale Totale in euro (es. 1400.00, non 1.4).
- Se scritto a mano, indica incertezze nel rawText.
${STRUCTURED_DOCUMENT_SCHEMA_PROMPT}`;

export const PDF_EXPECTED_DOCUMENT_TYPES = [
  'quotation',
  'order',
  'invoice',
  'credit_note',
  'free_document',
] as const;

export type PdfExpectedDocumentType =
  (typeof PDF_EXPECTED_DOCUMENT_TYPES)[number];

const PDF_EXPECTED_TYPE_SET = new Set<string>(PDF_EXPECTED_DOCUMENT_TYPES);

/** Il tipo scelto dall'utente è un indizio, non un ordine: l'evidenza vince. */
export function pdfExpectedDocumentType(
  value: unknown
): PdfExpectedDocumentType | undefined {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (candidate === 'quote') return 'quotation';
  return PDF_EXPECTED_TYPE_SET.has(candidate)
    ? (candidate as PdfExpectedDocumentType)
    : undefined;
}

const PDF_TYPE_SEMANTICS: Record<PdfExpectedDocumentType, string> = {
  quotation: `Tipo atteso: PREVENTIVO / OFFERTA / PROPOSTA.
- issuer è chi formula l'offerta, customer è chi la riceve.
- subject è lo scopo dell'offerta, items sono i beni o servizi offerti,
  i totali sono gli importi proposti.`,
  order: `Tipo atteso: ORDINE.
- I ruoli dipendono dall'evidenza: individua con attenzione chi acquista e chi vende
  prima di assegnare issuer e customer.
- items sono i beni o servizi ordinati.`,
  invoice: `Tipo atteso: FATTURA.
- issuer è chi fattura e vende, customer è chi viene fatturato.
- items sono i beni o servizi fatturati, il riepilogo è quello fatturato.`,
  credit_note: `Tipo atteso: NOTA DI CREDITO.
- issuer è chi emette l'accredito, customer è chi lo riceve.
- Gli importi possono stornare un documento precedente: riportali come sono scritti.`,
  free_document: `Tipo atteso: DOCUMENTO COMMERCIALE GENERICO.
- Non forzare la semantica di preventivo, ordine o fattura.
- Estrai solo i campi commerciali realmente sostenuti dall'evidenza.`,
};

/**
 * Intestazione comune alle due passate PDF: il ruolo e la lingua del documento
 * non cambiano a seconda di quale parte del documento si sta leggendo.
 */
function pdfRoleIntro(expectedType?: PdfExpectedDocumentType): string {
  const expected = expectedType
    ? `\nL'utente ha avviato questo import come "${expectedType}".\n${PDF_TYPE_SEMANTICS[expectedType]}\nSe il documento dice chiaramente altro, segui l'evidenza, usa il documentType corretto e aggiungi un conflitto.\n`
    : '';

  return `${UNTRUSTED_DATA_PREAMBLE}

Sei un motore esperto di estrazione da documenti commerciali.
Analizza il PDF ORIGINALE usando sia il testo sia il layout: il compito non è
trascrivere, ma interpretare i ruoli commerciali e la struttura del documento e
restituire solo dati sostenuti da evidenza visibile.
Il documento può essere un preventivo/offerta/proposta, un ordine, una fattura,
una nota di credito o un documento commerciale generico, in italiano, inglese,
tedesco, francese, spagnolo o misto.
${expected}`;
}

const PDF_EVIDENCE_RULES = `REGOLA GENERALE DI EVIDENZA
- Estrai solo ciò che è visibile nel PDF: non inventare e non dedurre valori non supportati.
- Se un campo è davvero incerto restituisci null: un valore semanticamente sbagliato è peggio di un campo vuoto.
- Conserva la lingua originale, i nomi delle aziende e le descrizioni così come sono scritti, senza tradurli.
- Importi numerici con punto decimale (1400.00 per 1.400,00 €). Mai stringhe vuote, 0 o 1 come segnaposto.
- Zero è un valore valido solo quando è scritto esplicitamente nel documento.`;

const PDF_FISCAL_RULES = `IVA E IDENTIFICATIVI FISCALI
- Un identificativo fiscale non è mai un importo: VAT-ID, VAT Number, P.IVA, Partita IVA,
  USt-IdNr, TVA intracommunautaire, NIF, CIF, codice fiscale.
- "VAT-ID 01908170614" è un identificativo: non deve mai diventare vatAmount 1908170614.
- L'IVA monetaria si riconosce dal riepilogo imposte, da una percentuale (VAT %, IVA %, TVA, MwSt, USt)
  o da un importo con valuta.
- Con "Total net 3250 EUR / Reverse Charge 0% / 0.00 EUR / Total gross 3250 EUR" interpreta
  subtotal 3250, vatRate 0, vatAmount 0, vatNature "Reverse Charge", total 3250.
- Non inventare mai un'IVA positiva.`;

const PDF_LANGUAGE_RULES = `LINGUA
- Le regole valgono per italiano, inglese, tedesco, francese, spagnolo e documenti misti:
  usa gli equivalenti semantici delle etichette, non solo quelli italiani.`;

const PDF_ITEM_RULES = `RIGHE (items)
- Una riga rappresenta un bene o un servizio.
- Mantieni l'associazione tra descrizione, quantità, unità, prezzo unitario, sconto,
  imponibile, aliquota, natura IVA, totale riga e valuta, seguendo la tabella visibile.
- Gestisci descrizioni su più righe, righe di continuazione, intestazioni di tabella ripetute e tabelle su più pagine.
- Una descrizione che continua sulla riga sotto appartiene alla stessa riga commerciale: non duplicarla come riga nuova.
- Non creare righe da: intestazioni di tabella, totali, riepilogo imposte, condizioni di pagamento,
  piè di pagina o dati aziendali.
- Rispetta l'ordine di lettura del documento e non ripetere due volte la stessa riga.`;

const PDF_SUMMARY_SEMANTICS = `EMITTENTE (issuer)
- È l'azienda o la persona che emette, vende, offre, fattura o fornisce.
- Evidenze tipiche: carta intestata, blocco del mittente, indirizzo e recapiti aziendali,
  etichette venditore/fornitore, firma, direzione, referente commerciale, dati di registrazione a piè di pagina.
- Il NOME va tenuto separato da indirizzo, email, telefono, sito, persona di contatto,
  reparto e numero fiscale: quei campi hanno una loro voce.
- Non usare mai email, telefono, persona o indirizzo come nome dell'emittente quando è visibile una ragione sociale.

CLIENTE (customer)
- È il destinatario, l'acquirente o il committente del documento.
- Segnali equivalenti in più lingue: Customer, Client, Buyer, Recipient, Bill To, Ship To,
  Destinatario, Cliente, Spett.le, Kunde, Empfänger, Client, Cliente, "Your customer no.".
- Emittente e cliente non vanno mai fusi nella stessa entità.

OGGETTO (structured.document.subject)
- È lo scopo commerciale o il titolo descrittivo del documento.
- Priorità: 1) etichetta esplicita (Subject, Oggetto, Object, Betreff, Objet, Asunto, Re);
  2) titolo principale tra l'intestazione e il corpo del documento;
  3) intestazione descrittiva associata al tipo e al numero del documento.
- Esempio: da "Proposal AN-1002 Allegra Software Maintenance Contract Renewal" ricava
  documentNumber "AN-1002" e subject "Allegra Software Maintenance Contract Renewal".
- Non usare mai come oggetto: nome dell'emittente, nome del cliente, indirizzi, email,
  sito, telefono, numero fiscale, dati bancari o note legali a piè di pagina.
- Se non esiste un oggetto affidabile restituisci null.

NUMERO DOCUMENTO
- Cercalo accanto a etichette come Proposal no., Quotation no., Quote no., Preventivo,
  Offerta, Order no., Ordine, Invoice no., Fattura, Devis, Angebot, Presupuesto.
- Non confonderlo con partita IVA, numero cliente, numero di registrazione, date o telefoni.

DATE
- Restituisci le date in formato ISO YYYY-MM-DD.
- Se il documento scrive "Feb 6, 2025" restituisci "2025-02-06", non "06/02/2025".
- Distingui issueDate, dueDate, validityDate e deliveryDate: la data di validità non è la data del documento.

TOTALI
- Distingui imponibile/netto, importo tassabile, IVA, sconti, spese di spedizione,
  oneri aggiuntivi, acconto, saldo e totale finale.
- L'aritmetica serve solo come verifica: non modificare un valore visibile per far tornare i conti.
- Se imponibile + IVA non corrisponde al totale, riporta i valori visibili e segnala un conflitto con review.

VALUTA
- Ricavala da simboli o codici espliciti (EUR, €, USD, $, GBP, £, CHF) associati agli importi commerciali.
- Non dedurre la valuta dal paese dell'azienda se non è scritta.`;

const STRUCTURED_SUMMARY_SCHEMA_PROMPT = `
Oltre ai campi di compatibilità, aggiungi "structured" con schemaVersion 2, language e
le sezioni document, issuer, customer, recipient, prospect, vehicle, project,
delivery, shipping, bank, publicAdministrationData, summary, conditions,
conflicts e requiresReview. In questa risposta NON includere la sezione items.

In language restituisci detectedLanguages, primaryLanguage, confidence,
mixedLanguage e la lingua per pagina. Usa documentType canonico: quotation,
order, invoice, credit_note o free_document. Non tradurre nomi, indirizzi,
descrizioni o evidence. Distingui identificativi VAT/TVA/MwSt/USt/IVA dagli
importi fiscali e restituisci null quando data, numero o associazione sono incerti.

Campi document: documentType, documentNumber, internalReference,
customerReference, issueDate, dueDate, validityDate, currency, subject,
references, cup, cig, pageCount.
Campi soggetto: name, legalForm, department, address, billingAddress, shippingAddress,
postalCode, city, region, country, vatNumber, taxCode, email, phone, website,
registrationNumber, iban, bic, bankName, contactPerson.
Campi veicolo: make, model, plate, vin, registrationDate, kilometers, engine.
Campi progetto: name, reference, office.
Campi consegna: date, terms, recipient, address.
Campi spedizione: terms, carrier, cost.
Campi banca: bankName, branch, iban, bic, ownerRole.
Campi PA: cup, cig, entityReference, office.
Campi riepilogo: materialTotal, laborTotal, externalWorkTotal, subtotal,
discountTotal, shippingCost, logisticsContribution, additionalCharges,
taxableAmount, vatAmount, taxSummaries, total, deposit, balance, currency.
Campi condizioni: paymentTerms, deliveryDate, deliveryTerms, shippingTerms,
bankDetails, iban, notes, signatures.

Ogni campo scalare deve essere un oggetto con value, pageIndex, evidenceText,
confidenceType (unknown oppure heuristic), requiresReview e alternatives.
Estrai solo valori visibili. Non inventare, non correggere matematicamente e
non usare zero per un valore assente. Se incerto restituisci null o ometti il
campo. Se valori o associazioni divergono, aggiungi un conflitto e richiedi
review. Distingui emittente da cliente, VIN da IBAN e identificativi fiscali
da importi. Non salvare automaticamente alcun valore.`;

/**
 * PRIMA PASSATA: solo l'intestazione commerciale del documento.
 *
 * Le due passate esistono perché la generazione è la parte lenta: su un
 * documento con molte righe, chiedere intestazione e tabella nella stessa
 * risposta produce un JSON così lungo che il modello non fa in tempo a
 * completarlo. Separandole, ogni risposta resta corta.
 */
export function pdfSummaryPrompt(
  expectedType?: PdfExpectedDocumentType
): string {
  return `${pdfRoleIntro(expectedType)}
In questa richiesta ti occupi SOLO dell'intestazione commerciale: parti, date,
numero, oggetto, valuta e totali. NON elencare le righe della tabella: la
tabella viene chiesta separatamente e qui sarebbe soltanto tempo perso.

Rispondi SOLO con JSON valido (nessun markdown):
{
  "rawText": "tutto il testo leggibile, righe separate da \\n, ordine di lettura naturale dall'alto verso il basso",
  "documentNumber": null,
  "customerName": null,
  "date": null,
  "subtotal": null,
  "vatAmount": null,
  "total": null
}

${PDF_EVIDENCE_RULES}

${PDF_SUMMARY_SEMANTICS}

${PDF_FISCAL_RULES}

${PDF_LANGUAGE_RULES}
${STRUCTURED_SUMMARY_SCHEMA_PROMPT}`;
}

/**
 * SECONDA PASSATA: solo la tabella, in JSON piatto.
 *
 * Qui non serve lo schema structured né i wrapper { value, evidenceText }:
 * allungano la risposta e fanno scadere i 20 secondi. I metadati del documento
 * restano nella prima passata.
 */
export function pdfItemsPrompt(
  _expectedType?: PdfExpectedDocumentType
): string {
  return `${UNTRUSTED_DATA_PREAMBLE}

Estrai SOLO le righe commerciali della tabella dal PDF.
NON restituire issuer, customer, date, numero documento, oggetto, totali,
indirizzi, banca, condizioni o qualsiasi altro metadato.

Rispondi SOLO con JSON valido (nessun markdown), scalari piatti:
{
  "items": [
    {
      "code": null,
      "description": null,
      "quantity": null,
      "unit": null,
      "unitPrice": null,
      "discount": null,
      "vatRate": null,
      "lineTotal": null
    }
  ]
}

Regole:
- Solo beni o servizi della tabella; niente intestazioni, totali, riepiloghi IVA, piè di pagina.
- Descrizioni su più righe e tabelle multipagina: una sola riga commerciale per articolo, nell'ordine di lettura.
- Non inventare. Numeri come number (punto decimale). null se assente.
- vatRate è una percentuale di riga, non un importo e non un identificativo fiscale.
- Intestazioni di colonna in italiano, inglese, tedesco, francese o spagnolo.`;
}

export const CARD_EXTRACT_PROMPT = `Sei un OCR per biglietti da visita (italiano/internazionale).
Analizza l'immagine e rispondi SOLO con JSON valido (nessun markdown):
{
  "rawText": "TUTTO il testo leggibile sul biglietto, una riga per ogni riga visibile",
  "documentNumber": "",
  "customerName": "nome e cognome persona se presenti",
  "date": "",
  "subtotal": 0,
  "vatAmount": 0,
  "total": 0,
  "items": []
}
Regole:
- rawText è il campo più importante: copia ogni riga (nome, ruolo, azienda, indirizzo, email, telefono, sito, P.IVA).
- Ignora lo sfondo fuori dal biglietto.`;

export interface DocumentExtract {
  rawText: string;
  documentNumber?: string;
  customerName?: string;
  date?: string;
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  items?: Array<{
    description?: string;
    quantity?: number;
    unitPrice?: number;
    total?: number;
  }>;
  structured?: Record<string, unknown>;
  rawFields?: Partial<
    Record<
      | 'documentNumber'
      | 'customerName'
      | 'date'
      | 'subtotal'
      | 'vatAmount'
      | 'total'
      | 'items',
      unknown
    >
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const MISSING_TEXT =
  /^(?:n\/?a|n\.?\s*d\.?|non\s+disponibile|unknown|not\s+found|null|undefined|-)$/i;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && !MISSING_TEXT.test(trimmed) ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : undefined;
}

/**
 * Gemini a volte mette i campi di riga come scalari, a volte come
 * `{ value, pageIndex, evidenceText }`. Qui si legge sempre il valore utile.
 */
function unwrapFieldValue(value: unknown): unknown {
  if (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    return value.value;
  }
  return value;
}

function flatItems(value: unknown): DocumentExtract['items'] {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isRecord)
    .map((item) => {
      const description = optionalString(unwrapFieldValue(item.description));
      const quantity = optionalNumber(unwrapFieldValue(item.quantity));
      const unitPrice = optionalNumber(unwrapFieldValue(item.unitPrice));
      const itemTotal = optionalNumber(
        unwrapFieldValue(item.total ?? item.lineTotal)
      );
      return {
        ...(description !== undefined ? { description } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        ...(unitPrice !== undefined ? { unitPrice } : {}),
        ...(itemTotal !== undefined ? { total: itemTotal } : {}),
      };
    })
    .filter((item) => Object.keys(item).length > 0);
}

/** True se almeno un campo commerciale della riga è un wrapper structured. */
function itemHasStructuredWrappers(item: unknown): boolean {
  if (!isRecord(item)) return false;
  for (const key of [
    'description',
    'code',
    'itemCode',
    'quantity',
    'unit',
    'unitPrice',
    'discount',
    'vatRate',
    'lineTotal',
    'total',
  ]) {
    if (looksLikeStructuredScalar(item[key])) return true;
  }
  return false;
}

export function parseJsonResponse(text: string): DocumentExtract | null {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!isRecord(parsed)) return null;

    const rawText =
      typeof parsed.rawText === 'string' ? parsed.rawText.trim() : '';
    if (!rawText || rawText.length > MAX_DOCUMENT_RAW_TEXT_CHARS) return null;
    if (
      Array.isArray(parsed.items) &&
      parsed.items.length > MAX_DOCUMENT_ITEMS
    ) {
      return null;
    }
    const rawFields = Object.fromEntries(
      [
        'documentNumber',
        'customerName',
        'date',
        'subtotal',
        'vatAmount',
        'total',
        'items',
      ]
        .filter((field) =>
          Object.prototype.hasOwnProperty.call(parsed, field)
        )
        .map((field) => [field, parsed[field]])
    ) as NonNullable<DocumentExtract['rawFields']>;
    const documentNumber = optionalString(parsed.documentNumber);
    const customerName = optionalString(parsed.customerName);
    const date = optionalString(parsed.date);
    const subtotal = optionalNumber(parsed.subtotal);
    const vatAmount = optionalNumber(parsed.vatAmount);
    const total = optionalNumber(parsed.total);
    const items = flatItems(parsed.items);
    const structured = isRecord(parsed.structured)
      ? parsed.structured
      : undefined;

    return {
      rawText,
      ...(documentNumber !== undefined ? { documentNumber } : {}),
      ...(customerName !== undefined ? { customerName } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(subtotal !== undefined ? { subtotal } : {}),
      ...(vatAmount !== undefined ? { vatAmount } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(items !== undefined ? { items } : {}),
      ...(structured !== undefined ? { structured } : {}),
      ...(Object.keys(rawFields).length > 0 ? { rawFields } : {}),
    };
  } catch {
    return null;
  }
}

export async function extractWithGemini(
  parts: GeminiPart[],
  apiKey: string,
  model: SupportedGeminiModel,
  options?: { timeoutMs?: number }
): Promise<GeminiOperationOutcome<DocumentExtract>> {
  const provider = await generateGeminiJson({
    model,
    parts,
    apiKey,
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (!provider.ok) {
    edgeLogger.warn('GEMINI_PROVIDER_REJECTED', {
      ...(provider.httpStatus !== undefined
        ? { httpStatus: provider.httpStatus }
        : {}),
      status: provider.httpStatus ? 'rejected' : 'failed',
      stage: 'provider',
      reasonCode:
        provider.errorCode === 'AI_PROVIDER_RESPONSE_INVALID'
          ? 'response_invalid'
          : 'provider_rejected',
    });
    return provider;
  }

  const parsed = parseJsonResponse(provider.text);
  if (!parsed?.rawText.trim()) {
    return { ok: false, errorCode: 'AI_PROVIDER_RESPONSE_INVALID' };
  }
  return {
    ok: true,
    value: parsed,
    ...(provider.usage !== undefined ? { usage: provider.usage } : {}),
  };
}

export interface PdfItemsExtract {
  items?: DocumentExtract['items'];
  rawItems?: unknown;
  structuredItems?: unknown[];
}

export interface PdfItemsPassDiagnostics {
  providerResponse: {
    httpStatus: number | null;
    finishReason: string | null;
    responseTextLength: number;
    jsonParsed: boolean;
    topLevelKeys: string[];
    itemsArrayPresent: boolean;
    itemsArrayLength: number | null;
    firstItemKeys: string[] | null;
    lastItemKeys: string[] | null;
  };
  afterParse: {
    itemsBeforeNormalization: number;
    itemsAfterNormalization: number;
    structuredItemsCount: number;
    rejectedItems: number;
    rejectionReasons: Record<string, number>;
  };
  afterMerge: {
    summaryItems: number;
    itemsPassItems: number;
    mergedItems: number;
  };
}

function objectKeys(value: unknown): string[] | null {
  return isRecord(value) ? Object.keys(value) : null;
}

/** Un campo scalare structured ha `value` + metadati di evidenza. */
function looksLikeStructuredScalar(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'value');
}

/**
 * Diagnostica perché flatItems scarta una riga. Non cambia il parsing:
 * serve solo a dimostrare dove spariscono le righe della seconda passata.
 */
export function diagnoseFlatItemRejection(item: unknown): string {
  if (!isRecord(item)) return 'notObject';
  const scalarKeys = ['description', 'quantity', 'unitPrice', 'total', 'lineTotal'];
  let wrapped = 0;
  let flat = 0;
  for (const key of scalarKeys) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const value = item[key];
    if (looksLikeStructuredScalar(value)) wrapped += 1;
    else if (
      (key === 'description' && typeof value === 'string') ||
      (key !== 'description' && typeof value === 'number')
    ) {
      flat += 1;
    }
  }
  if (wrapped > 0 && flat === 0) return 'structuredWrappersInTopLevelItem';
  if (flat === 0 && wrapped === 0) return 'noUsableFlatScalars';
  return 'unknown';
}

function aggregateRejectionReasons(rawItems: unknown[]): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const item of rawItems) {
    const flat = flatItems([item]);
    if (flat && flat.length > 0) continue;
    const reason = diagnoseFlatItemRejection(item);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return reasons;
}

/** La seconda passata non porta rawText: qui si leggono soltanto le righe. */
export function parsePdfItemsResponse(text: string): PdfItemsExtract | null {
  const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!isRecord(parsed)) return null;
    if (Array.isArray(parsed.items) && parsed.items.length > MAX_DOCUMENT_ITEMS) {
      return null;
    }
    const structured = isRecord(parsed.structured) ? parsed.structured : undefined;
    const fromStructured = Array.isArray(structured?.items)
      ? (structured?.items as unknown[])
      : undefined;
    // Se i wrapper stanno già nelle righe top-level, non serve un secondo array.
    const fromTopLevel =
      fromStructured === undefined &&
      Array.isArray(parsed.items) &&
      parsed.items.some(itemHasStructuredWrappers)
        ? (parsed.items as unknown[])
        : undefined;
    const structuredItems = fromStructured ?? fromTopLevel;
    if (structuredItems && structuredItems.length > MAX_DOCUMENT_ITEMS) return null;

    const items = flatItems(parsed.items);
    return {
      ...(items !== undefined ? { items } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, 'items')
        ? { rawItems: parsed.items }
        : {}),
      ...(structuredItems !== undefined ? { structuredItems } : {}),
    };
  } catch {
    return null;
  }
}

/** Solo forma e conteggi: niente descrizioni né importi di business. */
export function buildPdfItemsPassProviderDiagnostics(
  text: string,
  meta: { httpStatus?: number; finishReason?: string }
): PdfItemsPassDiagnostics['providerResponse'] {
  const trimmed = text.trim();
  let topLevelKeys: string[] = [];
  let itemsArrayPresent = false;
  let itemsArrayLength: number | null = null;
  let firstItemKeys: string[] | null = null;
  let lastItemKeys: string[] | null = null;
  let jsonParsed = false;

  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (isRecord(parsed)) {
        jsonParsed = true;
        topLevelKeys = Object.keys(parsed);
        itemsArrayPresent = Array.isArray(parsed.items);
        if (Array.isArray(parsed.items)) {
          itemsArrayLength = parsed.items.length;
          if (parsed.items.length > 0) {
            firstItemKeys = objectKeys(parsed.items[0]);
            lastItemKeys = objectKeys(parsed.items[parsed.items.length - 1]);
          }
        }
      }
    }
  } catch {
    jsonParsed = false;
  }

  return {
    httpStatus: meta.httpStatus ?? null,
    finishReason: meta.finishReason ?? null,
    responseTextLength: trimmed.length,
    jsonParsed,
    topLevelKeys,
    itemsArrayPresent,
    itemsArrayLength,
    firstItemKeys,
    lastItemKeys,
  };
}

export function buildPdfItemsPassParseDiagnostics(
  rawText: string,
  parsed: PdfItemsExtract | null
): PdfItemsPassDiagnostics['afterParse'] {
  let itemsBeforeNormalization = 0;
  try {
    const jsonMatch = rawText.trim().match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const value: unknown = JSON.parse(jsonMatch[0]);
      if (isRecord(value) && Array.isArray(value.items)) {
        itemsBeforeNormalization = value.items.length;
        const rejectionReasons = aggregateRejectionReasons(value.items);
        return {
          itemsBeforeNormalization,
          itemsAfterNormalization: parsed?.items?.length ?? 0,
          structuredItemsCount: parsed?.structuredItems?.length ?? 0,
          rejectedItems: itemsBeforeNormalization - (parsed?.items?.length ?? 0),
          rejectionReasons,
        };
      }
    }
  } catch {
    // fall through
  }
  return {
    itemsBeforeNormalization,
    itemsAfterNormalization: parsed?.items?.length ?? 0,
    structuredItemsCount: parsed?.structuredItems?.length ?? 0,
    rejectedItems: itemsBeforeNormalization,
    rejectionReasons: itemsBeforeNormalization > 0 ? { parseFailed: 1 } : {},
  };
}

/**
 * Fusione deterministica delle due passate: l'intestazione viene dalla prima,
 * le righe dalla seconda. Nessuna delle due tocca il territorio dell'altra.
 */
export function mergePdfPasses(
  summary: DocumentExtract,
  items: PdfItemsExtract | null
): DocumentExtract {
  if (!items) return summary;
  const structured = summary.structured
    ? {
      ...summary.structured,
      ...(items.structuredItems !== undefined
        ? { items: items.structuredItems }
        : {}),
    }
    : items.structuredItems !== undefined
      ? { schemaVersion: 2, items: items.structuredItems }
      : undefined;

  return {
    ...summary,
    ...(items.items !== undefined ? { items: items.items } : {}),
    ...(structured !== undefined ? { structured } : {}),
    ...(items.rawItems !== undefined
      ? { rawFields: { ...summary.rawFields, items: items.rawItems } }
      : {}),
  };
}

export interface PdfExtractionTimings {
  summaryMs: number;
  itemsMs: number;
  totalMs: number;
}

export interface PdfPassTokenUsage {
  summary?: GeminiTokenUsage;
  items?: GeminiTokenUsage;
  aggregate?: GeminiTokenUsage;
}

export interface PdfExtraction {
  extract: DocumentExtract;
  timings: PdfExtractionTimings;
  itemsPassFailed?: true;
  itemsPassDiagnostics?: PdfItemsPassDiagnostics;
  /** Passive metering for PASS A + PASS B (no document contents). */
  passTokenUsage?: PdfPassTokenUsage;
}

export interface ExtractPdfOptions {
  expectedType?: PdfExpectedDocumentType;
  timeoutMs?: number;
  fetchImpl?: GenerateGeminiJsonOptions['fetchImpl'];
}

/**
 * Due letture della stessa pagina, una per l'intestazione e una per la tabella,
 * eseguite insieme: il tempo totale resta quello della più lenta e ogni risposta
 * è abbastanza corta da essere completata entro il limite.
 */
export async function extractPdfWithGemini(
  pdfBase64: string,
  apiKey: string,
  model: SupportedGeminiModel,
  options?: ExtractPdfOptions
): Promise<GeminiOperationOutcome<PdfExtraction>> {
  const pdfPart: GeminiPart = {
    inline_data: { mime_type: 'application/pdf', data: pdfBase64 },
  };
  const call = (prompt: string) =>
    generateGeminiJson({
      model,
      apiKey,
      parts: [{ text: prompt }, pdfPart],
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });

  const startedAt = Date.now();
  const summaryStartedAt = startedAt;
  let summaryMs = 0;
  let itemsMs = 0;

  const [summaryOutcome, itemsOutcome] = await Promise.all([
    call(pdfSummaryPrompt(options?.expectedType)).then((outcome) => {
      summaryMs = Date.now() - summaryStartedAt;
      return outcome;
    }),
    call(pdfItemsPrompt(options?.expectedType)).then((outcome) => {
      itemsMs = Date.now() - startedAt;
      return outcome;
    }),
  ]);

  if (!summaryOutcome.ok) {
    edgeLogger.warn('GEMINI_PROVIDER_REJECTED', {
      ...(summaryOutcome.httpStatus !== undefined
        ? { httpStatus: summaryOutcome.httpStatus }
        : {}),
      status: summaryOutcome.httpStatus ? 'rejected' : 'failed',
      stage: 'provider',
      reasonCode: 'provider_rejected',
    });
    return summaryOutcome;
  }

  const summary = parseJsonResponse(summaryOutcome.text);
  if (!summary?.rawText.trim()) {
    return { ok: false, errorCode: 'AI_PROVIDER_RESPONSE_INVALID' };
  }

  // Un'intestazione valida vale più di niente: se la tabella non arriva, il
  // documento resta importabile e la revisione locale può completarlo.
  const itemsText = itemsOutcome.ok ? itemsOutcome.text : '';
  const items = itemsOutcome.ok ? parsePdfItemsResponse(itemsText) : null;
  if (!items) {
    edgeLogger.warn('GEMINI_PROVIDER_REJECTED', {
      status: 'failed',
      stage: 'provider',
      reasonCode: itemsOutcome.ok ? 'response_invalid' : 'provider_rejected',
    });
  }

  const merged = mergePdfPasses(summary, items);
  const itemsPassDiagnostics: PdfItemsPassDiagnostics = {
    providerResponse: itemsOutcome.ok
      ? buildPdfItemsPassProviderDiagnostics(itemsText, {
          ...(itemsOutcome.httpStatus !== undefined
            ? { httpStatus: itemsOutcome.httpStatus }
            : {}),
          ...(itemsOutcome.finishReason !== undefined
            ? { finishReason: itemsOutcome.finishReason }
            : {}),
        })
      : {
          httpStatus: itemsOutcome.httpStatus ?? null,
          finishReason: null,
          responseTextLength: 0,
          jsonParsed: false,
          topLevelKeys: [],
          itemsArrayPresent: false,
          itemsArrayLength: null,
          firstItemKeys: null,
          lastItemKeys: null,
        },
    afterParse: itemsOutcome.ok
      ? buildPdfItemsPassParseDiagnostics(itemsText, items)
      : {
          itemsBeforeNormalization: 0,
          itemsAfterNormalization: 0,
          structuredItemsCount: 0,
          rejectedItems: 0,
          rejectionReasons: {
            providerRejected: 1,
          },
        },
    afterMerge: {
      summaryItems: summary.items?.length ?? 0,
      itemsPassItems: items?.items?.length ?? 0,
      mergedItems: merged.items?.length ?? 0,
    },
  };

  const summaryUsage = summaryOutcome.usage;
  const itemsUsage = itemsOutcome.ok ? itemsOutcome.usage : undefined;
  const aggregateUsage = aggregateGeminiTokenUsage([summaryUsage, itemsUsage]);
  const passTokenUsage: PdfPassTokenUsage | undefined =
    summaryUsage || itemsUsage || aggregateUsage
      ? {
          ...(summaryUsage !== undefined ? { summary: summaryUsage } : {}),
          ...(itemsUsage !== undefined ? { items: itemsUsage } : {}),
          ...(aggregateUsage !== undefined ? { aggregate: aggregateUsage } : {}),
        }
      : undefined;

  return {
    ok: true,
    value: {
      extract: merged,
      timings: {
        summaryMs,
        itemsMs,
        totalMs: Date.now() - startedAt,
      },
      itemsPassDiagnostics,
      ...(items ? {} : { itemsPassFailed: true as const }),
      ...(passTokenUsage !== undefined ? { passTokenUsage } : {}),
    },
    ...(aggregateUsage !== undefined ? { usage: aggregateUsage } : {}),
  };
}
