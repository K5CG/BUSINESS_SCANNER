export interface PersonEmailRepair {
  original: string;
  repaired: string;
  reason:
    | 'labeled_email_missing_local_separator'
    | 'email_local_one_glyph_person_reconcile';
  rawLine?: string;
}

export interface PersonEmailReconcileResult {
  emails: string[];
  repairs: PersonEmailRepair[];
}

function key(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    let diagonal = i - 1;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(above + 1, left + 1, diagonal + cost);
      prev[j - 1] = left;
      diagonal = above;
      left = next;
    }
    prev[b.length] = left;
  }
  return prev[b.length]!;
}

function personIsObserved(rawText: string, firstName: string, lastName: string): boolean {
  const first = key(firstName);
  const last = key(lastName);
  if (!first || !last) return false;
  return rawText.split(/\r?\n/).some((line) => {
    const compact = key(line);
    return compact.includes(first + last) || compact.includes(last + first);
  });
}

function normalizeEmailishLine(line: string): string {
  return line
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.')
    .trim();
}

function splitEmail(email: string): { local: string; host: string } | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at >= email.length - 1) return null;
  const local = email.slice(0, at).toLowerCase();
  const host = email.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9._%+\-]+$/i.test(local)) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,63}$/i.test(host)) return null;
  return { local, host };
}

function repairDetachedLabeledPrefix(
  emails: string[],
  firstName: string,
  lastName: string,
  rawText: string,
): PersonEmailRepair | null {
  const first = key(firstName);
  const last = key(lastName);
  if (!first || !last) return null;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const normalized = normalizeEmailishLine(rawLine);
    const match = normalized.match(/^\s*(?:e[\s-]?mail|email|mail|pec)\s*[:.\-]?\s+([a-z0-9._%+\-]+)\s+([a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,63})\s*$/i);
    if (!match) continue;
    const prefix = match[1]!.toLowerCase();
    const suffixEmail = match[2]!.toLowerCase();
    const suffix = splitEmail(suffixEmail);
    if (!suffix) continue;

    const prefixKey = key(prefix);
    const suffixKey = key(suffix.local);
    const matchesObservedPerson =
      (prefixKey === first && suffixKey === last) ||
      (prefixKey === last && suffixKey === first);
    if (!matchesObservedPerson) continue;

    const original = emails.find((email) => {
      const parts = splitEmail(email);
      return Boolean(parts && parts.host === suffix.host && key(parts.local) === suffixKey);
    });
    if (!original) continue;

    const repaired = `${prefix}.${suffix.local}@${suffix.host}`;
    if (repaired === original.toLowerCase()) continue;
    return {
      original,
      repaired,
      reason: 'labeled_email_missing_local_separator',
      rawLine,
    };
  }
  return null;
}

function repairOneGlyphLocalFromObservedPerson(
  email: string,
  firstName: string,
  lastName: string,
): PersonEmailRepair | null {
  const parts = splitEmail(email);
  if (!parts) return null;

  // Fail closed: this repair only handles fused alphanumeric local-parts.
  // Existing dots/underscores/hyphens are semantically meaningful and are not rewritten.
  if (!/^[a-z0-9]+$/i.test(parts.local)) return null;

  const trailingDigits = parts.local.match(/\d+$/)?.[0] ?? '';
  const core = trailingDigits
    ? parts.local.slice(0, -trailingDigits.length)
    : parts.local;
  const first = key(firstName);
  const last = key(lastName);
  if (first.length < 2 || last.length < 2 || core.length < 6) return null;

  const candidates = [...new Set([`${first}${last}`, `${last}${first}`])]
    .filter((candidate) => candidate.length === core.length)
    .map((candidate) => ({ candidate, distance: levenshtein(core, candidate) }))
    .filter((entry) => entry.distance === 1);
  if (candidates.length !== 1) return null;

  const repaired = `${candidates[0]!.candidate}${trailingDigits}@${parts.host}`;
  if (repaired === email.toLowerCase()) return null;
  return {
    original: email,
    repaired,
    reason: 'email_local_one_glyph_person_reconcile',
  };
}

/**
 * Reconciliation is deliberately narrow and evidence-driven:
 * - the person must be directly observed in OCR;
 * - a missing local-part separator is repaired only on an explicitly labelled
 *   email row that contains BOTH observed person tokens plus the already-parsed
 *   suffix mailbox on the same row;
 * - a one-glyph local-part repair is allowed only when the fused local-part is
 *   exactly one edit away from a unique first+last / last+first pattern.
 *
 * No dictionary spelling correction and no card-specific names are used.
 */
export function reconcileEmailsWithObservedPerson(
  emails: readonly string[],
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  rawText: string,
): PersonEmailReconcileResult {
  const current = [...new Set(emails.map((email) => email.toLowerCase()))];
  const repairs: PersonEmailRepair[] = [];
  if (!firstName || !lastName || !personIsObserved(rawText, firstName, lastName)) {
    return { emails: current, repairs };
  }

  const detached = repairDetachedLabeledPrefix(current, firstName, lastName, rawText);
  if (detached) {
    const index = current.findIndex((email) => email === detached.original.toLowerCase());
    if (index >= 0) current[index] = detached.repaired;
    repairs.push(detached);
  }

  for (let i = 0; i < current.length; i++) {
    const repaired = repairOneGlyphLocalFromObservedPerson(current[i]!, firstName, lastName);
    if (!repaired) continue;
    current[i] = repaired.repaired;
    repairs.push(repaired);
  }

  return { emails: [...new Set(current)], repairs };
}
