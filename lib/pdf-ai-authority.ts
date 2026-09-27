import type { AnyDocument } from '../types';
import type { GeminiDocumentExtract } from './gemini-document-extract';
import type {
  DocumentEvidence,
  StructuredDocumentExtraction,
  StructuredParty,
} from './document-structure';
import { documentEvidence } from './document-structured-evidence';
import { isUnusableCompanyName } from './pdf-party-subject';

/**
 * Su un PDF il servizio AI legge il documento originale con il suo impianto
 * grafico, mentre la passata locale vede solo righe di testo senza geometria.
 * Quando entrambi hanno un'opinione su chi emette, chi riceve o di cosa tratta
 * il documento, quella del servizio è la più informata: la lettura locale
 * arricchisce e segnala, non riscrive.
 */
const AI_REASON = 'ai_pdf_value';
const CONFLICT_REASON = 'local_value_conflicts_with_ai_pdf';

type StringEvidence = DocumentEvidence<string>;

function aiEvidence(value: string, reason: string): StringEvidence {
  return documentEvidence<string>({
    rawValue: value,
    normalizedValue: value,
    lines: [],
    validationStatus: 'unverified',
    reasons: [reason],
    requiresReview: true,
  });
}

function trimmed(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
}

/** Un recapito o un'etichetta non sono il nome di un'azienda, da qualsiasi fonte arrivino. */
function usableName(value: unknown): string | undefined {
  const name = trimmed(value);
  return name && !isUnusableCompanyName(name) ? name : undefined;
}

/**
 * Tiene il valore del servizio e conserva quello locale divergente come
 * alternativa: chi rivede il documento vede che c'era un disaccordo.
 */
function preferAi(
  aiValue: string | undefined,
  local: StringEvidence | undefined,
  reason: string
): StringEvidence | undefined {
  if (!aiValue) return local;
  const evidence = aiEvidence(aiValue, reason);
  const localValue = trimmed(local?.normalizedValue ?? local?.rawValue);
  if (!localValue || localValue === aiValue) return evidence;
  return {
    ...evidence,
    conflict: true,
    reasons: [...evidence.reasons, CONFLICT_REASON],
    alternatives: [
      {
        rawValue: local?.rawValue ?? localValue,
        normalizedValue: localValue,
        pageIndex: local?.pageIndex ?? 0,
        sourceLineIds: local?.sourceLineIds ?? [],
        reasons: [CONFLICT_REASON],
      },
    ],
  };
}

function partyWithName(
  role: StructuredParty['role'],
  party: StructuredParty | undefined,
  name: StringEvidence | undefined
): StructuredParty | undefined {
  if (!name) return party;
  const base = party ?? { role, conflicts: [], requiresReview: true };
  return {
    ...base,
    name,
    requiresReview: base.requiresReview || !!name.conflict,
    conflicts: name.conflict
      ? [...new Set([...base.conflicts, CONFLICT_REASON])]
      : base.conflicts,
  };
}

/** Scarta il nome locale quando è solo un'etichetta di contatto. */
function withoutUnusableName(
  party: StructuredParty | undefined
): StructuredParty | undefined {
  if (!party?.name) return party;
  const name = trimmed(party.name.normalizedValue ?? party.name.rawValue);
  if (!name || usableName(name)) return party;
  const { name: _rejected, ...rest } = party;
  return { ...rest, requiresReview: true };
}

export function emptyStructuredExtraction(): StructuredDocumentExtraction {
  return {
    schemaVersion: 1,
    metadata: {},
    items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: false },
    conditions: {},
    pages: [],
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [AI_REASON],
  };
}

/**
 * Porta nel modello strutturato i campi che il documento piatto non sa dove
 * mettere: emittente, cliente e oggetto altrimenti si perderebbero fra
 * l'estrazione del servizio e il salvataggio.
 */
export function withAiAuthority(
  extraction: StructuredDocumentExtraction,
  extract: GeminiDocumentExtract
): StructuredDocumentExtraction {
  const structured = extract.structured;
  const issuerName = usableName(structured?.issuer?.name?.value);
  const customerName =
    usableName(structured?.customer?.name?.value) ?? usableName(extract.customerName);
  const subject = trimmed(structured?.document.subject?.value);
  const documentNumber =
    trimmed(structured?.document.documentNumber?.value) ?? trimmed(extract.documentNumber);
  const issueDate =
    trimmed(structured?.document.issueDate?.value) ?? trimmed(extract.date);
  const currency =
    trimmed(structured?.document.currency?.value)
    ?? trimmed(structured?.summary.currency?.value);

  const issuer = withoutUnusableName(extraction.issuer);
  const customer = withoutUnusableName(extraction.customer);

  const nextIssuer = partyWithName(
    'issuer',
    issuer,
    preferAi(issuerName, issuer?.name, `${AI_REASON}_issuer`)
  );
  const nextCustomer = partyWithName(
    'customer',
    customer,
    preferAi(customerName, customer?.name, `${AI_REASON}_customer`)
  );
  const nextSubject = preferAi(
    subject,
    extraction.metadata.subject,
    `${AI_REASON}_subject`
  );
  const nextDocumentNumber = preferAi(
    documentNumber,
    extraction.metadata.documentNumber,
    `${AI_REASON}_document_number`
  );
  const nextIssueDate = preferAi(
    issueDate,
    extraction.metadata.issueDate,
    `${AI_REASON}_issue_date`
  );
  const nextCurrency = preferAi(
    currency,
    extraction.metadata.currency,
    `${AI_REASON}_currency`
  );

  return {
    ...extraction,
    metadata: {
      ...extraction.metadata,
      ...(nextSubject ? { subject: nextSubject } : {}),
      ...(nextDocumentNumber ? { documentNumber: nextDocumentNumber } : {}),
      ...(nextIssueDate ? { issueDate: nextIssueDate } : {}),
      ...(nextCurrency ? { currency: nextCurrency } : {}),
    },
    ...(nextIssuer ? { issuer: nextIssuer } : {}),
    ...(nextCustomer ? { customer: nextCustomer } : {}),
  };
}

/**
 * Conserva l'estrazione del servizio sul documento appena costruito, prima che
 * la passata locale entri in gioco: il modello piatto non ha una casella per
 * emittente e oggetto, ma questo non è un buon motivo per buttarli via.
 */
export function withAiStructuredExtraction(
  document: AnyDocument,
  extract: GeminiDocumentExtract
): AnyDocument {
  if (document.type === 'business_card') return document;
  const existing = (document as { structuredExtraction?: StructuredDocumentExtraction })
    .structuredExtraction;
  const extraction = withAiAuthority(existing ?? emptyStructuredExtraction(), extract);
  return { ...document, structuredExtraction: extraction } as AnyDocument;
}
