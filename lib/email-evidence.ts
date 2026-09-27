import type { BusinessCard } from '../types';
import {
  isValidEmailFormat,
  normalizeEmail,
} from './parser-engine/validators/email';

export type EmailEvidenceOrigin =
  | 'observed'
  | 'repaired'
  | 'inferred'
  | 'user';

export type EmailEvidenceValidationStatus =
  | 'valid'
  | 'invalid'
  | 'unverified';

export interface EmailEvidenceMetadata {
  value: string;
  rawValue: string;
  repairedValue?: string;
  origin: EmailEvidenceOrigin;
  pageIndex: number | null;
  lineId: number | null;
  rawOcr: string;
  transformations: string[];
  confidence: number;
  validationStatus: EmailEvidenceValidationStatus;
  requiresReview: boolean;
  confirmed: boolean;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function legacyUnverifiedEvidence(
  emails: readonly string[]
): EmailEvidenceMetadata[] {
  return dedupeStrings(emails.map((email) => email.trim()).filter(Boolean)).map(
    (rawValue) => {
      const value = normalizeEmail(rawValue);
      const valid = isValidEmailFormat(value);
      return {
        value: valid ? value : rawValue,
        rawValue,
        origin: 'inferred',
        pageIndex: null,
        lineId: null,
        rawOcr: '',
        transformations: ['legacy_provenance_unknown'],
        confidence: 0,
        validationStatus: valid ? 'unverified' : 'invalid',
        requiresReview: true,
        confirmed: false,
      };
    }
  );
}

export function isActionableEmailEvidence(
  evidence: EmailEvidenceMetadata
): boolean {
  if (
    evidence.validationStatus !== 'valid' ||
    evidence.requiresReview ||
    !evidence.confirmed
  ) {
    return false;
  }
  return evidence.origin === 'observed' || evidence.origin === 'user';
}

export function actionableEmailValues(
  evidence: readonly EmailEvidenceMetadata[] | null | undefined
): string[] {
  if (!evidence) return [];
  return dedupeStrings(
    evidence
      .filter(isActionableEmailEvidence)
      .map((item) => normalizeEmail(item.value))
      .filter(isValidEmailFormat)
  );
}

export function getSafeContactEmails(
  card: Pick<BusinessCard, 'emails' | 'emailEvidence'>
): string[] {
  const current = dedupeStrings(
    (card.emails ?? [])
      .map((email) => normalizeEmail(email))
      .filter(isValidEmailFormat)
  );
  if (card.emailEvidence === undefined) {
    // Provenienza sconosciuta: nessun uso operativo prima della conferma.
    return [];
  }

  const allowed = new Set(
    actionableEmailValues(card.emailEvidence).map((email) =>
      email.toLowerCase()
    )
  );
  return current.filter((email) => allowed.has(email.toLowerCase()));
}

export function sanitizeBusinessCardEmailState<T extends BusinessCard>(
  card: T
): T {
  const hadLegacyUnclassifiedEmails =
    card.emailEvidence === undefined && card.emails.length > 0;
  const emailEvidence =
    card.emailEvidence ?? legacyUnverifiedEvidence(card.emails);
  const classifiedCard = {
    ...card,
    emailEvidence,
  };
  const emails = getSafeContactEmails(classifiedCard);
  const actionableEvidence = emailEvidence.filter(
    isActionableEmailEvidence
  );
  const emailScore =
    actionableEvidence.length
      ? actionableEvidence.reduce(
          (sum, item) => sum + item.confidence,
          0
        ) / actionableEvidence.length
      : 0;
  const normalizedEmailScore = Number(
    Math.max(0, Math.min(1, emailScore ?? 0)).toFixed(3)
  );
  if (
    emails.length === card.emails.length &&
    emails.every((email, index) => email === card.emails[index]) &&
    card.emailEvidence !== undefined &&
    card.confidence.emails === normalizedEmailScore
  ) {
    return card;
  }

  const extractionReview = card.extractionReview
    ? (() => {
        const reviewFields = hadLegacyUnclassifiedEmails
          ? [...new Set([...card.extractionReview!.reviewFields, 'emails'])]
          : card.extractionReview!.reviewFields;
        return {
          ...card.extractionReview!,
          emails: {
            ...card.extractionReview!.emails,
            value: emails,
            score: normalizedEmailScore,
            confidence:
              normalizedEmailScore >= 0.74
                ? ('high' as const)
                : normalizedEmailScore >= 0.44
                  ? ('medium' as const)
                  : ('low' as const),
            reasons: hadLegacyUnclassifiedEmails
              ? [
                  ...(card.extractionReview!.emails.reasons ?? []),
                  'email legacy con provenienza da confermare',
                ]
              : (card.extractionReview!.emails.reasons ?? []),
          },
          emailEvidence,
          reviewFields,
          needsReview:
            card.extractionReview!.needsReview ||
            hadLegacyUnclassifiedEmails,
        };
      })()
    : card.extractionReview;

  return {
    ...card,
    emails,
    emailEvidence,
    confidence: {
      ...card.confidence,
      emails: normalizedEmailScore,
    },
    extractionReview,
  };
}

export function applyManualEmailEdit<T extends BusinessCard>(
  card: T,
  rawEmails: string[]
): T {
  const emails = dedupeStrings(
    rawEmails.map((email) => email.trim()).filter(Boolean)
  );
  const previousEvidence =
    card.emailEvidence ?? card.extractionReview?.emailEvidence ?? [];
  const previousByValue = new Map(
    previousEvidence.map((item) => [
      normalizeEmail(item.value).toLowerCase(),
      item,
    ])
  );
  const manualEvidence: EmailEvidenceMetadata[] = emails.map((rawValue) => {
    const normalized = normalizeEmail(rawValue);
    const valid = isValidEmailFormat(normalized);
    const previous = previousByValue.get(normalized.toLowerCase());
    return {
      value: valid ? normalized : rawValue,
      rawValue,
      repairedValue: previous?.repairedValue,
      origin: 'user',
      pageIndex: previous?.pageIndex ?? null,
      lineId: previous?.lineId ?? null,
      rawOcr: previous?.rawOcr ?? rawValue,
      transformations: [
        ...(previous?.transformations ?? []),
        'user_confirmed',
      ].filter((value, index, values) => values.indexOf(value) === index),
      confidence: valid ? 1 : 0,
      validationStatus: valid ? 'valid' : 'invalid',
      requiresReview: !valid,
      confirmed: valid,
    };
  });
  const selectedKeys = new Set(
    manualEvidence.map((item) => normalizeEmail(item.value).toLowerCase())
  );
  const preservedSuggestions = previousEvidence.filter(
    (item) =>
      !selectedKeys.has(normalizeEmail(item.value).toLowerCase()) &&
      !item.confirmed &&
      item.requiresReview &&
      (item.origin === 'repaired' || item.origin === 'inferred')
  );
  const emailEvidence = [...manualEvidence, ...preservedSuggestions];
  const hasInvalid = manualEvidence.some(
    (item) => item.validationStatus !== 'valid'
  );
  const hasPendingSuggestions = preservedSuggestions.length > 0;

  const extractionReview = card.extractionReview
    ? (() => {
        const reviewFields = hasInvalid || hasPendingSuggestions
          ? [...new Set([...card.extractionReview!.reviewFields, 'emails'])]
          : card.extractionReview!.reviewFields.filter(
              (field) => field !== 'emails'
            );
        return {
          ...card.extractionReview!,
          emails: {
            value: emails,
            confidence: hasInvalid ? ('low' as const) : ('high' as const),
            score: hasInvalid ? 0 : 1,
            source: 'user' as const,
            reasons: [
              ...(hasInvalid
                ? ['email inserita manualmente con formato non valido']
                : ['email confermata manualmente']),
              ...(hasPendingSuggestions
                ? ['altre email OCR restano da confermare']
                : []),
            ],
          },
          emailEvidence,
          reviewFields,
          needsReview: reviewFields.length > 0,
        };
      })()
    : card.extractionReview;

  return {
    ...card,
    emails,
    emailEvidence,
    confidence: {
      ...card.confidence,
      emails: hasInvalid ? 0 : emails.length ? 1 : 0,
    },
    extractionReview,
  };
}

export function unconfirmedEmailSuggestions(
  evidence: readonly EmailEvidenceMetadata[] | null | undefined
): EmailEvidenceMetadata[] {
  return (evidence ?? []).filter(
    (item) =>
      !item.confirmed &&
      item.requiresReview &&
      (item.origin === 'repaired' || item.origin === 'inferred')
  );
}

/**
 * Durante una rielaborazione conserva solo le conferme manuali esplicite del
 * record precedente e le nuove evidenze del parser. Le email legacy prive di
 * provenance non vengono promosse automaticamente.
 */
export function mergeReparsedEmailState<T extends BusinessCard>(
  previous: BusinessCard,
  parsed: T
): T {
  const parsedEvidence = parsed.emailEvidence ?? [];
  const previousEvidence =
    previous.emailEvidence ?? legacyUnverifiedEvidence(previous.emails);
  const preservedUserEvidence = previousEvidence.filter(
    (item) => item.origin === 'user' && isActionableEmailEvidence(item)
  );
  const preservedLegacySuggestions =
    previous.emailEvidence === undefined ? previousEvidence : [];
  const byValue = new Map<string, EmailEvidenceMetadata>();
  for (const item of [
    ...parsedEvidence,
    ...preservedLegacySuggestions,
    ...preservedUserEvidence,
  ]) {
    const key = normalizeEmail(item.value);
    const current = byValue.get(key);
    if (!current || item.origin === 'user') {
      byValue.set(key, item);
    }
  }
  const emailEvidence = [...byValue.values()];
  // `parsed.emails` e il verdetto operativo del parser. `emailEvidence` puo
  // contenere anche letture osservate sintatticamente valide ma poi scartate
  // (per esempio "mail@dominio.it-www.dominio.it") e proposte riparate non
  // confermate. Ricostruire qui le email da tutta l'evidenza ri-promuoveva
  // proprio i falsi positivi che il parser aveva gia escluso.
  const emails = dedupeStrings([
    ...(parsed.emails ?? []).map(normalizeEmail).filter(isValidEmailFormat),
    ...preservedUserEvidence.map((item) => normalizeEmail(item.value)),
  ]);
  const extractionReview = parsed.extractionReview
    ? {
        ...parsed.extractionReview,
        emails: {
          ...parsed.extractionReview.emails,
          value: emails,
          ...(preservedUserEvidence.length
            ? {
                source: 'user' as const,
                reasons: [
                  ...(parsed.extractionReview.emails.reasons ?? []),
                  'conferma manuale preservata durante la rielaborazione',
                ],
              }
            : {}),
        },
        emailEvidence,
      }
    : parsed.extractionReview;

  return {
    ...parsed,
    emails,
    emailEvidence,
    confidence: {
      ...parsed.confidence,
      emails: emails.length
        ? Math.max(parsed.confidence.emails ?? 0, ...preservedUserEvidence.map((item) => item.confidence))
        : 0,
    },
    extractionReview,
  };
}
