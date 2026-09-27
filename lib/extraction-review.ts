import type { Address, BusinessCard, OcrLine } from '../types';
import type {
  BusinessCardExtractionResult,
  FieldConfidence,
} from './parser-engine/card-extraction-result';
import type { CardPage } from './parser-engine/extract-card-with-confidence';
import { extractBusinessCardV5 } from './parser-v5';

import { normalizeAddress } from './address-format';
import { alignCompanyToEmailDomain, isRejectedCompanyValue, sanitizeCompanyValue } from './parser-engine/validators/company';
import {
  getPrimaryBusinessEmailDomain,
  resolveWebsiteWithPrimaryEmailDomain,
} from './parser-engine/validators/website';
import { validateFinalAddress } from './parser-engine/validators/address';
import { finalizePersonFields, finalizeRoleValue } from './parser-v5/finalize';
import {
  getSafeContactEmails,
  sanitizeBusinessCardEmailState,
} from './email-evidence';
import { buildCardTitle } from './card-title';
import { initializeParsedContactReviewState } from './contact-review-state';

/** Abilita overlay confidence in UI (sperimentale). */
export const EXPERIMENTAL_EXTRACTION_REVIEW = true;

export type EditorFieldKey =
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'role'
  | 'emails'
  | 'phones'
  | 'website'
  | 'address'
  | 'vatNumber'
  | 'taxCode';

const EDITOR_FIELD_KEYS: EditorFieldKey[] = [
  'firstName',
  'lastName',
  'company',
  'role',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

export function isEditorFieldKey(value: string): value is EditorFieldKey {
  return (EDITOR_FIELD_KEYS as string[]).includes(value);
}

/** Ricostruisce pagine OCR da rawText (solo UI lazy, meno preciso dello scan live). */
export function pagesFromRawText(rawText: string): CardPage[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [{ lines: [], rawText: '' }];

  const chunks = trimmed.split(/\n\n+/).filter((chunk) => chunk.trim());
  const pageTexts = chunks.length > 0 ? chunks : [trimmed];

  return pageTexts.map((pageText) => {
    const lines: OcrLine[] = pageText
      .split('\n')
      .map((text, lineIndex) => ({
        text: text.trim(),
        confidence: 0.75,
        heuristicQuality: 0.75,
        confidenceType: 'heuristic' as const,
        boundingBox: { x: 0, y: lineIndex * 22, width: 100, height: 20 },
      }))
      .filter((line) => line.text.length > 0);
    return { lines, rawText: pageText.trim() };
  });
}

export function pagesFromScan(pages: Array<{ lines: OcrLine[]; rawText: string }>): CardPage[] {
  return pages.map((page) => ({
    lines: page.lines,
    rawText: page.rawText,
  }));
}

/** Calcola metadati review/confidence senza alterare i valori del contatto. */
export function computeExtractionReview(pages: CardPage[]): BusinessCardExtractionResult {
  return extractBusinessCardV5(pages);
}


function titleCaseToken(value: string): string {
  if (!value) return value;
  if (value.length <= 3) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function companyFromEmailDomainAndRawText(emails: string[], rawText: string): string | null {
  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain) return null;
  const root = domain.split('.')[0] ?? '';
  if (!root || root.length < 3) return null;

  const brand = root.includes('-')
    ? root.split('-').filter(Boolean).map(titleCaseToken).join('-')
    : titleCaseToken(root);

  const legal = rawText.match(/\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*N\.?\s*C\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*A\.?\s*S\.?\.?)\b/i)?.[0]
    ?.replace(/\s+/g, '')
    .replace(/^S\.?R\.?L\.?\.?$/i, 'S.r.l.')
    .replace(/^S\.?N\.?C\.?\.?$/i, 'S.n.c.')
    .replace(/^S\.?P\.?A\.?\.?$/i, 'S.p.A.')
    .replace(/^S\.?A\.?S\.?\.?$/i, 'S.a.s.');

  return legal ? `${brand} ${legal}` : brand;
}

function cleanCardCompany(card: BusinessCard, review: BusinessCardExtractionResult): string {
  const emails = review.emails.value ?? card.emails ?? [];
  const current = card.company?.trim() ?? '';
  const reviewed = review.company.value?.trim() ?? '';
  const rawText = review.rawText || card.rawText || '';
  const canApplyReviewed =
    Boolean(reviewed) &&
    shouldApplyField(review.company.confidence, Boolean(current));

  // Una proposta LOW resta nell'extractionReview e non diventa mai un valore
  // operativo, né può sovrascrivere un dato già presente.
  if (!canApplyReviewed) return current;

  const candidates = [reviewed, current, companyFromEmailDomainAndRawText(emails, rawText)].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const aligned = alignCompanyToEmailDomain(candidate, emails, rawText);
    const cleaned = sanitizeCompanyValue(aligned);
    if (cleaned && !isRejectedCompanyValue(cleaned)) return cleaned;
  }
  return current ? sanitizeCompanyValue(current) : '';
}

function cleanCardWebsite(card: BusinessCard, review: BusinessCardExtractionResult): string | undefined {
  const emails = review.emails.value ?? card.emails ?? [];
  const current = card.website?.trim() || undefined;
  const canApplyReviewed =
    Boolean(review.website.value) &&
    shouldApplyField(review.website.confidence, Boolean(current));
  if (!canApplyReviewed) return current;
  const candidate = review.website.value ?? current;
  const resolved = resolveWebsiteWithPrimaryEmailDomain(candidate, emails);
  return resolved ?? undefined;
}

function cleanCardAddress(card: BusinessCard, review: BusinessCardExtractionResult): Address | undefined {
  const current = card.address ?? undefined;
  const canApplyReviewed =
    Boolean(review.address.value) &&
    shouldApplyField(review.address.confidence, Boolean(current));
  if (!canApplyReviewed) return current;
  const preferred = review.address.value ?? current;
  const normalized = normalizeAddress(preferred);
  const validated = validateFinalAddress(normalized ?? undefined);
  return validated ?? undefined;
}

function shouldApplyField(confidence: FieldConfidence, hasCurrentValue: boolean): boolean {
  // I valori HIGH del nuovo estrattore sono usati per correggere errori evidenti
  // del parser operativo. I MEDIUM riempiono solo campi vuoti, senza sovrascrivere.
  return confidence === 'high' || (!hasCurrentValue && confidence === 'medium');
}

function applyExtractionReviewValues(card: BusinessCard, review: BusinessCardExtractionResult): BusinessCard {
  const pageIsolationRequired = Boolean(
    review.pageCoherence &&
      (
        review.pageCoherence.decision === 'ambiguous' ||
        review.pageCoherence.excludedPageIndexes.length > 0
      )
  );
  const shouldUseReviewEmailState =
    pageIsolationRequired ||
    (
      (review.emails.value?.length ?? 0) > 0 &&
      shouldApplyField(review.emails.confidence, card.emails.length > 0)
    );
  const next: BusinessCard = {
    ...card,
    title: pageIsolationRequired ? '' : card.title,
    rawText: review.pageCoherence ? review.rawText : review.rawText || card.rawText,
    extractionReview: review,
    emailEvidence: shouldUseReviewEmailState
      ? review.emailEvidence ?? []
      : card.emailEvidence,
  };

  if (pageIsolationRequired) {
    // Il parser legacy ha visto tutte le pagine: in presenza di pagine
    // escluse/pending non può essere usato come fallback senza reintrodurle.
    next.firstName = review.firstName.value ?? '';
    next.lastName = review.lastName.value ?? '';
    next.role = review.role.value ?? '';
    next.company =
      review.company.value && review.company.confidence !== 'low'
        ? review.company.value
        : '';
    next.emails = getSafeContactEmails({
      emails: review.emails.value ?? [],
      emailEvidence: review.emailEvidence ?? [],
    });
    next.phones = review.phones.value ?? [];
    if (review.website.value) next.website = review.website.value;
    else delete next.website;
    if (review.address.value) next.address = review.address.value;
    else delete next.address;
    if (review.vatNumber.value) next.vatNumber = review.vatNumber.value;
    else delete next.vatNumber;
    if (review.taxCode.value) next.taxCode = review.taxCode.value;
    else delete next.taxCode;
  }

  if (review.firstName.value && shouldApplyField(review.firstName.confidence, Boolean(next.firstName?.trim()))) {
    const person = finalizePersonFields(review.firstName.value, review.lastName.value ?? next.lastName);
    next.firstName = person.firstName ?? '';
  }
  if (review.lastName.value && shouldApplyField(review.lastName.confidence, Boolean(next.lastName?.trim()))) {
    const person = finalizePersonFields(next.firstName || review.firstName.value, review.lastName.value);
    next.lastName = person.lastName ?? '';
  }
  if (review.role.value && shouldApplyField(review.role.confidence, Boolean(next.role?.trim()))) {
    next.role = finalizeRoleValue(review.role.value, next.company || review.company.value) ?? '';
  }
  if (review.emailEvidence !== undefined && shouldUseReviewEmailState) {
    next.emails = getSafeContactEmails({
      emails: review.emails.value ?? [],
      emailEvidence: review.emailEvidence,
    });
  }
  if (review.phones.value?.length && shouldApplyField(review.phones.confidence, next.phones.length > 0)) {
    next.phones = review.phones.value;
  }
  if (review.vatNumber.value && shouldApplyField(review.vatNumber.confidence, Boolean(next.vatNumber?.trim()))) {
    next.vatNumber = review.vatNumber.value;
  }
  if (review.taxCode.value && shouldApplyField(review.taxCode.confidence, Boolean(next.taxCode?.trim()))) {
    next.taxCode = review.taxCode.value;
  }

  // Campi pericolosi: applicare sempre una validazione finale prima di mostrarli.
  // Se non passano, restano vuoti invece di mostrare testo spazzatura.
  const cleanedCompany = cleanCardCompany(next, review);
  next.company = cleanedCompany;

  const cleanedWebsite = cleanCardWebsite(next, review);
  if (cleanedWebsite) next.website = cleanedWebsite;
  else delete next.website;

  const cleanedAddress = cleanCardAddress(next, review);
  if (cleanedAddress) next.address = cleanedAddress;
  else delete next.address;

  // La stessa regola centralizzata è usata da scan, review, export e reparse.
  next.title = buildCardTitle(
    next.company,
    next.firstName,
    next.lastName
  );

  return initializeParsedContactReviewState(
    sanitizeBusinessCardEmailState(next)
  );
}

/**
 * Allega extractionReview al biglietto dopo lo scan e applica solo correzioni HIGH.
 * Il parser operativo resta il legacy, ma gli errori evidenti vengono corretti
 * dalla lettura semantica/confidence senza AI automatica.
 */
export function attachExtractionReviewToCard(
  card: BusinessCard,
  pages: CardPage[]
): BusinessCard {
  if (!EXPERIMENTAL_EXTRACTION_REVIEW) return card;
  const review = computeExtractionReview(pages);
  return applyExtractionReviewValues(card, review);
}

export function fieldConfidence(
  review: BusinessCardExtractionResult,
  key: EditorFieldKey
): FieldConfidence {
  return review[key].confidence;
}

export function isFieldInReview(
  review: BusinessCardExtractionResult,
  key: EditorFieldKey
): boolean {
  return review.reviewFields.includes(key);
}

export type { BusinessCardExtractionResult, FieldConfidence };
