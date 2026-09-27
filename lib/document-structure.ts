import type { DocumentType } from '../types';
import type { CanonicalCommercialDocumentType, DocumentLanguage } from './document-label-dictionary';

export type StructuredDocumentType = Exclude<DocumentType, 'business_card'>;
export type DocumentValidationStatus = 'valid' | 'unverified' | 'ambiguous' | 'invalid' | 'missing';
export type DocumentConfidenceType = 'measured' | 'heuristic' | 'unknown';
export type DocumentEvidenceSource = 'local' | 'ai' | 'user' | 'reconciled';

export interface DocumentBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentEvidence<T> {
  rawValue: unknown;
  normalizedValue?: T;
  pageIndex: number;
  sourceLineIds: string[];
  sourceLines: string[];
  boundingBox?: DocumentBoundingBox;
  evidenceText?: string;
  source?: DocumentEvidenceSource;
  validationStatus: DocumentValidationStatus;
  confidenceType: DocumentConfidenceType;
  reasons: string[];
  requiresReview: boolean;
  alternatives: Array<{
    rawValue: unknown;
    normalizedValue?: T;
    pageIndex: number;
    sourceLineIds: string[];
    reasons: string[];
  }>;
  conflict?: boolean;
}

export interface StructuredAddress {
  full?: DocumentEvidence<string>;
  street?: DocumentEvidence<string>;
  postalCode?: DocumentEvidence<string>;
  city?: DocumentEvidence<string>;
  region?: DocumentEvidence<string>;
  country?: DocumentEvidence<string>;
}

export interface StructuredParty {
  role: 'issuer' | 'customer' | 'recipient' | 'prospect';
  name?: DocumentEvidence<string>;
  legalForm?: DocumentEvidence<string>;
  department?: DocumentEvidence<string>;
  address?: StructuredAddress;
  billingAddress?: StructuredAddress;
  shippingAddress?: StructuredAddress;
  vatNumber?: DocumentEvidence<string>;
  taxCode?: DocumentEvidence<string>;
  registrationNumber?: DocumentEvidence<string>;
  email?: DocumentEvidence<string>;
  phone?: DocumentEvidence<string>;
  website?: DocumentEvidence<string>;
  iban?: DocumentEvidence<string>;
  bic?: DocumentEvidence<string>;
  bankName?: DocumentEvidence<string>;
  contactPerson?: DocumentEvidence<string>;
  conflicts: string[];
  requiresReview: boolean;
}

export interface StructuredDocumentMetadata {
  documentType?: DocumentEvidence<CanonicalCommercialDocumentType>;
  documentNumber?: DocumentEvidence<string>;
  internalReference?: DocumentEvidence<string>;
  customerReference?: DocumentEvidence<string>;
  issueDate?: DocumentEvidence<string>;
  dueDate?: DocumentEvidence<string>;
  validityDate?: DocumentEvidence<string>;
  currency?: DocumentEvidence<string>;
  references?: DocumentEvidence<string[]>;
  cup?: DocumentEvidence<string>;
  cig?: DocumentEvidence<string>;
  subject?: DocumentEvidence<string>;
  pageCount?: DocumentEvidence<number>;
}

export interface StructuredDocumentLanguage {
  detectedLanguages: DocumentLanguage[];
  primaryLanguage?: DocumentLanguage;
  confidence: number;
  mixedLanguage: boolean;
  pages: Array<{
    pageIndex: number;
    detectedLanguages: DocumentLanguage[];
    primaryLanguage?: DocumentLanguage;
    confidence: number;
    mixedLanguage: boolean;
  }>;
}

export interface StructuredVehicleSection {
  make?: DocumentEvidence<string>;
  model?: DocumentEvidence<string>;
  plate?: DocumentEvidence<string>;
  vin?: DocumentEvidence<string>;
  registrationDate?: DocumentEvidence<string>;
  kilometers?: DocumentEvidence<number>;
  engine?: DocumentEvidence<string>;
  requiresReview: boolean;
}

export interface StructuredProjectSection {
  name?: DocumentEvidence<string>;
  reference?: DocumentEvidence<string>;
  office?: DocumentEvidence<string>;
  requiresReview: boolean;
}

export interface StructuredDeliverySection {
  date?: DocumentEvidence<string>;
  terms?: DocumentEvidence<string>;
  recipient?: DocumentEvidence<string>;
  address?: DocumentEvidence<string>;
  requiresReview: boolean;
}

export interface StructuredShippingSection {
  terms?: DocumentEvidence<string>;
  carrier?: DocumentEvidence<string>;
  cost?: DocumentEvidence<number>;
  requiresReview: boolean;
}

export interface StructuredBankSection {
  bankName?: DocumentEvidence<string>;
  branch?: DocumentEvidence<string>;
  iban?: DocumentEvidence<string>;
  bic?: DocumentEvidence<string>;
  ownerRole?: 'issuer' | 'customer' | 'unknown';
  requiresReview: boolean;
}

export interface StructuredPublicAdministrationData {
  cup?: DocumentEvidence<string>;
  cig?: DocumentEvidence<string>;
  entityReference?: DocumentEvidence<string>;
  office?: DocumentEvidence<string>;
  requiresReview: boolean;
}

export interface StructuredLineItem {
  itemCode?: DocumentEvidence<string>;
  description?: DocumentEvidence<string>;
  quantity?: DocumentEvidence<number>;
  unit?: DocumentEvidence<string>;
  unitPrice?: DocumentEvidence<number>;
  discount?: DocumentEvidence<number>;
  discountType?: DocumentEvidence<'percentage' | 'amount'>;
  taxableAmount?: DocumentEvidence<number>;
  vatRate?: DocumentEvidence<number>;
  vatNature?: DocumentEvidence<string>;
  vatIncluded?: DocumentEvidence<boolean>;
  lineTotal?: DocumentEvidence<number>;
  currency?: DocumentEvidence<string>;
  pageIndex: number;
  sourceLineIds: string[];
  sourceLines: string[];
  requiresReview: boolean;
}

export interface StructuredTaxSummary {
  vatRate?: DocumentEvidence<number>;
  vatNature?: DocumentEvidence<string>;
  taxableAmount?: DocumentEvidence<number>;
  vatAmount?: DocumentEvidence<number>;
  pageIndex: number;
  requiresReview: boolean;
}

export interface StructuredDocumentSummary {
  materialTotal?: DocumentEvidence<number>;
  laborTotal?: DocumentEvidence<number>;
  externalWorkTotal?: DocumentEvidence<number>;
  subtotal?: DocumentEvidence<number>;
  discountTotal?: DocumentEvidence<number>;
  shippingCost?: DocumentEvidence<number>;
  logisticsContribution?: DocumentEvidence<number>;
  additionalCharges?: DocumentEvidence<number>;
  taxableAmount?: DocumentEvidence<number>;
  vatAmount?: DocumentEvidence<number>;
  taxSummaries: StructuredTaxSummary[];
  total?: DocumentEvidence<number>;
  deposit?: DocumentEvidence<number>;
  balance?: DocumentEvidence<number>;
  currency?: DocumentEvidence<string>;
  conflicts: string[];
  requiresReview: boolean;
}

export interface StructuredDocumentConditions {
  paymentTerms?: DocumentEvidence<string>;
  deliveryDate?: DocumentEvidence<string>;
  deliveryTerms?: DocumentEvidence<string>;
  shippingTerms?: DocumentEvidence<string>;
  validity?: DocumentEvidence<string>;
  notes?: DocumentEvidence<string>;
  bankDetails?: DocumentEvidence<string>;
  iban?: DocumentEvidence<string>;
  signatures?: DocumentEvidence<string[]>;
}

export type DocumentZoneClassification =
  | 'header'
  | 'issuer'
  | 'customer'
  | 'metadata'
  | 'subject'
  | 'items_table'
  | 'tax_summary'
  | 'totals'
  | 'payment'
  | 'footer'
  | 'notes'
  | 'unknown';

export type SemanticDocumentRegion =
  | 'header'
  | 'issuer_block'
  | 'customer_block'
  | 'ship_to_block'
  | 'document_identity'
  | 'references'
  | 'commercial_table_header'
  | 'commercial_table_body'
  | 'table_subtotal'
  | 'document_totals'
  | 'tax_recap'
  | 'payment_terms'
  | 'notes'
  | 'footer'
  | 'historical_recap'
  | 'statistical_recap'
  | 'unknown';

export interface DocumentLayoutLine {
  id: string;
  pageIndex: number;
  readingOrder: number;
  text: string;
  boundingBox?: DocumentBoundingBox;
  blockIndex?: number;
  lineIndex?: number;
  semanticRegion?: SemanticDocumentRegion;
  regionConfidence?: number;
  elements?: Array<{
    text: string;
    elementIndex: number;
    boundingBox?: DocumentBoundingBox;
  }>;
}

export interface DocumentLayoutZone {
  id: string;
  pageIndex: number;
  boundingBox?: DocumentBoundingBox;
  lineIds: string[];
  rawLines: string[];
  classification: DocumentZoneClassification;
  reasons: string[];
  requiresReview: boolean;
}

export type DocumentPageCompletenessStatus = 'complete' | 'partial' | 'incomplete';

export interface StructuredDocumentPage {
  pageIndex: number;
  width?: number;
  height?: number;
  lines: DocumentLayoutLine[];
  zones: DocumentLayoutZone[];
  status: DocumentPageCompletenessStatus;
  complete: boolean;
  requiresRescan: boolean;
  reasons: string[];
}

export interface StructuredDocumentExtraction {
  schemaVersion: 1;
  language?: StructuredDocumentLanguage;
  metadata: StructuredDocumentMetadata;
  issuer?: StructuredParty;
  customer?: StructuredParty;
  recipient?: StructuredParty;
  prospect?: StructuredParty;
  vehicle?: StructuredVehicleSection;
  project?: StructuredProjectSection;
  delivery?: StructuredDeliverySection;
  shipping?: StructuredShippingSection;
  bank?: StructuredBankSection;
  publicAdministrationData?: StructuredPublicAdministrationData;
  items: StructuredLineItem[];
  summary: StructuredDocumentSummary;
  conditions: StructuredDocumentConditions;
  pages: StructuredDocumentPage[];
  complete: boolean;
  requiresRescan: boolean;
  requiresReview: boolean;
  reasons: string[];
}
