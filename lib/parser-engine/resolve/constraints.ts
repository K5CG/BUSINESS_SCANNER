import type { CardDraft, FieldKind } from '../types';
import { isPersonNameOnlyLineConflict } from '../merge/pages';
import { looksLikeCatalogLine } from '../scoring/features';
import {
  collectUsedLineIndices,
  fieldScore,
  type DraftSelection,
  type FieldDecision,
} from './select';

export interface ConstraintResult {
  selection: DraftSelection;
  reasons: string[];
}

/** Priorità quando due campi competono sulla stessa riga (più alto vince). */
const LINE_CONFLICT_PRIORITY: Record<FieldKind, number> = {
  email: 90,
  phone: 85,
  vatNumber: 80,
  taxCode: 78,
  address: 70,
  website: 65,
  role: 50,
  company: 45,
  firstName: 40,
  lastName: 38,
};

type SingleFieldKey = Exclude<FieldKind, 'email' | 'phone'>;

const SINGLE_FIELDS: SingleFieldKey[] = [
  'firstName',
  'lastName',
  'role',
  'company',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

function clearSingleField(
  selection: DraftSelection,
  field: SingleFieldKey
): void {
  const current = selection[field];
  if (!current) return;
  selection[field] = {
    ...current,
    value: undefined,
    reasons: [...current.reasons, `rimosso: conflitto di riga con altro campo`],
  };
}

function getSingleField(selection: DraftSelection, field: SingleFieldKey): FieldDecision<unknown> | undefined {
  return selection[field] as FieldDecision<unknown> | undefined;
}

function winnerField(fields: FieldKind[], selection: DraftSelection): FieldKind {
  return [...fields].sort((a, b) => {
    const priorityDiff = LINE_CONFLICT_PRIORITY[b] - LINE_CONFLICT_PRIORITY[a];
    if (priorityDiff !== 0) return priorityDiff;
    return fieldScore(selection, b) - fieldScore(selection, a);
  })[0];
}

/**
 * Rimuove assegnazioni in conflitto sulla stessa riga OCR.
 * Vince il campo con priorità più alta; a parità, score maggiore.
 */
export function applyLineExclusivity(selection: DraftSelection): string[] {
  const reasons: string[] = [];
  const used = collectUsedLineIndices(selection);

  for (const [lineIndex, fields] of used.entries()) {
    const unique = [...new Set(fields)];
    if (unique.length <= 1) continue;
    if (isPersonNameOnlyLineConflict(unique)) continue;

    const winner = winnerField(unique, selection);
    const losers = unique.filter((f) => f !== winner);
    reasons.push(
      `riga ${lineIndex}: mantenuto ${winner}, rimossi ${losers.join(', ')}`
    );

    for (const loser of losers) {
      if (loser === 'email') {
        selection.emails = selection.emails.filter((e) => !e.sourceLineIndices.includes(lineIndex));
        continue;
      }
      if (loser === 'phone') {
        selection.phones = selection.phones.filter((p) => !p.sourceLineIndices.includes(lineIndex));
        continue;
      }
      if (SINGLE_FIELDS.includes(loser as SingleFieldKey)) {
        const field = getSingleField(selection, loser as SingleFieldKey);
        if (field?.sourceLineIndices.includes(lineIndex)) {
          clearSingleField(selection, loser as SingleFieldKey);
        }
      }
    }
  }

  return reasons;
}

/** Scarta nomi/ruoli che sembrano righe catalogo o descrizioni prodotto. */
export function applyCatalogGuards(selection: DraftSelection): string[] {
  const reasons: string[] = [];

  for (const field of ['firstName', 'lastName', 'role'] as const) {
    const decision = selection[field];
    const value = decision?.value;
    if (!value) continue;
    if (looksLikeCatalogLine(value)) {
      selection[field] = {
        ...decision,
        value: undefined,
        reasons: [...decision.reasons, 'rimosso: testo assimilabile a catalogo/descrizione'],
      };
      reasons.push(`${field} scartato (pattern catalogo)`);
    }
  }

  return reasons;
}

/** Nome e azienda non possono essere identici come stringa normalizzata. */
export function applyNameCompanyDistinctness(selection: DraftSelection): string[] {
  const reasons: string[] = [];
  const company = selection.company?.value?.trim();
  const first = selection.firstName?.value?.trim() ?? '';
  const last = selection.lastName?.value?.trim() ?? '';
  const fullName = `${first} ${last}`.trim();
  if (!company || !fullName) return reasons;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-zà-ü0-9]/g, '');
  if (norm(company) === norm(fullName)) {
    const companyDecision = selection.company!;
    selection.company = {
      ...companyDecision,
      value: undefined,
      reasons: [...companyDecision.reasons, 'rimosso: coincide con nome persona'],
    };
    reasons.push('company scartata (identica al nome persona)');
  }

  return reasons;
}

/**
 * Applica tutti i vincoli cross-field generici sulla selezione.
 */
export function applyConstraints(
  selection: DraftSelection,
  _draft?: CardDraft
): ConstraintResult {
  const reasons: string[] = [];

  reasons.push(...applyLineExclusivity(selection));
  reasons.push(...applyCatalogGuards(selection));
  reasons.push(...applyNameCompanyDistinctness(selection));

  return { selection, reasons };
}
