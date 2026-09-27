import type { StructuredDocumentExtraction } from './document-structure';

export interface LocalDocumentMinimumAssessment {
  tableDetected: boolean;
  tableStructured: boolean;
  tableNeedsReview: boolean;
  offerAiSupport: boolean;
  messages: string[];
}

export function assessLocalDocumentMinimum(
  extraction: StructuredDocumentExtraction,
): LocalDocumentMinimumAssessment {
  const tableDetected = extraction.pages.some((page) =>
    page.zones.some((zone) => zone.classification === 'items_table'),
  );
  const tableStructured = extraction.items.length > 0;
  const tableNeedsReview = tableDetected && !tableStructured;
  return {
    tableDetected,
    tableStructured,
    tableNeedsReview,
    offerAiSupport: tableNeedsReview || extraction.requiresReview,
    messages: tableNeedsReview ? ['table_detected_details_require_review'] : [],
  };
}
