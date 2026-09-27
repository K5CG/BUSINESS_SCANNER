import type { AnyDocument, Address, OrderItem, QuoteItem } from '../types';
import type {
  DocumentFieldReliability,
  DocumentFieldValidationStatus,
  DocumentReliabilityFieldKey,
} from './document-field-reliability';
import type { DocumentUserEditableField } from './document-field-merge-application';
import type { DocumentEvidence, StructuredLineItem } from './document-structure';

export type DocumentDetailSectionId =
  | 'document'
  | 'issuer'
  | 'customer'
  | 'amounts'
  | 'items'
  | 'conditions'
  | 'vehicle'
  | 'shipping'
  | 'project'
  | 'delivery'
  | 'bank'
  | 'publicAdministration'
  | 'other';

export interface DocumentDetailField {
  id: string;
  labelKey: string;
  value: string;
  editableField?: DocumentUserEditableField;
  requiresReview: boolean;
  conflict: boolean;
  sourcePage?: number;
}

export interface DocumentDetailItem {
  id: string;
  fields: Array<{ labelKey: string; value: string }>;
  requiresReview: boolean;
  conflict: boolean;
}

export interface DocumentDetailSection {
  id: DocumentDetailSectionId;
  titleKey: string;
  fields: DocumentDetailField[];
  items: DocumentDetailItem[];
}

export interface DocumentReviewAlert {
  id: DocumentReliabilityFieldKey;
  labelKey: string;
  conflict: boolean;
  sourcePage?: number;
  validationStatus?: DocumentFieldValidationStatus;
  alternatives: string[];
}

export interface DocumentDetailsViewModel {
  sections: DocumentDetailSection[];
  reviewAlerts: DocumentReviewAlert[];
}

const RELIABILITY_LABELS: Record<DocumentReliabilityFieldKey, string> = {
  documentNumber: 'documentDetailsNumber',
  customerName: 'documentDetailsCustomer',
  date: 'documentDetailsDate',
  vatNumber: 'documentDetailsCustomerVat',
  subtotal: 'documentDetailsSubtotal',
  vatAmount: 'documentDetailsVat',
  total: 'documentDetailsTotal',
  currency: 'documentDetailsCurrency',
  items: 'documentDetailsItems',
  extractedFields: 'documentDetailsOtherFields',
};

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function finiteNumber(value: unknown, locale: string): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
}

function validDate(value: unknown, locale: string): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(value);
}

function formattedAddress(address: Address | undefined): string | undefined {
  if (!address) return undefined;
  const full = nonEmptyText(address.full);
  if (full) return full;
  const street = [nonEmptyText(address.street), nonEmptyText(address.civicNumber)]
    .filter(Boolean)
    .join(' ');
  const locality = [
    nonEmptyText(address.postalCode),
    nonEmptyText(address.city),
    nonEmptyText(address.region),
  ]
    .filter(Boolean)
    .join(' ');
  const value = [street, locality, nonEmptyText(address.country)]
    .filter(Boolean)
    .join(', ');
  return value || undefined;
}

function reliabilityFor(
  document: AnyDocument,
  key?: DocumentReliabilityFieldKey
): DocumentFieldReliability | undefined {
  return key ? document.fieldReliability?.[key] : undefined;
}

function field(
  document: AnyDocument,
  id: string,
  labelKey: string,
  value: string | undefined,
  reliabilityKey?: DocumentReliabilityFieldKey,
  editableField?: DocumentUserEditableField
): DocumentDetailField | undefined {
  const reliability = reliabilityFor(document, reliabilityKey);
  const rejectedUserAlternative = editableField
    ? [...(reliability?.alternatives ?? [])]
        .reverse()
        .find(
          (alternative) =>
            alternative.source === 'user' &&
            (alternative.validationStatus === 'invalid' ||
              alternative.validationStatus === 'ambiguous')
        )
    : undefined;
  const rejectedUserValue =
    nonEmptyText(rejectedUserAlternative?.rawValue) ??
    nonEmptyText(rejectedUserAlternative?.value) ??
    (typeof rejectedUserAlternative?.rawValue === 'number' &&
    Number.isFinite(rejectedUserAlternative.rawValue)
      ? String(rejectedUserAlternative.rawValue)
      : undefined);
  const rawValue = reliability?.rawValue;
  const reviewValue =
    nonEmptyText(rawValue) ??
    (typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? String(rawValue)
      : undefined);
  const displayValue = rejectedUserValue || value || reviewValue;
  if (!displayValue) return undefined;
  return {
    id,
    labelKey,
    value: displayValue,
    ...(editableField ? { editableField } : {}),
    requiresReview: reliability?.requiresReview ?? false,
    conflict: reliability?.conflict ?? false,
    ...(reliability?.pageIndex !== undefined
      ? { sourcePage: reliability.pageIndex + 1 }
      : {}),
  };
}

function compactFields(
  values: Array<DocumentDetailField | undefined>
): DocumentDetailField[] {
  return values.filter((value): value is DocumentDetailField => !!value);
}

function evidenceField<T>(
  id: string,
  labelKey: string,
  evidence: DocumentEvidence<T> | undefined,
  format: (value: T) => string | undefined = (value) => nonEmptyText(value),
): DocumentDetailField | undefined {
  if (!evidence || evidence.normalizedValue === undefined) return undefined;
  const value = format(evidence.normalizedValue);
  if (!value) return undefined;
  return {
    id,
    labelKey,
    value,
    requiresReview: evidence.requiresReview,
    conflict: evidence.conflict ?? false,
    sourcePage: evidence.pageIndex + 1,
  };
}

function structuredItemViewModel(
  item: StructuredLineItem,
  index: number,
  locale: string,
): DocumentDetailItem | undefined {
  const text = (value: DocumentEvidence<string> | undefined) => value?.normalizedValue?.trim() || undefined;
  const number = (value: DocumentEvidence<number> | undefined) => finiteNumber(value?.normalizedValue, locale);
  const fields = [
    { labelKey: 'documentDetailsItemCode', value: text(item.itemCode) },
    { labelKey: 'documentDetailsDescription', value: text(item.description) },
    { labelKey: 'documentDetailsQuantity', value: number(item.quantity) },
    { labelKey: 'documentDetailsUnit', value: text(item.unit) },
    { labelKey: 'documentDetailsUnitPrice', value: number(item.unitPrice) },
    { labelKey: 'documentDetailsDiscount', value: number(item.discount) },
    { labelKey: 'documentDetailsTaxableAmount', value: number(item.taxableAmount) },
    { labelKey: 'documentDetailsVatRate', value: number(item.vatRate) },
    { labelKey: 'documentDetailsLineTotal', value: number(item.lineTotal) },
  ].filter((entry): entry is { labelKey: string; value: string } => !!entry.value);
  if (!fields.length) return undefined;
  return {
    id: `structured-item-${index}`,
    fields,
    requiresReview: item.requiresReview,
    conflict: [item.quantity, item.unitPrice, item.lineTotal].some((entry) => entry?.conflict),
  };
}

function itemViewModel(
  item: QuoteItem | OrderItem,
  index: number,
  locale: string,
  reliability: DocumentFieldReliability | undefined
): DocumentDetailItem | undefined {
  const fields = [
    { labelKey: 'documentDetailsDescription', value: nonEmptyText(item.description) },
    { labelKey: 'documentDetailsQuantity', value: finiteNumber(item.quantity, locale) },
    { labelKey: 'documentDetailsUnitPrice', value: finiteNumber(item.unitPrice, locale) },
    { labelKey: 'documentDetailsVatRate', value: finiteNumber(item.vatRate, locale) },
    { labelKey: 'documentDetailsLineTotal', value: finiteNumber(item.total, locale) },
  ].filter((entry): entry is { labelKey: string; value: string } => !!entry.value);
  if (!fields.length) return undefined;
  return {
    id: `item-${index}`,
    fields,
    requiresReview: reliability?.requiresReview ?? false,
    conflict: reliability?.conflict ?? false,
  };
}

function section(
  id: DocumentDetailSectionId,
  titleKey: string,
  fields: DocumentDetailField[] = [],
  items: DocumentDetailItem[] = []
): DocumentDetailSection | undefined {
  return fields.length || items.length ? { id, titleKey, fields, items } : undefined;
}

function reviewAlerts(document: AnyDocument): DocumentReviewAlert[] {
  return (Object.entries(document.fieldReliability ?? {}) as Array<
    [DocumentReliabilityFieldKey, DocumentFieldReliability]
  >)
    .filter(([, reliability]) => reliability.requiresReview || reliability.conflict)
    .map(([id, reliability]) => ({
      id,
      labelKey: RELIABILITY_LABELS[id],
      conflict: reliability.conflict,
      validationStatus: reliability.validationStatus,
      alternatives: reliability.alternatives
        .map((alternative) =>
          nonEmptyText(alternative.rawValue) ??
          nonEmptyText(alternative.value) ??
          (typeof alternative.value === 'number' && Number.isFinite(alternative.value)
            ? String(alternative.value)
            : undefined)
        )
        .filter((value): value is string => !!value)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 3),
      ...(reliability.pageIndex !== undefined
        ? { sourcePage: reliability.pageIndex + 1 }
        : {}),
    }));
}

function additionalStructuredFields(
  document: Exclude<AnyDocument, { type: 'business_card' }>
): DocumentDetailField[] {
  const reliability = document.fieldReliability?.extractedFields;
  const candidates: Array<{
    key: string;
    value: string;
    sourcePage?: number;
  }> = [];
  const reliabilityValue = reliability?.value;
  const extractedFieldGroups = document.fieldMerge?.extractedFieldGroups ?? [];
  if (
    extractedFieldGroups.length === 0 &&
    reliabilityValue &&
    typeof reliabilityValue === 'object' &&
    !Array.isArray(reliabilityValue)
  ) {
    for (const [key, value] of Object.entries(reliabilityValue)) {
      const normalizedKey = nonEmptyText(key);
      const normalizedValue = nonEmptyText(value);
      if (normalizedKey && normalizedValue) {
        candidates.push({ key: normalizedKey, value: normalizedValue });
      }
    }
  }
  for (const group of extractedFieldGroups) {
    for (const [key, value] of Object.entries(group.value)) {
      const normalizedKey = nonEmptyText(key);
      const normalizedValue = nonEmptyText(value);
      if (normalizedKey && normalizedValue) {
        candidates.push({
          key: normalizedKey,
          value: normalizedValue,
          sourcePage: group.sourcePageIndex + 1,
        });
      }
    }
  }

  const seen = new Set<string>();
  return candidates.flatMap((candidate, index) => {
    const identity = `${candidate.key.toLocaleLowerCase()}\u0000${candidate.value}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      id: `structured:${index}:${candidate.key}`,
      labelKey: candidate.key,
      value: candidate.value,
      requiresReview: reliability?.requiresReview ?? true,
      conflict: reliability?.conflict ?? false,
      ...(candidate.sourcePage ? { sourcePage: candidate.sourcePage } : {}),
    }];
  });
}

export function buildDocumentDetailsViewModel(
  document: Exclude<AnyDocument, { type: 'business_card' }>,
  locale = 'it-IT'
): DocumentDetailsViewModel {
  const sections: Array<DocumentDetailSection | undefined> = [];

  if (
    document.type === 'quote' ||
    document.type === 'order' ||
    document.type === 'invoice'
  ) {
    const isQuote = document.type === 'quote';
    const isOrder = document.type === 'order';
    const number =
      document.type === 'quote'
        ? document.quoteNumber
        : document.type === 'order'
          ? document.orderNumber
          : document.invoiceNumber;
    const date =
      document.type === 'quote'
        ? document.quoteDate
        : document.type === 'order'
          ? document.orderDate
          : document.invoiceDate;
    const dueDate =
      document.type === 'quote'
        ? document.validUntil
        : document.type === 'order'
          ? document.deliveryDate
          : document.dueDate;
    const itemsReliability = reliabilityFor(document, 'items');
    const items = document.items
      .map((value, index) => itemViewModel(value, index, locale, itemsReliability))
      .filter((value): value is DocumentDetailItem => !!value);
    const structured = document.structuredExtraction;
    const structuredItems = (structured?.items ?? [])
      .map((value, index) => structuredItemViewModel(value, index, locale))
      .filter((value): value is DocumentDetailItem => !!value);
    const displayedItems = structuredItems.length > 0 ? structuredItems : items;
    const extraFields = additionalStructuredFields(document);
    const customer = structured?.customer;
    const recipient = structured?.recipient;
    const prospect = structured?.prospect;
    const numberText = (value: number) => finiteNumber(value, locale);

    sections.push(
      section(
        'document',
        'documentDetailsMainSection',
        compactFields([
          field(document, 'number', 'documentDetailsNumber', nonEmptyText(number), 'documentNumber', 'documentNumber'),
          field(document, 'date', 'documentDetailsDate', validDate(date, locale), 'date', 'date'),
          field(
            document,
            'dueDate',
            document.type === 'quote'
              ? 'documentDetailsValidUntil'
              : document.type === 'invoice'
                ? 'documentDetailsDueDate'
                : 'documentDetailsDeliveryDate',
            validDate(dueDate, locale)
          ),
          field(document, 'currency', 'documentDetailsCurrency', nonEmptyText(document.currency), 'currency', 'currency'),
          evidenceField('internalReference', 'documentHybridField_internalReference', structured?.metadata.internalReference),
          evidenceField('customerReference', 'documentHybridField_customerReference', structured?.metadata.customerReference),
        ])
      ),
      section(
        'issuer',
        'documentDetailsIssuerSection',
        compactFields([
          evidenceField('issuerName', 'documentDetailsIssuer', structured?.issuer?.name),
          evidenceField('issuerAddress', 'documentDetailsAddress', structured?.issuer?.address?.full),
          evidenceField('issuerVat', 'documentDetailsVatNumber', structured?.issuer?.vatNumber),
          evidenceField('issuerTaxCode', 'documentDetailsTaxCode', structured?.issuer?.taxCode),
          evidenceField('issuerEmail', 'email', structured?.issuer?.email),
          evidenceField('issuerPhone', 'phone', structured?.issuer?.phone),
          evidenceField('issuerWebsite', 'website', structured?.issuer?.website),
          evidenceField('issuerContactPerson', 'documentDetailsContactPerson', structured?.issuer?.contactPerson),
          evidenceField('issuerIban', 'documentDetailsIban', structured?.issuer?.iban),
          evidenceField('issuerBic', 'documentDetailsBic', structured?.issuer?.bic),
        ])
      ),
      section(
        'customer',
        'documentDetailsCustomerSection',
        compactFields([
          field(document, 'customer', isQuote ? 'documentDetailsRecipient' : 'documentDetailsCustomer', nonEmptyText(document.customerName), 'customerName', 'customerName'),
          field(document, 'customerVat', 'documentDetailsCustomerVat', nonEmptyText(document.customerVat), 'vatNumber', 'vatNumber'),
          !isOrder
            ? undefined
            : field(document, 'shippingAddress', 'documentDetailsShippingAddress', formattedAddress(document.shippingAddress)),
          evidenceField('structuredCustomerName', 'documentDetailsCustomer', customer?.name),
          evidenceField('customerAddress', 'documentDetailsAddress', customer?.address?.full),
          evidenceField('billingAddress', 'documentDetailsBillingAddress', customer?.billingAddress?.full),
          evidenceField('structuredShippingAddress', 'documentDetailsShippingAddress', customer?.shippingAddress?.full),
          evidenceField('customerEmail', 'email', customer?.email),
          evidenceField('customerPhone', 'phone', customer?.phone),
          evidenceField('recipientName', 'documentDetailsRecipient', recipient?.name),
          evidenceField('recipientAddress', 'documentDetailsRecipientAddress', recipient?.address?.full),
          evidenceField('prospectName', 'documentDetailsProspect', prospect?.name),
          evidenceField('prospectAddress', 'documentDetailsProspectAddress', prospect?.address?.full),
        ])
      ),
      section(
        'amounts',
        'documentDetailsAmountsSection',
        compactFields([
          field(document, 'subtotal', 'documentDetailsSubtotal', finiteNumber(document.subtotal, locale), 'subtotal', 'subtotal'),
          field(document, 'vatAmount', 'documentDetailsVat', finiteNumber(document.vatAmount, locale), 'vatAmount', 'vatAmount'),
          field(document, 'total', 'documentDetailsTotal', finiteNumber(document.total, locale), 'total', 'total'),
          evidenceField('discountTotal', 'documentDetailsDiscountTotal', structured?.summary.discountTotal, numberText),
          evidenceField('shippingCost', 'documentDetailsShippingCost', structured?.summary.shippingCost, numberText),
          evidenceField('materialTotal', 'documentDetailsMaterialTotal', structured?.summary.materialTotal, numberText),
          evidenceField('laborTotal', 'documentDetailsLaborTotal', structured?.summary.laborTotal, numberText),
          evidenceField('externalWorkTotal', 'documentDetailsExternalWorkTotal', structured?.summary.externalWorkTotal, numberText),
          evidenceField('logisticsContribution', 'documentDetailsLogisticsContribution', structured?.summary.logisticsContribution, numberText),
          evidenceField('additionalCharges', 'documentDetailsAdditionalCharges', structured?.summary.additionalCharges, numberText),
          evidenceField('balance', 'documentDetailsBalance', structured?.summary.balance, numberText),
          ...(structured?.summary.taxSummaries ?? []).flatMap((tax, index) => [
            evidenceField(`taxSummary:${index}:vatRate`, 'documentDetailsTaxSummaryVatRate', tax.vatRate, numberText),
            evidenceField(`taxSummary:${index}:taxableAmount`, 'documentDetailsTaxSummaryTaxable', tax.taxableAmount, numberText),
            evidenceField(`taxSummary:${index}:vatAmount`, 'documentDetailsTaxSummaryVat', tax.vatAmount, numberText),
            evidenceField(`taxSummary:${index}:vatNature`, 'documentDetailsTaxSummaryNature', tax.vatNature),
          ]),
        ])
      ),
      section('items', 'documentDetailsItemsSection', [], displayedItems),
      section(
        'vehicle',
        'documentDetailsVehicleSection',
        compactFields([
          evidenceField('vehicleMake', 'documentDetailsVehicleMake', structured?.vehicle?.make),
          evidenceField('vehicleModel', 'documentDetailsVehicleModel', structured?.vehicle?.model),
          evidenceField('vehiclePlate', 'documentDetailsVehiclePlate', structured?.vehicle?.plate),
          evidenceField('vehicleVin', 'documentDetailsVehicleVin', structured?.vehicle?.vin),
          evidenceField('vehicleRegistrationDate', 'documentDetailsVehicleRegistrationDate', structured?.vehicle?.registrationDate),
          evidenceField('vehicleKilometers', 'documentDetailsVehicleKilometers', structured?.vehicle?.kilometers, numberText),
          evidenceField('vehicleEngine', 'documentDetailsVehicleEngine', structured?.vehicle?.engine),
        ])
      ),
      section(
        'shipping',
        'documentDetailsShippingSection',
        compactFields([
          evidenceField('shippingTerms', 'documentDetailsShippingTerms', structured?.shipping?.terms),
          evidenceField('shippingCarrier', 'documentDetailsShippingCarrier', structured?.shipping?.carrier),
          evidenceField('shippingSectionCost', 'documentDetailsShippingCost', structured?.shipping?.cost, numberText),
        ])
      ),
      section(
        'project',
        'documentDetailsProjectSection',
        compactFields([
          evidenceField('projectName', 'documentDetailsProjectName', structured?.project?.name),
          evidenceField('projectReference', 'documentDetailsProjectReference', structured?.project?.reference),
          evidenceField('projectOffice', 'documentDetailsProjectOffice', structured?.project?.office),
        ])
      ),
      section(
        'delivery',
        'documentDetailsDeliverySection',
        compactFields([
          evidenceField('deliveryDate', 'documentDetailsDeliveryDate', structured?.delivery?.date),
          evidenceField('deliveryTerms', 'documentDetailsDeliveryTerms', structured?.delivery?.terms),
          evidenceField('deliveryRecipient', 'documentDetailsRecipient', structured?.delivery?.recipient),
          evidenceField('deliveryAddress', 'documentDetailsShippingAddress', structured?.delivery?.address),
        ])
      ),
      section(
        'bank',
        'documentDetailsBankSection',
        compactFields([
          evidenceField('bankName', 'documentDetailsBankName', structured?.bank?.bankName),
          evidenceField('bankBranch', 'documentDetailsBankBranch', structured?.bank?.branch),
          evidenceField('bankIban', 'documentDetailsIban', structured?.bank?.iban),
          evidenceField('bankBic', 'documentDetailsBic', structured?.bank?.bic),
        ])
      ),
      section(
        'publicAdministration',
        'documentDetailsPublicAdministrationSection',
        compactFields([
          evidenceField('paCup', 'CUP', structured?.publicAdministrationData?.cup),
          evidenceField('paCig', 'CIG', structured?.publicAdministrationData?.cig),
          evidenceField('paEntityReference', 'documentDetailsEntityReference', structured?.publicAdministrationData?.entityReference),
          evidenceField('paOffice', 'documentDetailsEntityOffice', structured?.publicAdministrationData?.office),
        ])
      ),
      section(
        'conditions',
        'documentDetailsConditionsSection',
        compactFields([
          evidenceField('paymentTerms', 'documentDetailsPaymentTerms', structured?.conditions.paymentTerms),
          evidenceField('deliveryTerms', 'documentDetailsDeliveryTerms', structured?.conditions.deliveryTerms),
          evidenceField('conditionsDeliveryDate', 'documentDetailsDeliveryDate', structured?.conditions.deliveryDate),
          evidenceField('conditionsShippingTerms', 'documentDetailsShippingTerms', structured?.conditions.shippingTerms),
          evidenceField('bankDetails', 'documentDetailsBankDetails', structured?.conditions.bankDetails),
          evidenceField('conditionsIban', 'IBAN', structured?.conditions.iban),
          evidenceField('conditionNotes', 'documentDetailsNotesSection', structured?.conditions.notes),
        ])
      ),
      section('other', 'documentDetailsOtherFieldsSection', compactFields([
        evidenceField('subject', 'documentDetailsSubject', structured?.metadata.subject),
        evidenceField('references', 'documentDetailsReferences', structured?.metadata.references, (value) => value.join(' · ')),
        evidenceField('cup', 'CUP', structured?.metadata.cup),
        evidenceField('cig', 'CIG', structured?.metadata.cig),
        ...extraFields,
      ]))
    );
  } else {
    const structuredSections = document.structuredExtraction
      ? buildDocumentDetailsViewModel({
          ...document,
          type: 'order',
          orderNumber: document.documentNumber,
          orderDate: document.documentDate,
          items: [],
          subtotal: document.structuredExtraction.summary.subtotal?.normalizedValue,
          vatAmount: document.structuredExtraction.summary.vatAmount?.normalizedValue,
          total: document.structuredExtraction.summary.total?.normalizedValue,
          currency: document.structuredExtraction.metadata.currency?.normalizedValue,
        }, locale).sections.filter((entry) => entry.id !== 'document' && entry.id !== 'other')
      : [];
    const extraFields = Object.entries(document.extractedFields ?? {})
      .map(([key, value]) =>
        field(document, `extra:${key}`, key, nonEmptyText(value), 'extractedFields')
      )
      .filter((value): value is DocumentDetailField => !!value);
    sections.push(
      section(
        'document',
        'documentDetailsMainSection',
        compactFields([
          field(document, 'number', 'documentDetailsNumber', nonEmptyText(document.documentNumber), 'documentNumber', 'documentNumber'),
          field(document, 'date', 'documentDetailsDate', validDate(document.documentDate, locale), 'date', 'date'),
          field(document, 'subject', 'documentDetailsSubject', nonEmptyText(document.subject)),
        ])
      ),
      ...structuredSections,
      section('other', 'documentDetailsOtherFieldsSection', extraFields)
    );
  }

  return {
    sections: sections.filter((value): value is DocumentDetailSection => !!value),
    reviewAlerts: reviewAlerts(document),
  };
}
