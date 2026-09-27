import type { Phone } from '../../../types';
import { normalizeAddress } from '../../address-format';
import { looksLikeCatalogLine } from '../scoring/features';
import {
  reconcileCompanySpelling,
} from '../resolve/reconcile';
import { ACTIVITY_WORDS_REGEX } from '../validators/dictionaries';
import { parsePersonNameFromLine } from '../validators/name';
import { dedupePhones } from '../validators/phone';

export interface CardFields {
  firstName: string;
  lastName: string;
  role: string;
  company: string;
  emails: string[];
  phones: Phone[];
  address?: import('../../../types').Address;
  vatNumber?: string;
  taxCode?: string;
  website?: string;
  rawText: string;
  confidence: Record<string, number>;
  emailEvidence?: import('../../email-evidence').EmailEvidenceMetadata[];
  extractionReview?: import('../card-extraction-result').BusinessCardExtractionResult;
  contactReviewState?: import('../../contact-review-state').ContactReviewState;
}

export interface AiCardFields {
  firstName?: string;
  lastName?: string;
  role?: string;
  company?: string;
  emails?: string[];
  phones?: Array<{ number: string; type?: Phone['type'] }>;
  website?: string;
  address?: { street?: string; postalCode?: string; city?: string; full?: string };
  vatNumber?: string;
  taxCode?: string;
}

function splitCityProvince(city?: string): { city?: string; province?: string } {
  const t = city?.trim();
  if (!t) return {};
  const m = t.match(/^(.*?)\s*\(([A-Za-z]{1,2})\)\s*$/);
  if (m) return { city: m[1].trim(), province: m[2].toUpperCase() };
  return { city: t };
}

function personNamesLookWrong(firstName: string, lastName: string, emails: string[]): boolean {
  const full = `${firstName} ${lastName}`.trim();
  if (!full) return false;
  if (looksLikeCatalogLine(full)) return true;
  if (ACTIVITY_WORDS_REGEX.test(full)) return true;
  if (parsePersonNameFromLine(full) === null) return true;
  if (emails.length > 0 && full.split(/\s+/).length >= 3) {
    const domainKeys = emails
      .map((e) => e.split('@')[1]?.split('.')[0]?.toLowerCase() ?? '')
      .filter(Boolean);
    const nameKey = full.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (domainKeys.some((d) => d.length >= 4 && nameKey.includes(d))) return true;
  }
  return false;
}

/**
 * Merge locale + AI con semantica compatibile al parser legacy.
 * L'AI non viene invocata automaticamente: questa funzione va chiamata esplicitamente.
 */
export function mergeAiCardFields<T extends CardFields>(local: T, ai: AiCardFields | null): T {
  if (!ai) return local;

  const aiPhones = (ai.phones ?? [])
    .map((p) => ({ number: (p.number ?? '').trim(), type: p.type ?? ('work' as const) }))
    .filter((p) => p.number);
  const phones = aiPhones.length > 0 ? dedupePhones([...local.phones, ...aiPhones]) : local.phones;

  const aiCompanyRaw = (ai.company ?? '').trim();
  const aiRole = (ai.role ?? '').trim();
  const websiteHint = local.website || (ai.website ?? '').trim() || undefined;
  const companyDraft = reconcileCompanySpelling(aiCompanyRaw || local.company, local.emails, websiteHint).company;
  const emails = [...local.emails];
  const company = reconcileCompanySpelling(aiCompanyRaw || local.company, emails, websiteHint).company;

  let firstName = local.firstName;
  let lastName = local.lastName;
  if (personNamesLookWrong(firstName, lastName, emails)) {
    firstName = '';
    lastName = '';
  }

  const aiFirst = (ai.firstName ?? '').trim();
  const aiLast = (ai.lastName ?? '').trim();
  if (aiFirst || aiLast) {
    const aiFull = `${aiFirst} ${aiLast}`.trim();
    if (!personNamesLookWrong(aiFirst, aiLast, emails) && parsePersonNameFromLine(aiFull)) {
      if (!firstName) firstName = aiFirst;
      if (!lastName) lastName = aiLast;
    }
  }

  let address = local.address;
  if (ai.address && (ai.address.street || ai.address.city || ai.address.full)) {
    const { city: aiCity, province: aiProvince } = splitCityProvince(ai.address.city);
    address =
      normalizeAddress({
        street: ai.address.street?.trim() || local.address?.street,
        postalCode: ai.address.postalCode?.trim() || local.address?.postalCode,
        city: aiCity || local.address?.city,
        region: aiProvince || local.address?.region,
        country: local.address?.country,
        full: ai.address.full?.trim() || local.address?.full,
      }) ?? local.address;
  }

  const aiRoleClean =
    aiRole && !looksLikeCatalogLine(aiRole) && !ACTIVITY_WORDS_REGEX.test(aiRole) ? aiRole : '';

  return {
    ...local,
    firstName,
    lastName,
    role: aiRoleClean || local.role,
    company,
    emails,
    phones,
    website: local.website || (ai.website ?? '').trim() || local.website,
    address,
    vatNumber: local.vatNumber || (ai.vatNumber ?? '').trim() || local.vatNumber,
    taxCode: local.taxCode || (ai.taxCode ?? '').trim() || local.taxCode,
    confidence: {
      firstName: firstName ? (local.firstName ? local.confidence.firstName : 0.75) : local.confidence.firstName,
      lastName: lastName ? (local.lastName ? local.confidence.lastName : 0.75) : local.confidence.lastName,
      company: aiCompanyRaw ? 0.85 : local.confidence.company,
      role: aiRoleClean ? 0.8 : local.confidence.role,
      emails: local.confidence.emails,
      phones: phones.length > local.phones.length ? Math.max(local.confidence.phones, 0.7) : local.confidence.phones,
    },
  };
}

export function cardNeedsAiHelp(
  card: Pick<CardFields, 'firstName' | 'lastName' | 'company' | 'emails' | 'phones' | 'address'>
): boolean {
  const hasName = Boolean(card.firstName || card.lastName);
  const hasCompany = Boolean(card.company);
  const hasContact = card.emails.length > 0 || card.phones.length > 0;
  const hasAddress = Boolean(card.address?.street || (card.address?.postalCode && card.address?.city));
  const missing = [!hasName, !hasCompany, !hasContact, !hasAddress].filter(Boolean).length;
  return missing >= 2;
}

export { buildCardTitle } from '../../card-title';
