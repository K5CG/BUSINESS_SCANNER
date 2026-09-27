import type { CanonicalCommercialDocumentType, DocumentLanguage } from './document-label-dictionary';

export type AiConfidenceType = 'heuristic' | 'unknown';

export interface AiField<T> {
  value: T;
  pageIndex: number;
  evidenceText: string;
  confidenceType: AiConfidenceType;
  requiresReview: boolean;
  alternatives: T[];
}

export interface AiParty {
  name?: AiField<string>;
  legalForm?: AiField<string>;
  department?: AiField<string>;
  address?: AiField<string>;
  billingAddress?: AiField<string>;
  shippingAddress?: AiField<string>;
  postalCode?: AiField<string>;
  city?: AiField<string>;
  region?: AiField<string>;
  country?: AiField<string>;
  vatNumber?: AiField<string>;
  taxCode?: AiField<string>;
  registrationNumber?: AiField<string>;
  email?: AiField<string>;
  phone?: AiField<string>;
  website?: AiField<string>;
  iban?: AiField<string>;
  bic?: AiField<string>;
  bankName?: AiField<string>;
  contactPerson?: AiField<string>;
}

export interface AiVehicleSection {
  make?: AiField<string>;
  model?: AiField<string>;
  plate?: AiField<string>;
  vin?: AiField<string>;
  registrationDate?: AiField<string>;
  kilometers?: AiField<number>;
  engine?: AiField<string>;
  requiresReview: boolean;
}

export interface AiProjectSection {
  name?: AiField<string>;
  reference?: AiField<string>;
  office?: AiField<string>;
  requiresReview: boolean;
}

export interface AiDeliverySection {
  date?: AiField<string>;
  terms?: AiField<string>;
  recipient?: AiField<string>;
  address?: AiField<string>;
  requiresReview: boolean;
}

export interface AiShippingSection {
  terms?: AiField<string>;
  carrier?: AiField<string>;
  cost?: AiField<number>;
  requiresReview: boolean;
}

export interface AiBankSection {
  bankName?: AiField<string>;
  branch?: AiField<string>;
  iban?: AiField<string>;
  bic?: AiField<string>;
  ownerRole?: 'issuer' | 'customer' | 'unknown';
  requiresReview: boolean;
}

export interface AiPublicAdministrationData {
  cup?: AiField<string>;
  cig?: AiField<string>;
  entityReference?: AiField<string>;
  office?: AiField<string>;
  requiresReview: boolean;
}

export interface AiLineItem {
  itemCode?: AiField<string>;
  description?: AiField<string>;
  quantity?: AiField<number>;
  unit?: AiField<string>;
  unitPrice?: AiField<number>;
  discount?: AiField<number>;
  discountType?: AiField<'percentage' | 'amount'>;
  taxableAmount?: AiField<number>;
  vatRate?: AiField<number>;
  vatNature?: AiField<string>;
  vatIncluded?: AiField<boolean>;
  lineTotal?: AiField<number>;
  currency?: AiField<string>;
  pageIndex: number;
  evidenceText: string;
  requiresReview: boolean;
}

export interface AiStructuredDocumentExtract {
  schemaVersion: 2;
  language?: {
    detectedLanguages: DocumentLanguage[];
    primaryLanguage?: DocumentLanguage;
    confidence: number;
    mixedLanguage: boolean;
    pages: Array<{ pageIndex: number; language: DocumentLanguage; confidence: number }>;
  };
  document: {
    documentType?: AiField<CanonicalCommercialDocumentType>;
    documentNumber?: AiField<string>;
    internalReference?: AiField<string>;
    customerReference?: AiField<string>;
    issueDate?: AiField<string>;
    dueDate?: AiField<string>;
    validityDate?: AiField<string>;
    currency?: AiField<string>;
    subject?: AiField<string>;
    references?: AiField<string[]>;
    cup?: AiField<string>;
    cig?: AiField<string>;
    pageCount?: AiField<number>;
  };
  issuer?: AiParty;
  customer?: AiParty;
  recipient?: AiParty;
  prospect?: AiParty;
  vehicle?: AiVehicleSection;
  project?: AiProjectSection;
  delivery?: AiDeliverySection;
  shipping?: AiShippingSection;
  bank?: AiBankSection;
  publicAdministrationData?: AiPublicAdministrationData;
  items: AiLineItem[];
  summary: {
    materialTotal?: AiField<number>;
    laborTotal?: AiField<number>;
    externalWorkTotal?: AiField<number>;
    subtotal?: AiField<number>;
    discountTotal?: AiField<number>;
    shippingCost?: AiField<number>;
    logisticsContribution?: AiField<number>;
    additionalCharges?: AiField<number>;
    taxableAmount?: AiField<number>;
    vatAmount?: AiField<number>;
    taxSummaries?: Array<{
      vatRate?: AiField<number>;
      vatNature?: AiField<string>;
      taxableAmount?: AiField<number>;
      vatAmount?: AiField<number>;
      pageIndex: number;
      requiresReview: boolean;
    }>;
    total?: AiField<number>;
    deposit?: AiField<number>;
    balance?: AiField<number>;
    currency?: AiField<string>;
  };
  conditions: {
    paymentTerms?: AiField<string>;
    deliveryDate?: AiField<string>;
    deliveryTerms?: AiField<string>;
    shippingTerms?: AiField<string>;
    bankDetails?: AiField<string>;
    iban?: AiField<string>;
    notes?: AiField<string>;
    signatures?: AiField<string[]>;
  };
  conflicts: string[];
  requiresReview: boolean;
}

function mergeFieldRecords<T extends object>(
  values: readonly (T | undefined)[],
  preferLast = false,
): T | undefined {
  const ordered = preferLast ? values : [...values].reverse();
  const merged = Object.assign({}, ...ordered.filter(Boolean)) as T;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Preserves the provider schema across the existing per-page extraction path. */
export function mergeAiStructuredDocuments(
  documents: readonly AiStructuredDocumentExtract[],
): AiStructuredDocumentExtract | undefined {
  if (documents.length === 0) return undefined;
  const document = mergeFieldRecords(documents.map((value) => value.document)) ?? {};
  const summaryBase = mergeFieldRecords(documents.map((value) => value.summary), true) ?? {};
  const taxSummaries = documents.flatMap((value) => value.summary.taxSummaries ?? []);
  const summary = { ...summaryBase, ...(taxSummaries.length > 0 ? { taxSummaries } : {}) };
  const conditions = mergeFieldRecords(documents.map((value) => value.conditions)) ?? {};
  const issuer = mergeFieldRecords(documents.map((value) => value.issuer));
  const customer = mergeFieldRecords(documents.map((value) => value.customer));
  const recipient = mergeFieldRecords(documents.map((value) => value.recipient));
  const prospect = mergeFieldRecords(documents.map((value) => value.prospect));
  const vehicle = mergeFieldRecords(documents.map((value) => value.vehicle));
  const project = mergeFieldRecords(documents.map((value) => value.project));
  const delivery = mergeFieldRecords(documents.map((value) => value.delivery));
  const shipping = mergeFieldRecords(documents.map((value) => value.shipping));
  const bank = mergeFieldRecords(documents.map((value) => value.bank));
  const publicAdministrationData = mergeFieldRecords(documents.map((value) => value.publicAdministrationData));
  const languageEntries = documents.flatMap((value) => value.language ? [value.language] : []);
  const detectedLanguages = [...new Set(languageEntries.flatMap((value) => value.detectedLanguages))];
  const primaryLanguage = languageEntries.sort((left, right) => right.confidence - left.confidence)[0]?.primaryLanguage;
  const language = languageEntries.length > 0 ? {
    detectedLanguages,
    ...(primaryLanguage ? { primaryLanguage } : {}),
    confidence: Math.max(...languageEntries.map((value) => value.confidence)),
    mixedLanguage: detectedLanguages.length > 1 || languageEntries.some((value) => value.mixedLanguage),
    pages: languageEntries.flatMap((value) => value.pages),
  } : undefined;
  return {
    schemaVersion: 2,
    ...(language ? { language } : {}),
    document,
    ...(issuer ? { issuer } : {}),
    ...(customer ? { customer } : {}),
    ...(recipient ? { recipient } : {}),
    ...(prospect ? { prospect } : {}),
    ...(vehicle ? { vehicle } : {}),
    ...(project ? { project } : {}),
    ...(delivery ? { delivery } : {}),
    ...(shipping ? { shipping } : {}),
    ...(bank ? { bank } : {}),
    ...(publicAdministrationData ? { publicAdministrationData } : {}),
    items: documents.flatMap((value) => value.items),
    summary,
    conditions,
    conflicts: [...new Set(documents.flatMap((value) => value.conflicts))],
    requiresReview: documents.some((value) => value.requiresReview),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeField<T>(
  value: unknown,
  normalize: (candidate: unknown) => T | undefined,
): AiField<T> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized = normalize(value.value);
  const pageIndex = typeof value.pageIndex === 'number' && Number.isInteger(value.pageIndex) && value.pageIndex >= 0
    ? value.pageIndex
    : undefined;
  const evidenceText = typeof value.evidenceText === 'string' ? value.evidenceText.trim() : '';
  if (normalized === undefined || pageIndex === undefined || !evidenceText) return undefined;
  const confidenceType: AiConfidenceType = value.confidenceType === 'heuristic' ? 'heuristic' : 'unknown';
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.flatMap((candidate) => {
        const alternative = normalize(candidate);
        return alternative === undefined ? [] : [alternative];
      })
    : [];
  return {
    value: normalized,
    pageIndex,
    evidenceText,
    confidenceType,
    requiresReview: value.requiresReview !== false,
    alternatives,
  };
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
const stringsValue = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((entry) => stringValue(entry) ?? []).filter(Boolean);
  return values.length > 0 ? values : undefined;
};

function normalizeFields(
  value: unknown,
  schema: Record<string, (candidate: unknown) => unknown>,
): Record<string, AiField<unknown>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(schema).flatMap(([key, normalizer]) => {
    const field = normalizeField(value[key], normalizer);
    return field ? [[key, field]] : [];
  }));
}

const PARTY_SCHEMA = {
  name: stringValue, legalForm: stringValue, department: stringValue, address: stringValue,
  billingAddress: stringValue, shippingAddress: stringValue,
  postalCode: stringValue, city: stringValue, region: stringValue,
  country: stringValue, vatNumber: stringValue, taxCode: stringValue, registrationNumber: stringValue,
  email: stringValue, phone: stringValue, website: stringValue,
  iban: stringValue, bic: stringValue, bankName: stringValue, contactPerson: stringValue,
};

function normalizeSection<T extends object>(
  value: unknown,
  schema: Record<string, (candidate: unknown) => unknown>,
): T | undefined {
  if (!isRecord(value)) return undefined;
  const fields = normalizeFields(value, schema);
  if (Object.keys(fields).length === 0) return undefined;
  return { ...fields, requiresReview: value.requiresReview !== false } as T;
}

export function normalizeAiStructuredDocument(
  value: unknown,
): AiStructuredDocumentExtract | undefined {
  if (!isRecord(value)) return undefined;
  const document = normalizeFields(value.document, {
    documentType: (candidate) => ['quotation', 'quote', 'order', 'invoice', 'credit_note', 'free_document'].includes(String(candidate))
      ? (candidate === 'quote' ? 'quotation' : candidate)
      : undefined,
    documentNumber: stringValue, internalReference: stringValue, customerReference: stringValue,
    issueDate: stringValue, dueDate: stringValue,
    validityDate: stringValue, currency: stringValue, subject: stringValue,
    references: stringsValue, cup: stringValue, cig: stringValue, pageCount: numberValue,
  });
  const summaryFields = normalizeFields(value.summary, {
    materialTotal: numberValue, laborTotal: numberValue, externalWorkTotal: numberValue,
    subtotal: numberValue, discountTotal: numberValue, shippingCost: numberValue,
    logisticsContribution: numberValue, additionalCharges: numberValue,
    taxableAmount: numberValue, vatAmount: numberValue,
    total: numberValue, deposit: numberValue, balance: numberValue, currency: stringValue,
  });
  const rawSummary = isRecord(value.summary) ? value.summary : {};
  const taxSummaries = Array.isArray(rawSummary.taxSummaries)
    ? rawSummary.taxSummaries.flatMap((candidate): NonNullable<AiStructuredDocumentExtract['summary']['taxSummaries']> => {
        if (!isRecord(candidate)) return [];
        const pageIndex = typeof candidate.pageIndex === 'number' && Number.isInteger(candidate.pageIndex) && candidate.pageIndex >= 0
          ? candidate.pageIndex
          : undefined;
        if (pageIndex === undefined) return [];
        const fields = normalizeFields(candidate, {
          vatRate: numberValue,
          vatNature: stringValue,
          taxableAmount: numberValue,
          vatAmount: numberValue,
        });
        if (Object.keys(fields).length === 0) return [];
        return [{
          ...fields,
          pageIndex,
          requiresReview: candidate.requiresReview !== false,
        }];
      })
    : [];
  const conditions = normalizeFields(value.conditions, {
    paymentTerms: stringValue, deliveryDate: stringValue, deliveryTerms: stringValue,
    shippingTerms: stringValue, bankDetails: stringValue,
    iban: stringValue, notes: stringValue, signatures: stringsValue,
  });
  const items = Array.isArray(value.items) ? value.items.flatMap((candidate): AiLineItem[] => {
    if (!isRecord(candidate)) return [];
    const pageIndex = typeof candidate.pageIndex === 'number' && Number.isInteger(candidate.pageIndex) && candidate.pageIndex >= 0 ? candidate.pageIndex : undefined;
    const evidenceText = stringValue(candidate.evidenceText);
    if (pageIndex === undefined || !evidenceText) return [];
    return [{
      ...normalizeFields(candidate, {
        itemCode: stringValue, description: stringValue, quantity: numberValue,
        unit: stringValue, unitPrice: numberValue, discount: numberValue,
        discountType: (value) => value === 'percentage' || value === 'amount' ? value : undefined,
        taxableAmount: numberValue, vatRate: numberValue, vatNature: stringValue,
        vatIncluded: booleanValue, lineTotal: numberValue, currency: stringValue,
      }),
      pageIndex,
      evidenceText,
      requiresReview: candidate.requiresReview !== false,
    } as AiLineItem];
  }) : [];
  const vehicle = normalizeSection<AiVehicleSection>(value.vehicle, {
    make: stringValue, model: stringValue, plate: stringValue, vin: stringValue,
    registrationDate: stringValue, kilometers: numberValue, engine: stringValue,
  });
  const project = normalizeSection<AiProjectSection>(value.project, { name: stringValue, reference: stringValue, office: stringValue });
  const delivery = normalizeSection<AiDeliverySection>(value.delivery, { date: stringValue, terms: stringValue, recipient: stringValue, address: stringValue });
  const shipping = normalizeSection<AiShippingSection>(value.shipping, { terms: stringValue, carrier: stringValue, cost: numberValue });
  const normalizedBank = normalizeSection<AiBankSection>(value.bank, { bankName: stringValue, branch: stringValue, iban: stringValue, bic: stringValue });
  const bank: AiBankSection | undefined = normalizedBank ? {
    ...normalizedBank,
    ...(isRecord(value.bank) && (value.bank.ownerRole === 'issuer' || value.bank.ownerRole === 'customer' || value.bank.ownerRole === 'unknown')
      ? { ownerRole: value.bank.ownerRole }
      : {}),
  } : undefined;
  const publicAdministrationData = normalizeSection<AiPublicAdministrationData>(value.publicAdministrationData, {
    cup: stringValue, cig: stringValue, entityReference: stringValue, office: stringValue,
  });
  const language = isRecord(value.language) ? (() => {
    const validLanguage = (candidate: unknown): candidate is DocumentLanguage => ['it', 'en', 'fr', 'de', 'es'].includes(String(candidate));
    const detectedLanguages = Array.isArray(value.language.detectedLanguages)
      ? value.language.detectedLanguages.filter(validLanguage)
      : [];
    const primaryLanguage = validLanguage(value.language.primaryLanguage) ? value.language.primaryLanguage : undefined;
    const confidence = typeof value.language.confidence === 'number' && value.language.confidence >= 0 && value.language.confidence <= 1
      ? value.language.confidence
      : 0;
    const pages = Array.isArray(value.language.pages) ? value.language.pages.flatMap((entry) => {
      if (!isRecord(entry) || !Number.isInteger(entry.pageIndex) || !validLanguage(entry.language)) return [];
      const pageConfidence = typeof entry.confidence === 'number' && entry.confidence >= 0 && entry.confidence <= 1 ? entry.confidence : 0;
      return [{ pageIndex: entry.pageIndex as number, language: entry.language, confidence: pageConfidence }];
    }) : [];
    return detectedLanguages.length > 0 || primaryLanguage
      ? { detectedLanguages, ...(primaryLanguage ? { primaryLanguage } : {}), confidence, mixedLanguage: value.language.mixedLanguage === true, pages }
      : undefined;
  })() : undefined;
  return {
    schemaVersion: 2,
    ...(language ? { language } : {}),
    document: document as AiStructuredDocumentExtract['document'],
    ...(isRecord(value.issuer) ? { issuer: normalizeFields(value.issuer, PARTY_SCHEMA) as AiParty } : {}),
    ...(isRecord(value.customer) ? { customer: normalizeFields(value.customer, PARTY_SCHEMA) as AiParty } : {}),
    ...(isRecord(value.recipient) ? { recipient: normalizeFields(value.recipient, PARTY_SCHEMA) as AiParty } : {}),
    ...(isRecord(value.prospect) ? { prospect: normalizeFields(value.prospect, PARTY_SCHEMA) as AiParty } : {}),
    ...(vehicle ? { vehicle } : {}),
    ...(project ? { project } : {}),
    ...(delivery ? { delivery } : {}),
    ...(shipping ? { shipping } : {}),
    ...(bank ? { bank } : {}),
    ...(publicAdministrationData ? { publicAdministrationData } : {}),
    items,
    summary: {
      ...(summaryFields as AiStructuredDocumentExtract['summary']),
      ...(taxSummaries.length > 0 ? { taxSummaries } : {}),
    },
    conditions: conditions as AiStructuredDocumentExtract['conditions'],
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.flatMap((entry) => stringValue(entry) ?? []) : [],
    requiresReview: value.requiresReview !== false,
  };
}
