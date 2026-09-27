import type {
  StructuredDocumentPage,
  StructuredDocumentSummary,
  StructuredDocumentType,
  StructuredLineItem,
} from './document-structure';

export interface DocumentCompletenessResult {
  pages: StructuredDocumentPage[];
  complete: boolean;
  requiresRescan: boolean;
  requiresReview: boolean;
  reasons: string[];
}

function hasZone(page: StructuredDocumentPage, kinds: readonly string[]): boolean {
  return page.zones.some((zone) => kinds.includes(zone.classification));
}

function geometryStartsTooLow(page: StructuredDocumentPage): boolean {
  if (!page.height || page.height <= 0) return false;
  const boxes = page.lines.flatMap((line) => line.boundingBox ? [line.boundingBox] : []);
  if (boxes.length < 2) return false;
  return Math.min(...boxes.map((box) => box.y)) > page.height * 0.3;
}

export function evaluateDocumentCompleteness(
  sourcePages: readonly StructuredDocumentPage[],
  documentType: StructuredDocumentType,
  items: readonly StructuredLineItem[],
  summary: StructuredDocumentSummary,
): DocumentCompletenessResult {
  const ordered = [...sourcePages].sort((a, b) => a.pageIndex - b.pageIndex);
  const globalReasons: string[] = [];
  const pages = ordered.map((page, index) => {
    const reasons: string[] = [];
    const pageItems = items.filter((item) => item.pageIndex === page.pageIndex);
    const meaningfulLines = page.lines.filter((line) => line.text.trim().length >= 2);
    const firstPage = index === 0;
    const lastPage = index === ordered.length - 1;
    const croppedTop = geometryStartsTooLow(page);
    const onlyLowerContent =
      !hasZone(page, ['header', 'issuer', 'metadata', 'customer', 'items_table']) &&
      hasZone(page, ['tax_summary', 'totals', 'footer']);

    if (meaningfulLines.length === 0) reasons.push('empty_page');
    if (croppedTop) reasons.push('page_starts_below_expected_top');
    if (onlyLowerContent) reasons.push('only_lower_document_section_visible');
    if (firstPage && documentType !== 'free_document' && !hasZone(page, ['header', 'issuer', 'metadata'])) {
      reasons.push('document_header_missing');
    }
    if (hasZone(page, ['items_table']) && pageItems.length === 0) {
      reasons.push('items_table_without_supported_rows');
    }
    if (lastPage && documentType !== 'free_document' && !summary.total) {
      reasons.push('document_total_missing');
    }

    const hardIncomplete = reasons.some((reason) => ['empty_page', 'page_starts_below_expected_top', 'only_lower_document_section_visible'].includes(reason));
    const status: StructuredDocumentPage['status'] = hardIncomplete
      ? 'incomplete'
      : reasons.length > 0
        ? 'partial'
        : 'complete';
    const requiresRescan = hardIncomplete;
    globalReasons.push(...reasons.map((reason) => `page_${page.pageIndex + 1}:${reason}`));
    return {
      ...page,
      status,
      complete: status === 'complete',
      requiresRescan,
      reasons,
    };
  });

  if (documentType !== 'free_document' && items.length === 0 && pages.some((page) => hasZone(page, ['items_table']))) {
    globalReasons.push('document_items_missing_despite_table');
  }
  const structuredContentAbsent = documentType !== 'free_document' && items.length === 0 && !summary.total && !pages.some((page) => hasZone(page, ['items_table']));
  if (structuredContentAbsent) {
    globalReasons.push('document_essential_sections_missing');
    for (const page of pages) {
      page.status = 'incomplete';
      page.complete = false;
      page.requiresRescan = true;
      page.reasons = [...new Set([...page.reasons, 'essential_sections_not_visible'])];
    }
  }
  const requiresRescan = pages.some((page) => page.requiresRescan);
  const complete = pages.length > 0 && pages.every((page) => page.complete);
  return {
    pages,
    complete,
    requiresRescan,
    requiresReview: !complete || requiresRescan,
    reasons: [...new Set(globalReasons)],
  };
}
