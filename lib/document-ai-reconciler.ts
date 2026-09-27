import type { AiField, AiLineItem, AiStructuredDocumentExtract } from './document-ai-contract';
import type { DocumentEvidence, StructuredDocumentExtraction, StructuredLineItem } from './document-structure';

export type ReconciliationStatus =
  | 'agreed'
  | 'local_only'
  | 'ai_only'
  | 'conflict'
  | 'invalid'
  | 'missing';

export interface ReconciledField<T> {
  status: ReconciliationStatus;
  localValue?: T;
  aiValue?: T;
  selectedValue?: T;
  selectedSource?: 'local' | 'ai' | 'manual';
  localEvidence?: string[];
  aiEvidence?: string;
  pageIndex?: number;
  aiObservedInOcr?: boolean;
  requiresReview: boolean;
  reasons: string[];
}

export interface ReconciledLineItem {
  index: number;
  localIndex?: number;
  aiIndex?: number;
  itemCode: ReconciledField<string>;
  description: ReconciledField<string>;
  quantity: ReconciledField<number>;
  unit: ReconciledField<string>;
  unitPrice: ReconciledField<number>;
  discount: ReconciledField<number>;
  discountType: ReconciledField<'percentage' | 'amount'>;
  taxableAmount: ReconciledField<number>;
  vatRate: ReconciledField<number>;
  vatNature: ReconciledField<string>;
  vatIncluded: ReconciledField<boolean>;
  lineTotal: ReconciledField<number>;
  currency: ReconciledField<string>;
  requiresReview: boolean;
}

export interface HybridDocumentReconciliation {
  fields: Record<string, ReconciledField<unknown>>;
  items: ReconciledLineItem[];
  requiresReview: boolean;
  conflicts: string[];
}

export interface ReconciledTaxSummaryValue {
  vatRate?: number;
  vatNature?: string;
  taxableAmount?: number;
  vatAmount?: number;
  pageIndex: number;
}

function comparable(value: unknown): string {
  if (typeof value === 'number') return Number(value.toFixed(4)).toString();
  if (Array.isArray(value)) return value.map(comparable).join('|');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${key}:${comparable(entry)}`)
      .join('|');
  }
  return String(value ?? '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function observedInOcr(value: unknown, ocrText: string): boolean {
  const needle = comparable(value);
  if (!needle) return false;
  return comparable(ocrText).includes(needle);
}

export function reconcileDocumentField<T>(input: {
  local?: DocumentEvidence<T>;
  ai?: AiField<T>;
  ocrText: string;
  manualValue?: T;
}): ReconciledField<T> {
  const localValue = input.local?.normalizedValue;
  const aiValue = input.ai?.value;
  const aiObserved = aiValue === undefined ? undefined : observedInOcr(aiValue, input.ocrText);
  const common = {
    ...(localValue !== undefined ? { localValue } : {}),
    ...(aiValue !== undefined ? { aiValue } : {}),
    ...(input.local?.sourceLines.length ? { localEvidence: input.local.sourceLines } : {}),
    ...(input.ai?.evidenceText ? { aiEvidence: input.ai.evidenceText } : {}),
    ...(input.ai?.pageIndex !== undefined ? { pageIndex: input.ai.pageIndex } : input.local?.pageIndex !== undefined ? { pageIndex: input.local.pageIndex } : {}),
    ...(aiObserved !== undefined ? { aiObservedInOcr: aiObserved } : {}),
  };

  if (input.manualValue !== undefined) {
    return { ...common, status: localValue === undefined && aiValue === undefined ? 'missing' : comparable(localValue) === comparable(aiValue) ? 'agreed' : 'conflict', selectedValue: input.manualValue, selectedSource: 'manual', requiresReview: false, reasons: ['manual_value_precedence'] };
  }
  if (localValue === undefined && aiValue === undefined) {
    return { ...common, status: 'missing', requiresReview: false, reasons: ['value_missing'] };
  }
  if (localValue !== undefined && aiValue === undefined) {
    const invalid = input.local?.validationStatus === 'invalid';
    return { ...common, status: invalid ? 'invalid' : 'local_only', ...(invalid ? {} : { selectedValue: localValue, selectedSource: 'local' as const }), requiresReview: invalid || !!input.local?.requiresReview, reasons: [invalid ? 'local_value_invalid' : 'local_value_only'] };
  }
  if (localValue === undefined && aiValue !== undefined) {
    return { ...common, status: 'ai_only', selectedValue: aiValue, selectedSource: 'ai', requiresReview: true, reasons: aiObserved ? ['ai_value_only'] : ['ai_value_only', 'ai_value_not_observed_in_ocr'] };
  }
  if (comparable(localValue) === comparable(aiValue)) {
    return { ...common, status: 'agreed', selectedValue: localValue, selectedSource: 'local', requiresReview: !!input.local?.requiresReview || !!input.ai?.requiresReview, reasons: ['local_ai_agree'] };
  }
  const localStrong = input.local?.validationStatus === 'valid' && input.local.confidenceType !== 'unknown';
  return { ...common, status: 'conflict', ...(localStrong ? { selectedValue: localValue, selectedSource: 'local' as const } : {}), requiresReview: true, reasons: [localStrong ? 'local_labeled_value_stronger' : 'local_ai_conflict', ...(aiObserved === false ? ['ai_value_not_observed_in_ocr'] : [])] };
}

const emptyField = <T>(ocrText: string): ReconciledField<T> =>
  reconcileDocumentField<T>({ ocrText });

function reconcileItem(
  index: number,
  local: StructuredLineItem | undefined,
  ai: AiLineItem | undefined,
  ocrText: string,
  localIndex?: number,
  aiIndex?: number,
): ReconciledLineItem {
  const field = <T>(localField?: DocumentEvidence<T>, aiField?: AiField<T>) =>
    reconcileDocumentField({ local: localField, ai: aiField, ocrText });
  const item: ReconciledLineItem = {
    index,
    ...(localIndex !== undefined ? { localIndex } : {}),
    ...(aiIndex !== undefined ? { aiIndex } : {}),
    itemCode: field(local?.itemCode, ai?.itemCode),
    description: field(local?.description, ai?.description),
    quantity: field(local?.quantity, ai?.quantity),
    unit: field(local?.unit, ai?.unit),
    unitPrice: field(local?.unitPrice, ai?.unitPrice),
    discount: field(local?.discount, ai?.discount),
    discountType: field(local?.discountType, ai?.discountType),
    taxableAmount: field(local?.taxableAmount, ai?.taxableAmount),
    vatRate: field(local?.vatRate, ai?.vatRate),
    vatNature: field(local?.vatNature, ai?.vatNature),
    vatIncluded: field(local?.vatIncluded, ai?.vatIncluded),
    lineTotal: field(local?.lineTotal, ai?.lineTotal),
    currency: field(local?.currency, ai?.currency),
    requiresReview: false,
  };
  item.requiresReview = Object.entries(item).some(([key, value]) => key !== 'index' && key !== 'requiresReview' && (value as ReconciledField<unknown>).requiresReview);
  return item;
}

function itemMatchScore(local: StructuredLineItem, ai: AiLineItem): number {
  const localCode = comparable(local.itemCode?.normalizedValue);
  const aiCode = comparable(ai.itemCode?.value);
  if (localCode && aiCode) return localCode === aiCode ? 100 : -1;
  const localDescription = comparable(local.description?.normalizedValue);
  const aiDescription = comparable(ai.description?.value);
  if (!localDescription || !aiDescription || localDescription !== aiDescription) return -1;
  let score = 50;
  if (comparable(local.quantity?.normalizedValue) === comparable(ai.quantity?.value)) score += 5;
  if (comparable(local.unitPrice?.normalizedValue) === comparable(ai.unitPrice?.value)) score += 5;
  if (comparable(local.lineTotal?.normalizedValue) === comparable(ai.lineTotal?.value)) score += 5;
  return score;
}

function pairItems(localItems: readonly StructuredLineItem[], aiItems: readonly AiLineItem[]) {
  const unusedAi = new Set(aiItems.map((_, index) => index));
  const pairs: Array<{ localIndex?: number; aiIndex?: number }> = [];
  localItems.forEach((local, localIndex) => {
    const candidates = [...unusedAi]
      .map((aiIndex) => ({ aiIndex, score: itemMatchScore(local, aiItems[aiIndex]) }))
      .filter((candidate) => candidate.score >= 50)
      .sort((left, right) => right.score - left.score || left.aiIndex - right.aiIndex);
    const match = candidates[0];
    if (match) {
      unusedAi.delete(match.aiIndex);
      pairs.push({ localIndex, aiIndex: match.aiIndex });
    } else {
      pairs.push({ localIndex });
    }
  });
  [...unusedAi].forEach((aiIndex) => pairs.push({ aiIndex }));
  return pairs;
}

export function reconcileStructuredDocument(input: {
  local: StructuredDocumentExtraction;
  ai?: AiStructuredDocumentExtract;
  ocrText: string;
  manual?: Record<string, unknown>;
}): HybridDocumentReconciliation {
  const { local, ai, ocrText } = input;
  const localTaxValues: ReconciledTaxSummaryValue[] = local.summary.taxSummaries.map((entry) => ({
    ...(entry.vatRate?.normalizedValue !== undefined ? { vatRate: entry.vatRate.normalizedValue } : {}),
    ...(entry.vatNature?.normalizedValue !== undefined ? { vatNature: entry.vatNature.normalizedValue } : {}),
    ...(entry.taxableAmount?.normalizedValue !== undefined ? { taxableAmount: entry.taxableAmount.normalizedValue } : {}),
    ...(entry.vatAmount?.normalizedValue !== undefined ? { vatAmount: entry.vatAmount.normalizedValue } : {}),
    pageIndex: entry.pageIndex,
  }));
  const aiTaxValues: ReconciledTaxSummaryValue[] = (ai?.summary.taxSummaries ?? []).map((entry) => ({
    ...(entry.vatRate?.value !== undefined ? { vatRate: entry.vatRate.value } : {}),
    ...(entry.vatNature?.value !== undefined ? { vatNature: entry.vatNature.value } : {}),
    ...(entry.taxableAmount?.value !== undefined ? { taxableAmount: entry.taxableAmount.value } : {}),
    ...(entry.vatAmount?.value !== undefined ? { vatAmount: entry.vatAmount.value } : {}),
    pageIndex: entry.pageIndex,
  }));
  const localTaxEvidence: DocumentEvidence<ReconciledTaxSummaryValue[]> | undefined = localTaxValues.length > 0 ? {
    rawValue: localTaxValues, normalizedValue: localTaxValues,
    pageIndex: localTaxValues[0].pageIndex,
    sourceLineIds: local.summary.taxSummaries.flatMap((entry) => entry.taxableAmount?.sourceLineIds ?? entry.vatAmount?.sourceLineIds ?? []),
    sourceLines: local.summary.taxSummaries.flatMap((entry) => entry.taxableAmount?.sourceLines ?? entry.vatAmount?.sourceLines ?? []),
    validationStatus: 'unverified', confidenceType: 'unknown', reasons: ['tax_summaries'],
    requiresReview: local.summary.taxSummaries.some((entry) => entry.requiresReview), alternatives: [],
  } : undefined;
  const aiTaxEvidence: AiField<ReconciledTaxSummaryValue[]> | undefined = aiTaxValues.length > 0 ? {
    value: aiTaxValues,
    pageIndex: aiTaxValues[0].pageIndex,
    evidenceText: (ai?.summary.taxSummaries ?? []).flatMap((entry) => [
      entry.vatRate?.evidenceText,
      entry.vatNature?.evidenceText,
      entry.taxableAmount?.evidenceText,
      entry.vatAmount?.evidenceText,
    ].filter((value): value is string => !!value)).join(' | '),
    confidenceType: 'unknown', requiresReview: true, alternatives: [],
  } : undefined;
  const scalar = <T>(key: string, localField?: DocumentEvidence<T>, aiField?: AiField<T>) =>
    reconcileDocumentField({ local: localField, ai: aiField, ocrText, manualValue: input.manual?.[key] as T | undefined });
  const fields: Record<string, ReconciledField<unknown>> = {
    documentType: scalar('documentType', local.metadata.documentType, ai?.document.documentType),
    documentNumber: scalar('documentNumber', local.metadata.documentNumber, ai?.document.documentNumber),
    internalReference: scalar('internalReference', local.metadata.internalReference, ai?.document.internalReference),
    customerReference: scalar('customerReference', local.metadata.customerReference, ai?.document.customerReference),
    issueDate: scalar('issueDate', local.metadata.issueDate, ai?.document.issueDate),
    dueDate: scalar('dueDate', local.metadata.dueDate, ai?.document.dueDate),
    validityDate: scalar('validityDate', local.metadata.validityDate, ai?.document.validityDate),
    currency: scalar('currency', local.metadata.currency ?? local.summary.currency, ai?.document.currency ?? ai?.summary.currency),
    subject: scalar('subject', local.metadata.subject, ai?.document.subject),
    references: scalar('references', local.metadata.references, ai?.document.references),
    cup: scalar('cup', local.metadata.cup, ai?.document.cup),
    cig: scalar('cig', local.metadata.cig, ai?.document.cig),
    pageCount: scalar('pageCount', local.metadata.pageCount, ai?.document.pageCount),
    issuerName: scalar('issuerName', local.issuer?.name, ai?.issuer?.name),
    issuerLegalForm: scalar('issuerLegalForm', local.issuer?.legalForm, ai?.issuer?.legalForm),
    issuerAddress: scalar('issuerAddress', local.issuer?.address?.full, ai?.issuer?.address),
    issuerVatNumber: scalar('issuerVatNumber', local.issuer?.vatNumber, ai?.issuer?.vatNumber),
    issuerTaxCode: scalar('issuerTaxCode', local.issuer?.taxCode, ai?.issuer?.taxCode),
    issuerRegistrationNumber: scalar('issuerRegistrationNumber', local.issuer?.registrationNumber, ai?.issuer?.registrationNumber),
    customerName: scalar('customerName', local.customer?.name ?? local.recipient?.name, ai?.customer?.name ?? ai?.recipient?.name),
    customerAddress: scalar('customerAddress', local.customer?.address?.full ?? local.recipient?.address?.full, ai?.customer?.address ?? ai?.recipient?.address),
    customerVatNumber: scalar('customerVatNumber', local.customer?.vatNumber ?? local.recipient?.vatNumber, ai?.customer?.vatNumber ?? ai?.recipient?.vatNumber),
    customerTaxCode: scalar('customerTaxCode', local.customer?.taxCode ?? local.recipient?.taxCode, ai?.customer?.taxCode ?? ai?.recipient?.taxCode),
    recipientName: scalar('recipientName', local.recipient?.name, ai?.recipient?.name),
    recipientAddress: scalar('recipientAddress', local.recipient?.address?.full, ai?.recipient?.address),
    prospectName: scalar('prospectName', local.prospect?.name, ai?.prospect?.name),
    vehicleMake: scalar('vehicleMake', local.vehicle?.make, ai?.vehicle?.make),
    vehicleModel: scalar('vehicleModel', local.vehicle?.model, ai?.vehicle?.model),
    vehiclePlate: scalar('vehiclePlate', local.vehicle?.plate, ai?.vehicle?.plate),
    vehicleVin: scalar('vehicleVin', local.vehicle?.vin, ai?.vehicle?.vin),
    vehicleRegistrationDate: scalar('vehicleRegistrationDate', local.vehicle?.registrationDate, ai?.vehicle?.registrationDate),
    vehicleKilometers: scalar('vehicleKilometers', local.vehicle?.kilometers, ai?.vehicle?.kilometers),
    vehicleEngine: scalar('vehicleEngine', local.vehicle?.engine, ai?.vehicle?.engine),
    projectName: scalar('projectName', local.project?.name, ai?.project?.name),
    projectReference: scalar('projectReference', local.project?.reference, ai?.project?.reference),
    projectOffice: scalar('projectOffice', local.project?.office, ai?.project?.office),
    deliveryDate: scalar('deliveryDate', local.delivery?.date ?? local.conditions.deliveryDate, ai?.delivery?.date ?? ai?.conditions.deliveryDate),
    deliveryRecipient: scalar('deliveryRecipient', local.delivery?.recipient, ai?.delivery?.recipient),
    deliveryAddress: scalar('deliveryAddress', local.delivery?.address, ai?.delivery?.address),
    shippingTerms: scalar('shippingTerms', local.shipping?.terms ?? local.conditions.shippingTerms, ai?.shipping?.terms ?? ai?.conditions.shippingTerms),
    shippingCarrier: scalar('shippingCarrier', local.shipping?.carrier, ai?.shipping?.carrier),
    subtotal: scalar('subtotal', local.summary.subtotal, ai?.summary.subtotal),
    taxableAmount: scalar('taxableAmount', local.summary.taxableAmount, ai?.summary.taxableAmount),
    discountTotal: scalar('discountTotal', local.summary.discountTotal, ai?.summary.discountTotal),
    shippingCost: scalar('shippingCost', local.summary.shippingCost, ai?.summary.shippingCost),
    materialTotal: scalar('materialTotal', local.summary.materialTotal, ai?.summary.materialTotal),
    laborTotal: scalar('laborTotal', local.summary.laborTotal, ai?.summary.laborTotal),
    externalWorkTotal: scalar('externalWorkTotal', local.summary.externalWorkTotal, ai?.summary.externalWorkTotal),
    logisticsContribution: scalar('logisticsContribution', local.summary.logisticsContribution, ai?.summary.logisticsContribution),
    additionalCharges: scalar('additionalCharges', local.summary.additionalCharges, ai?.summary.additionalCharges),
    vatAmount: scalar('vatAmount', local.summary.vatAmount, ai?.summary.vatAmount),
    total: scalar('total', local.summary.total, ai?.summary.total),
    deposit: scalar('deposit', local.summary.deposit, ai?.summary.deposit),
    balance: scalar('balance', local.summary.balance, ai?.summary.balance),
    taxSummaries: scalar('taxSummaries', localTaxEvidence, aiTaxEvidence),
    paymentTerms: scalar('paymentTerms', local.conditions.paymentTerms, ai?.conditions.paymentTerms),
    deliveryTerms: scalar('deliveryTerms', local.conditions.deliveryTerms, ai?.conditions.deliveryTerms),
    notes: scalar('notes', local.conditions.notes, ai?.conditions.notes),
    bankDetails: scalar('bankDetails', local.conditions.bankDetails, ai?.conditions.bankDetails),
    bankName: scalar('bankName', local.bank?.bankName ?? local.issuer?.bankName, ai?.bank?.bankName ?? ai?.issuer?.bankName),
    bankBranch: scalar('bankBranch', local.bank?.branch, ai?.bank?.branch),
    bankBic: scalar('bankBic', local.bank?.bic ?? local.issuer?.bic, ai?.bank?.bic ?? ai?.issuer?.bic),
    issuerIban: scalar('issuerIban', local.issuer?.iban, ai?.issuer?.iban),
    customerIban: scalar('customerIban', local.customer?.iban, ai?.customer?.iban),
    conditionsIban: scalar('conditionsIban', undefined, ai?.conditions.iban),
    bankIban: scalar('bankIban', local.bank?.iban, ai?.bank?.iban),
    paCup: scalar('paCup', local.publicAdministrationData?.cup, ai?.publicAdministrationData?.cup),
    paCig: scalar('paCig', local.publicAdministrationData?.cig, ai?.publicAdministrationData?.cig),
    paEntityReference: scalar('paEntityReference', local.publicAdministrationData?.entityReference, ai?.publicAdministrationData?.entityReference),
    paOffice: scalar('paOffice', local.publicAdministrationData?.office, ai?.publicAdministrationData?.office),
  };
  const pairs = pairItems(local.items, ai?.items ?? []);
  const items = pairs.map((pair, index) => reconcileItem(
    index,
    pair.localIndex !== undefined ? local.items[pair.localIndex] : undefined,
    pair.aiIndex !== undefined ? ai?.items[pair.aiIndex] : undefined,
    ocrText,
    pair.localIndex,
    pair.aiIndex,
  ));
  const conflicts = Object.entries(fields).flatMap(([key, field]) => field.status === 'conflict' || field.status === 'invalid' ? [key] : []);
  items.forEach((item) => {
    if (item.requiresReview) conflicts.push(`items.${item.index}`);
  });
  return {
    fields,
    items,
    requiresReview: Object.values(fields).some((field) => field.requiresReview) || items.some((item) => item.requiresReview),
    conflicts,
  };
}
