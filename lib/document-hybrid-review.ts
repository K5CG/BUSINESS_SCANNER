import type { AnyDocument } from '../types';
import type { HybridDocumentReconciliation, ReconciledField, ReconciledTaxSummaryValue } from './document-ai-reconciler';
import type { DocumentEvidence, StructuredDocumentExtraction } from './document-structure';
import type { DeterministicDocumentValidation } from './document-deterministic-validation';

export type HybridReviewDecision = 'pending' | 'accepted' | 'rejected' | 'manual';

export interface HybridDocumentReviewState {
  reconciliation: HybridDocumentReconciliation;
  validation: DeterministicDocumentValidation;
  decisions: Record<string, HybridReviewDecision>;
}

function validationDecisionPath(fieldPath: string): string {
  const itemMatch = fieldPath.match(/^items\.(\d+)(?:\.|$)/);
  if (itemMatch) return `items.${itemMatch[1]}`;
  const summaryMatch = fieldPath.match(/^summary\.(subtotal|taxableAmount|discountTotal|shippingCost|additionalCharges|vatAmount|total|deposit|balance)$/);
  if (summaryMatch) return summaryMatch[1];
  const ibanMatch = fieldPath.match(/^iban\.(0|1|2)$/);
  if (ibanMatch) return ['issuerIban', 'customerIban', 'conditionsIban'][Number(ibanMatch[1])];
  return fieldPath.replace(/^document\./, '');
}

export function createHybridDocumentReview(
  reconciliation: HybridDocumentReconciliation,
  validation: DeterministicDocumentValidation,
): HybridDocumentReviewState {
  const decisions: Record<string, HybridReviewDecision> = {};
  for (const [path, field] of Object.entries(reconciliation.fields)) {
    if (field.requiresReview && field.status !== 'missing') decisions[path] = 'pending';
  }
  reconciliation.items.forEach((item) => {
    decisions[`items.${item.index}`] = item.requiresReview ? 'pending' : 'accepted';
  });
  validation.issues.filter((issue) => issue.blocking).forEach((issue) => {
    const path = validationDecisionPath(issue.fieldPath);
    if (path in reconciliation.fields || reconciliation.items.some((item) => `items.${item.index}` === path)) {
      decisions[path] = 'pending';
    }
  });
  return { reconciliation, validation, decisions };
}

export function decideHybridReview(
  state: HybridDocumentReviewState,
  path: string,
  decision: Exclude<HybridReviewDecision, 'pending'>,
): HybridDocumentReviewState {
  if (!(path in state.decisions)) return state;
  return { ...state, decisions: { ...state.decisions, [path]: decision } };
}

export function hybridFieldCanAccept(state: HybridDocumentReviewState, path: string): boolean {
  if (path === 'documentType') return false;
  if (state.validation.issues.some((issue) => issue.blocking && validationDecisionPath(issue.fieldPath) === path)) {
    return false;
  }
  if (path.startsWith('items.')) {
    const index = Number(path.split('.')[1]);
    const item = state.reconciliation.items.find((candidate) => candidate.index === index);
    return !!item &&
      (item.description.aiValue ?? item.description.localValue) !== undefined &&
      (item.quantity.aiValue ?? item.quantity.localValue) !== undefined &&
      (item.unitPrice.aiValue ?? item.unitPrice.localValue) !== undefined &&
      (item.lineTotal.aiValue ?? item.lineTotal.localValue) !== undefined;
  }
  return state.reconciliation.fields[path]?.aiValue !== undefined;
}

export function hybridReviewCanSave(state: HybridDocumentReviewState | null): boolean {
  if (!state) return true;
  return !Object.values(state.decisions).some((decision) => decision === 'pending');
}

function evidenceFromAi<T>(field: ReconciledField<T>): DocumentEvidence<T> | undefined {
  if (field.aiValue === undefined || field.pageIndex === undefined || !field.aiEvidence) return undefined;
  return {
    rawValue: field.aiValue,
    normalizedValue: field.aiValue,
    pageIndex: field.pageIndex,
    sourceLineIds: [],
    sourceLines: [field.aiEvidence],
    evidenceText: field.aiEvidence,
    source: 'ai',
    validationStatus: 'unverified',
    confidenceType: 'unknown',
    reasons: ['accepted_ai_review'],
    requiresReview: false,
    alternatives: [],
  };
}

function withStructuredField(
  structured: StructuredDocumentExtraction | undefined,
  path: string,
  field: ReconciledField<unknown>,
  source: 'ai' | 'manual' = 'ai',
): StructuredDocumentExtraction | undefined {
  if (!structured) return structured;
  const evidence = source === 'manual' ? evidenceFromManual(field) : evidenceFromAi(field);
  if (!evidence) return structured;
  if (path === 'issuerName') return { ...structured, issuer: { ...(structured.issuer ?? { role: 'issuer', conflicts: [], requiresReview: false }), name: evidence as DocumentEvidence<string> } };
  if (path === 'customerName') return { ...structured, customer: { ...(structured.customer ?? { role: 'customer', conflicts: [], requiresReview: false }), name: evidence as DocumentEvidence<string> } };
  if (path === 'recipientName') return { ...structured, recipient: { ...(structured.recipient ?? { role: 'recipient', conflicts: [], requiresReview: false }), name: evidence as DocumentEvidence<string> } };
  if (path === 'prospectName') return { ...structured, prospect: { ...(structured.prospect ?? { role: 'prospect', conflicts: [], requiresReview: false }), name: evidence as DocumentEvidence<string> } };
  if (path === 'issuerLegalForm') return { ...structured, issuer: { ...(structured.issuer ?? { role: 'issuer', conflicts: [], requiresReview: false }), legalForm: evidence as DocumentEvidence<string> } };
  if (path === 'issuerAddress') return { ...structured, issuer: { ...(structured.issuer ?? { role: 'issuer', conflicts: [], requiresReview: false }), address: { ...structured.issuer?.address, full: evidence as DocumentEvidence<string> } } };
  if (path === 'customerAddress') return { ...structured, customer: { ...(structured.customer ?? { role: 'customer', conflicts: [], requiresReview: false }), address: { ...structured.customer?.address, full: evidence as DocumentEvidence<string> } } };
  if (path === 'recipientAddress') return { ...structured, recipient: { ...(structured.recipient ?? { role: 'recipient', conflicts: [], requiresReview: false }), address: { ...structured.recipient?.address, full: evidence as DocumentEvidence<string> } } };
  if (path === 'issuerVatNumber' || path === 'issuerTaxCode' || path === 'issuerRegistrationNumber') {
    const key = path === 'issuerVatNumber' ? 'vatNumber' : path === 'issuerTaxCode' ? 'taxCode' : 'registrationNumber';
    return { ...structured, issuer: { ...(structured.issuer ?? { role: 'issuer', conflicts: [], requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'customerVatNumber' || path === 'customerTaxCode') {
    const key = path === 'customerVatNumber' ? 'vatNumber' : 'taxCode';
    return { ...structured, customer: { ...(structured.customer ?? { role: 'customer', conflicts: [], requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'issuerIban') return { ...structured, issuer: { ...(structured.issuer ?? { role: 'issuer', conflicts: [], requiresReview: false }), iban: evidence as DocumentEvidence<string> } };
  if (path === 'customerIban') return { ...structured, customer: { ...(structured.customer ?? { role: 'customer', conflicts: [], requiresReview: false }), iban: evidence as DocumentEvidence<string> } };
  if (path === 'conditionsIban') return { ...structured, conditions: { ...structured.conditions, iban: evidence as DocumentEvidence<string> } };
  if (path === 'vehicleKilometers') return { ...structured, vehicle: { ...(structured.vehicle ?? { requiresReview: false }), kilometers: evidence as DocumentEvidence<number> } };
  if (path.startsWith('vehicle')) {
    const key = ({ vehicleMake: 'make', vehicleModel: 'model', vehiclePlate: 'plate', vehicleVin: 'vin', vehicleRegistrationDate: 'registrationDate', vehicleEngine: 'engine' } as const)[path as 'vehicleMake'];
    if (key) return { ...structured, vehicle: { ...(structured.vehicle ?? { requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path.startsWith('project')) {
    const key = ({ projectName: 'name', projectReference: 'reference', projectOffice: 'office' } as const)[path as 'projectName'];
    if (key) return { ...structured, project: { ...(structured.project ?? { requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'deliveryDate' || path === 'deliveryRecipient' || path === 'deliveryAddress') {
    const key = path === 'deliveryDate' ? 'date' : path === 'deliveryRecipient' ? 'recipient' : 'address';
    return { ...structured, delivery: { ...(structured.delivery ?? { requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'shippingTerms' || path === 'shippingCarrier') {
    const key = path === 'shippingTerms' ? 'terms' : 'carrier';
    return { ...structured, shipping: { ...(structured.shipping ?? { requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'bankName' || path === 'bankBranch' || path === 'bankBic' || path === 'bankIban') {
    const key = ({ bankName: 'bankName', bankBranch: 'branch', bankBic: 'bic', bankIban: 'iban' } as const)[path];
    return { ...structured, bank: { ...(structured.bank ?? { ownerRole: 'unknown', requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'paCup' || path === 'paCig' || path === 'paEntityReference' || path === 'paOffice') {
    const key = ({ paCup: 'cup', paCig: 'cig', paEntityReference: 'entityReference', paOffice: 'office' } as const)[path];
    return { ...structured, publicAdministrationData: { ...(structured.publicAdministrationData ?? { requiresReview: false }), [key]: evidence as DocumentEvidence<string> } };
  }
  if (path === 'taxSummaries' && Array.isArray(field.aiValue)) {
    const taxSummaries = (field.aiValue as ReconciledTaxSummaryValue[]).map((entry) => {
      const scalar = <T>(value: T | undefined): DocumentEvidence<T> | undefined => value === undefined ? undefined : evidenceFromAi({ ...field, aiValue: value, pageIndex: entry.pageIndex } as ReconciledField<T>);
      return {
        ...(scalar(entry.vatRate) ? { vatRate: scalar(entry.vatRate) } : {}),
        ...(scalar(entry.vatNature) ? { vatNature: scalar(entry.vatNature) } : {}),
        ...(scalar(entry.taxableAmount) ? { taxableAmount: scalar(entry.taxableAmount) } : {}),
        ...(scalar(entry.vatAmount) ? { vatAmount: scalar(entry.vatAmount) } : {}),
        pageIndex: entry.pageIndex,
        requiresReview: false,
      };
    });
    return { ...structured, summary: { ...structured.summary, taxSummaries } };
  }
  if (['paymentTerms', 'deliveryTerms', 'shippingTerms', 'notes', 'bankDetails'].includes(path)) return { ...structured, conditions: { ...structured.conditions, [path]: evidence } };
  if (['documentNumber', 'internalReference', 'customerReference', 'issueDate', 'dueDate', 'validityDate', 'currency', 'subject', 'references', 'cup', 'cig', 'pageCount'].includes(path)) return { ...structured, metadata: { ...structured.metadata, [path]: evidence } };
  if (['materialTotal', 'laborTotal', 'externalWorkTotal', 'subtotal', 'taxableAmount', 'discountTotal', 'shippingCost', 'logisticsContribution', 'additionalCharges', 'vatAmount', 'total', 'deposit', 'balance'].includes(path)) return { ...structured, summary: { ...structured.summary, [path]: evidence } };
  return structured;
}

const NUMERIC_MANUAL_PATHS = new Set([
  'pageCount',
  'vehicleKilometers',
  'materialTotal',
  'laborTotal',
  'externalWorkTotal',
  'subtotal',
  'taxableAmount',
  'discountTotal',
  'shippingCost',
  'logisticsContribution',
  'additionalCharges',
  'vatAmount',
  'total',
  'deposit',
  'balance',
  'quantity',
  'unitPrice',
  'discount',
  'vatRate',
  'lineTotal',
]);

function parseManualNumber(rawValue: unknown): number | undefined {
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : undefined;
  const raw = String(rawValue ?? '').trim();
  if (!raw) return undefined;
  let normalized = raw.replace(/\s+/g, '');
  if (normalized.includes(',') && normalized.includes('.')) {
    if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coerceManualValue(path: string, rawValue: unknown, exemplar: unknown): unknown {
  if (typeof exemplar === 'number' || NUMERIC_MANUAL_PATHS.has(path)) {
    return parseManualNumber(rawValue);
  }
  if (typeof exemplar === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    const normalized = String(rawValue ?? '').trim().toLowerCase();
    if (['true', '1', 'yes', 'si', 'sì'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    return undefined;
  }
  return String(rawValue ?? '').trim();
}

function manualField<T>(field: ReconciledField<T>, path: string, rawValue: unknown): ReconciledField<T> {
  const exemplar = field.selectedValue ?? field.localValue ?? field.aiValue;
  const value = coerceManualValue(path, rawValue, exemplar) as T | undefined;
  return {
    ...field,
    ...(value !== undefined ? { selectedValue: value } : {}),
    selectedSource: 'manual',
    requiresReview: false,
    reasons: [...field.reasons.filter((reason) => reason !== 'manual_value_precedence'), 'manual_value_precedence'],
  };
}

export function setHybridManualValue(
  state: HybridDocumentReviewState,
  path: string,
  rawValue: unknown,
): HybridDocumentReviewState {
  if (!(path in state.decisions)) return state;
  if (path.startsWith('items.')) {
    const index = Number(path.split('.')[1]);
    if (!Number.isInteger(index) || !rawValue || typeof rawValue !== 'object') return state;
    const raw = rawValue as Record<string, unknown>;
    const items = state.reconciliation.items.map((item) => {
      if (item.index !== index) return item;
      const update = <T>(key: string, candidate: ReconciledField<T>): ReconciledField<T> =>
        Object.prototype.hasOwnProperty.call(raw, key)
          ? manualField(candidate, key, raw[key])
          : candidate;
      return {
        ...item,
        itemCode: update('itemCode', item.itemCode),
        description: update('description', item.description),
        quantity: update('quantity', item.quantity),
        unit: update('unit', item.unit),
        unitPrice: update('unitPrice', item.unitPrice),
        discount: update('discount', item.discount),
        discountType: update('discountType', item.discountType),
        taxableAmount: update('taxableAmount', item.taxableAmount),
        vatRate: update('vatRate', item.vatRate),
        vatNature: update('vatNature', item.vatNature),
        vatIncluded: update('vatIncluded', item.vatIncluded),
        lineTotal: update('lineTotal', item.lineTotal),
        currency: update('currency', item.currency),
        requiresReview: false,
      };
    });
    return {
      ...state,
      reconciliation: { ...state.reconciliation, items },
      decisions: { ...state.decisions, [path]: 'manual' },
    };
  }
  const field = state.reconciliation.fields[path];
  if (!field) return state;
  return {
    ...state,
    reconciliation: {
      ...state.reconciliation,
      fields: { ...state.reconciliation.fields, [path]: manualField(field, path, rawValue) },
    },
    decisions: { ...state.decisions, [path]: 'manual' },
  };
}

function evidenceFromManual<T>(field: ReconciledField<T>): DocumentEvidence<T> | undefined {
  if (field.selectedSource !== 'manual' || field.selectedValue === undefined) return undefined;
  return {
    rawValue: field.selectedValue,
    normalizedValue: field.selectedValue,
    pageIndex: field.pageIndex ?? 0,
    sourceLineIds: [],
    sourceLines: [],
    evidenceText: 'manual_user_edit',
    source: 'user',
    validationStatus: 'unverified',
    confidenceType: 'unknown',
    reasons: ['manual_user_edit'],
    requiresReview: false,
    alternatives: [],
  };
}

function applyResolvedHybridField(
  current: AnyDocument,
  reconciliation: HybridDocumentReconciliation,
  path: string,
  source: 'ai' | 'manual',
): AnyDocument {
  if (current.type === 'business_card') return current;
  if (path.startsWith('items.')) {
    const index = Number(path.split('.')[1]);
    if (!Number.isInteger(index) || index < 0 || !('items' in current)) return current;
    const reconciled = reconciliation.items.find((item) => item.index === index);
    if (!reconciled) return current;
    const targetIndex = reconciled.localIndex ?? current.items.length;
    const previous = current.items[targetIndex];
    const description = (source === 'manual' ? reconciled.description.selectedValue : reconciled.description.aiValue) ?? previous?.description;
    const quantity = (source === 'manual' ? reconciled.quantity.selectedValue : reconciled.quantity.aiValue) ?? previous?.quantity;
    const unitPrice = (source === 'manual' ? reconciled.unitPrice.selectedValue : reconciled.unitPrice.aiValue) ?? previous?.unitPrice;
    const total = (source === 'manual' ? reconciled.lineTotal.selectedValue : reconciled.lineTotal.aiValue) ?? previous?.total;
    if (description === undefined || quantity === undefined || unitPrice === undefined || total === undefined) return current;
    const resolvedVatRate = source === 'manual' ? reconciled.vatRate.selectedValue : reconciled.vatRate.aiValue;
    const proposedItem = { description, quantity, unitPrice, total, ...(resolvedVatRate !== undefined ? { vatRate: resolvedVatRate } : previous?.vatRate !== undefined ? { vatRate: previous.vatRate } : {}) };
    const items = [...current.items];
    items[targetIndex] = proposedItem;
    const currentStructured = current.structuredExtraction;
    let structuredExtraction = currentStructured;
    if (currentStructured) {
      const previousStructured = currentStructured.items[reconciled.localIndex ?? targetIndex];
      const evidence = <T>(candidate: ReconciledField<T>, fallback: DocumentEvidence<T> | undefined) => (source === 'manual' ? evidenceFromManual(candidate) : evidenceFromAi(candidate)) ?? fallback;
      const sourceLines = [...new Set([
        ...(previousStructured?.sourceLines ?? []),
        ...[reconciled.itemCode, reconciled.description, reconciled.quantity, reconciled.unit, reconciled.unitPrice, reconciled.discount, reconciled.discountType, reconciled.taxableAmount, reconciled.vatRate, reconciled.vatNature, reconciled.vatIncluded, reconciled.lineTotal, reconciled.currency]
          .flatMap((candidate) => source === 'ai' && candidate.aiEvidence ? [candidate.aiEvidence] : []),
      ])];
      const structuredItems = [...currentStructured.items];
      structuredItems[targetIndex] = {
        ...(previousStructured ?? { pageIndex: reconciled.description.pageIndex ?? 0, sourceLineIds: [], sourceLines: [], requiresReview: false }),
        itemCode: evidence(reconciled.itemCode, previousStructured?.itemCode),
        description: evidence(reconciled.description, previousStructured?.description),
        quantity: evidence(reconciled.quantity, previousStructured?.quantity),
        unit: evidence(reconciled.unit, previousStructured?.unit),
        unitPrice: evidence(reconciled.unitPrice, previousStructured?.unitPrice),
        discount: evidence(reconciled.discount, previousStructured?.discount),
        discountType: evidence(reconciled.discountType, previousStructured?.discountType),
        taxableAmount: evidence(reconciled.taxableAmount, previousStructured?.taxableAmount),
        vatRate: evidence(reconciled.vatRate, previousStructured?.vatRate),
        vatNature: evidence(reconciled.vatNature, previousStructured?.vatNature),
        vatIncluded: evidence(reconciled.vatIncluded, previousStructured?.vatIncluded),
        lineTotal: evidence(reconciled.lineTotal, previousStructured?.lineTotal),
        currency: evidence(reconciled.currency, previousStructured?.currency),
        sourceLines,
        requiresReview: false,
      };
      structuredExtraction = { ...currentStructured, items: structuredItems };
    }
    return { ...current, items, structuredExtraction } as AnyDocument;
  }
  const field = reconciliation.fields[path];
  const resolvedValue = source === 'manual' ? field?.selectedValue : field?.aiValue;
  if (!field || resolvedValue === undefined) return current;
  const structuredExtraction = withStructuredField(current.structuredExtraction, path, field, source);
  if (current.type === 'free_document') {
    if (path === 'documentNumber') return { ...current, documentNumber: String(resolvedValue), structuredExtraction };
    if (path === 'issueDate') return { ...current, documentDate: new Date(String(resolvedValue)), structuredExtraction };
    return structuredExtraction === current.structuredExtraction ? current : { ...current, structuredExtraction };
  }
  const numberKey = current.type === 'quote' ? 'quoteNumber' : current.type === 'invoice' ? 'invoiceNumber' : 'orderNumber';
  const dateKey = current.type === 'quote' ? 'quoteDate' : current.type === 'invoice' ? 'invoiceDate' : 'orderDate';
  const mapping: Record<string, string> = {
    documentNumber: numberKey, issueDate: dateKey, customerName: 'customerName',
    subtotal: 'subtotal', vatAmount: 'vatAmount', total: 'total', currency: 'currency', customerVatNumber: 'customerVat',
  };
  if (path === 'validityDate' && current.type === 'quote') return { ...current, validUntil: new Date(String(resolvedValue)), structuredExtraction };
  if (path === 'dueDate' && current.type === 'order') return { ...current, deliveryDate: new Date(String(resolvedValue)), structuredExtraction };
  const key = mapping[path];
  if (!key) return structuredExtraction === current.structuredExtraction ? current : { ...current, structuredExtraction } as AnyDocument;
  const value = path === 'issueDate' ? new Date(String(resolvedValue)) : field.aiValue;
  return { ...current, [key]: value, structuredExtraction } as AnyDocument;
}

export function applyAcceptedHybridField(
  current: AnyDocument,
  reconciliation: HybridDocumentReconciliation,
  path: string,
): AnyDocument {
  return applyResolvedHybridField(current, reconciliation, path, 'ai');
}

export function applyManualHybridField(
  current: AnyDocument,
  reconciliation: HybridDocumentReconciliation,
  path: string,
): AnyDocument {
  return applyResolvedHybridField(current, reconciliation, path, 'manual');
}

export function materializeAcceptedHybridDocument(
  base: AnyDocument,
  state: HybridDocumentReviewState,
): AnyDocument {
  return Object.entries(state.decisions).reduce((document, [path, decision]) => {
    if (decision === 'accepted') return applyAcceptedHybridField(document, state.reconciliation, path);
    if (decision === 'manual') return applyManualHybridField(document, state.reconciliation, path);
    return document;
  }, base);
}
