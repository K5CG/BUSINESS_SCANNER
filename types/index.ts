export type DocumentType = 'business_card' | 'quote' | 'order' | 'invoice' | 'free_document';

export type DocumentCategory =
  | 'quote'
  | 'order'
  | 'invoice'
  | 'delivery_document'
  | 'proforma_invoice'
  | 'generic_document'
  | 'generic_image';

export type CardOrientation = 'landscape' | 'portrait';

export type OcrConfidenceType = 'measured' | 'heuristic' | 'unknown';

export type OcrQualityReason =
  | 'provider_confidence_available'
  | 'provider_confidence_unavailable'
  | 'empty_text'
  | 'very_short_text'
  | 'sufficient_text'
  | 'anomalous_characters'
  | 'mostly_readable_lines'
  | 'low_readable_line_ratio'
  | 'coherent_geometry'
  | 'incomplete_geometry'
  | 'recognized_contact_fields'
  | 'recognized_document_fields'
  | 'page_conflict'
  | 'multipage_aggregate'
  | 'legacy_quality_estimate'
  | 'cloud_result';

/**
 * Qualità generale dell'OCR, separata dalla validazione dei singoli campi.
 *
 * `measuredConfidence` è presente soltanto quando il provider restituisce
 * davvero una misura. `heuristicQuality` è una stima diagnostica e non è una
 * probabilità.
 */
export interface OcrQualityMetadata {
  measuredConfidence?: number;
  heuristicQuality?: number;
  confidenceType: OcrConfidenceType;
  qualityReasons: OcrQualityReason[];
  requiresReview: boolean;
}

export interface OcrLine {
  text: string;
  /**
   * Segnale numerico legacy usato soltanto dal ranking del parser.
   * Non va presentato come confidence misurata: consultare `confidenceType`
   * e `measuredConfidence` per la provenienza reale.
   */
  confidence: number;
  measuredConfidence?: number;
  heuristicQuality?: number;
  confidenceType?: OcrConfidenceType;
  boundingBox?: { x: number; y: number; width: number; height: number };
  blockIndex?: number;
  lineIndex?: number;
  elements?: Array<{
    text: string;
    elementIndex: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
  }>;
}

export interface Phone {
  number: string;
  type?: 'mobile' | 'work' | 'fax' | 'other';
}

export interface Address {
  street?: string;
  civicNumber?: string;
  city?: string;
  postalCode?: string;
  /** Provincia IT (VI), stato US (CA), contea UK, cantone CH, Land DE… */
  region?: string;
  country?: string;
  full?: string;
}

export interface BaseDocument {
  id: string;
  type: DocumentType;
  /** User-selected document category. Optional for backward compatibility with existing records. */
  category?: DocumentCategory;
  title: string;
  /**
   * Revisione interna della singola creazione protetta. Permette alla
   * compensazione di rimuovere soltanto il record prodotto dall'operazione
   * annullata, senza toccare un retry più recente con lo stesso id.
   */
  persistenceRevision?: string;
  images: string[];
  /** Copie complete normalizzate delle pagine, conservate separatamente dal ritaglio mostrato. */
  originalImages?: string[];
  /** Orientamento di cattura/normalizzazione per pagina; opzionale sui record legacy. */
  pageCaptureMetadata?: import('../lib/document-capture-orientation').DocumentPageCaptureMetadata[];
  rawText: string;
  confidence: Record<string, number>;
  /** Qualità OCR generale; opzionale per i record creati prima della Fase 4. */
  ocrQuality?: OcrQualityMetadata;
  /**
   * Esito OCR indipendente per ogni immagine del documento.
   * Opzionale per mantenere leggibili i record creati prima della Fase 2.
   */
  pageExtractions?: import('../lib/document-page-extraction').PageExtractionResult[];
  /** Merge multipagina deterministico con provenienza e conflitti (Fase 2B). */
  fieldMerge?: import('../lib/document-field-merge').DocumentFieldMergeResult;
  /**
   * Stato persistente del valore realmente applicato per ogni campo.
   * È opzionale per mantenere leggibili i record creati prima della Fase 3.
   */
  fieldReliability?: import('../lib/document-field-reliability').DocumentFieldReliabilityMap;
  /** Estrazione documentale layout-aware locale, con provenance e completezza. */
  structuredExtraction?: import('../lib/document-structure').StructuredDocumentExtraction;
  /** Persisted AI comparison/review state so decisions survive reloads. */
  aiReviewState?: import('../lib/document-hybrid-review').HybridDocumentReviewState;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessCard extends BaseDocument {
  type: 'business_card';
  /** Foto volto/contatto (solo locale, non inviata al cloud OCR). */
  contactPhotoUri?: string;
  firstName: string;
  lastName: string;
  role: string;
  company: string;
  emails: string[];
  /** Provenienza per-email; assente sui record creati prima della Fase 3B. */
  emailEvidence?: import('../lib/email-evidence').EmailEvidenceMetadata[];
  phones: Phone[];
  address?: Address;
  vatNumber?: string;
  taxCode?: string;
  website?: string;
  notes?: string;
  /**
   * Metadati sperimentali best-effort (confidence, reviewFields).
   * Non altera il parser operativo; opzionale su card legacy.
   */
  extractionReview?: import('../lib/parser-engine/card-extraction-result').BusinessCardExtractionResult;
  /**
   * Stato persistente della review contatto (snapshot iniziale, override
   * manuali e provenienza del valore corrente). Opzionale sui record legacy.
   */
  contactReviewState?: import('../lib/contact-review-state').ContactReviewState;
  /** Ultimo parser usato in Rielabora (diagnostica QA). */
  lastParserBuildId?: string;
}

export interface QuoteItem {
  description: string;
  quantity?: number;
  unitPrice: number;
  vatRate?: number;
  discount?: number;
  total: number;
}

export interface QuoteDocument extends BaseDocument {
  type: 'quote';
  quoteNumber?: string;
  quoteDate?: Date;
  validUntil?: Date;
  customerName?: string;
  customerVat?: string;
  items: QuoteItem[];
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  currency?: string;
  notes?: string;
}

export interface OrderItem {
  description: string;
  quantity?: number;
  unitPrice: number;
  vatRate?: number;
  discount?: number;
  total: number;
}

export interface OrderDocument extends BaseDocument {
  type: 'order';
  orderNumber?: string;
  orderDate?: Date;
  deliveryDate?: Date;
  customerName?: string;
  customerVat?: string;
  items: OrderItem[];
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  currency?: string;
  shippingAddress?: Address;
  notes?: string;
}

export interface InvoiceItem {
  description: string;
  quantity?: number;
  unitPrice: number;
  vatRate?: number;
  discount?: number;
  total: number;
}

export interface InvoiceDocument extends BaseDocument {
  type: 'invoice';
  invoiceNumber?: string;
  invoiceDate?: Date;
  dueDate?: Date;
  customerName?: string;
  customerVat?: string;
  items: InvoiceItem[];
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  currency?: string;
  notes?: string;
}

export interface FreeDocument extends BaseDocument {
  type: 'free_document';
  documentNumber?: string;
  documentDate?: Date;
  subject?: string;
  extractedFields: Record<string, string>;
  notes?: string;
}

export type AnyDocument =
  | BusinessCard
  | QuoteDocument
  | OrderDocument
  | InvoiceDocument
  | FreeDocument;

/** @deprecated Use BusinessCard - kept for backward compatibility with existing contact flow */
export type Contact = BusinessCard;
