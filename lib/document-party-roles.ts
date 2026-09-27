/**
 * Generic party-role resolver. Labels, identifiers and legal-suffix-only
 * tokens are never party names. Fallback may only replace a weaker/invalid value.
 */

export type PartyRole =
  | 'issuer'
  | 'supplier'
  | 'customer'
  | 'bill_to'
  | 'ship_to'
  | 'recipient'
  | 'unknown_organization';

export type PartySelectedBy = 'primary' | 'fallback' | 'overlay';

export type PartyRejectionReason =
  | 'label_only'
  | 'identifier'
  | 'legal_suffix_only'
  | 'bank_or_payment'
  | 'implausible_organization'
  | 'document_field_heading'
  | 'section_heading'
  | 'empty';

const PARTY_LABEL_ONLY =
  /^(?:cliente|customer|client|bill[\s\-]*to|ship[\s\-]*to|sold[\s\-]*to|destinatario|destinazione(?:\s+merce)?|supplier|vendor|fornitore|emittente|issuer|seller|sede\s+legale(?:\s+e\s+operativa)?|sede\s+operativa|rif\.?\s*cliente|customer\s+ref\.?|address|indirizzo|fatturare\s+a|consegnare\s+a|accounts\s+payable|accounts\s+receivable|stores\s*\/\s*receiving|kunde|rechnungsadresse|lieferadresse)\s*:?$/i;

/** Account/code metadata describing the customer — never the organization name. */
const CUSTOMER_REFERENCE_LABEL =
  /^(?:(?:vostro|your|notre|ihr)\s+)?(?:codice|code|nr\.?|n[°ºo]\.?|no\.?|number|nummer)\s+(?:cliente|customer|client|kunde)s?\s*:?$/i;

const CUSTOMER_REFERENCE_LABEL_REVERSED =
  /^(?:(?:vostro|your|notre|ihr)\s+)?(?:cliente|customer|client|kunde)s?\s+(?:codice|code|nr\.?|n[°ºo]\.?|no\.?|number|nummer)\s*:?$/i;

const CUSTOMER_REFERENCE_LABEL_ATOMIC =
  /^(?:kundennummer|kunden-?nr\.?|customer\s+ref(?:erence)?\.?|riferimento\s+cliente|referencia\s+cliente|r[eé]f[eé]rence\s+client|rif\.?\s*cliente|client\s+ref(?:erence)?\.?|your\s+customer\s+code)\s*:?$/i;

const SALES_CONTACT_LABEL =
  /^(?:addetto\s+vendite|sales\s+(?:representative|contact|rep)|repr[ée]sentant\s+commercial|vertreter|ansprechpartner)\s*:?$/i;

const PLURAL_OR_CATEGORY_CUSTOMER_HEADING =
  /^(?:clienti|customers|clientes|customer\s+list|client\s+list|elenco\s+clienti|liste\s+(?:des\s+)?clients|kundenliste)(?:\s|$)/i;

function foldPartySurface(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[:]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Heading-only OCR fold: I/l/1 and O/0 confusions must not turn a role label into an org name. */
function foldHeadingOcrConfusions(value: string): string {
  return foldPartySurface(value)
    .replace(/1/g, 'i')
    .replace(/0/g, 'o');
}

export function isSalesContactLabel(value: string): boolean {
  return SALES_CONTACT_LABEL.test(foldPartySurface(value));
}

export function isPluralOrCategoryCustomerHeading(value: string): boolean {
  const folded = foldPartySurface(value);
  if (!folded || LEGAL_FORM.test(value) || /\d/.test(folded)) return false;
  if (PLURAL_OR_CATEGORY_CUSTOMER_HEADING.test(folded)) return true;
  if (/^(?:clienti|customers|clientes)\b/.test(folded) && folded.split(/\s+/).filter(Boolean).length >= 2) {
    return true;
  }
  return false;
}

export function looksLikePartySectionHeading(value: string): boolean {
  const folded = foldPartySurface(value);
  if (!folded) return false;
  if (LEGAL_FORM.test(value)) return false;
  const heading = foldHeadingOcrConfusions(value);
  if (isSalesContactLabel(value)) return true;
  if (/^(?:destinazione(?:\s+merce)?|consegna|ship[\s\-]*to|delivery(?:\s+address)?|destination|goods\s+destination|lieferadresse|warenempfaenger|indirizzo\s+di\s+consegna)(?:\s*\/\s*.+)?$/.test(heading)) {
    return true;
  }
  if (/\b(?:destinazione\s+merce|ship[\s\-]*to|delivery\s+address|lieferadresse)\b/.test(heading)) {
    return true;
  }
  if (/^[a-z][a-z' ]{2,40}\s*\/\s*[a-z][a-z' ]{2,40}$/.test(heading)) return true;
  return isPluralOrCategoryCustomerHeading(value);
}

/** Delivery site / plant labels are recipient context, not bill-to customer organizations. */
export function looksLikeRecipientSiteName(value: string): boolean {
  const text = value.trim();
  if (!text || LEGAL_FORM.test(text)) return false;
  if (/^(?:stabilimento|plant|site|facility|warehouse|magazzino|dep[oó]sito|standort|werk(?:statt)?|filiale)\b/i.test(text)) {
    return true;
  }
  return /\b(?:stabilimento|plant|site|facility|warehouse|magazzino)\s+[A-ZÀ-ÿ]/i.test(text)
    && text.split(/\s+/).filter(Boolean).length <= 4;
}

const DOCUMENT_FIELD_HEADING =
  /\b(?:tipo\s+(?:doc\w*|pagament\w*|chiusur\w*)|documento\s+di\s+chiusur|document\s+type|type\s+de\s+document|tipo\s+documento|dte\s+docem\w*|data\s+documento|date\s+document|livraison\s+souhait|requested\s+delivery|data\s+consegna\s+richiesta|lieferdatum|delivery\s+date|date\s+de\s+livraison)\b/i;

const DOCUMENT_IDENTITY_LABEL =
  /\b(?:auftragsnummer|bestellnummer|angebotsnummer|rechnungsnummer|belegnummer|ordernummer|order\s*(?:no\.?|n[°ºo]\.?|number|nr\.?)|quote\s*(?:no\.?|n[°ºo]\.?|number)|quotation\s*(?:no\.?|number)|invoice\s*(?:no\.?|n[°ºo]\.?|number|nr\.?)|document\s*(?:no\.?|n[°ºo]\.?|number)|n[°ºo]\.?\s*(?:documento|preventivo|fattura|ordine|commessa)|numero\s+(?:documento|preventivo|fattura|ordine|commessa|offerta)|n\.?\s*preventivo|quotation\s+no\.?)\b/i;

const DOCUMENT_TYPE_WITH_IDENTIFIER =
  /^(?:preventivo|presupuesto|fattura|facture|invoice|order|ordine|auftrag(?:sbest[äa]tigung)?|rechnung|quote|quotation|oferta)\b/i;

/** Order/quote/invoice identity lines are metadata, never an organization name. */
export function looksLikeDocumentIdentityAsOrganization(value: string): boolean {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || LEGAL_FORM.test(text)) return false;
  if (DOCUMENT_IDENTITY_LABEL.test(text)) return true;
  if (DOCUMENT_TYPE_WITH_IDENTIFIER.test(text) && /(?:[A-Z]{2,8}\s*[-/]\s*)?\d/.test(text)) return true;
  return false;
}

const TOTALS_OR_TABLE_HEADER_AS_NAME =
  /^(?:goods\s+subtotal|taxable\s+subtotal|sous[-\s]?total(?:\s+marchandises)?|imponibile(?:\s+merc[ei])?|subtotale|base\s+taxable|base\s+imponib\w*|grand\s+total|total\s+ttc|montant\s+ht|zwischensumme|gesamtbetrag|line\s+total|vat\s*%?|iva\s*%?|tva\s*%?)\s*:?$/i;

const LEGAL_FORM =
  /\b(?:s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|sarl|gmbh|ltd\.?|inc\.?|bv|sl|ag|s\.?a\.?)\b/i;

const IDENTIFIER_OR_CONTACT =
  /^(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|[A-Z0-9]+(?:[-/][A-Z0-9]+){1,4})$/i;

const BANK_OR_PAYMENT =
  /\b(?:iban|bic|swift|bonifico|bankverbindung|coordinate\s+bancarie|bank\s+details|filiale|agenzia\s+di|bank|banca|banque|banco)\b/i;

const EMAIL_OR_PHONE = /@|^(?:\+?\d[\d\s()./-]{6,})$/;
const AMOUNT_OR_DATE = /^(?:-?\d[\d\s.,]*\d(?:\s*(?:€|eur|usd|gbp|chf))?|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})$/i;

function tokenEditDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function bilingualSlashParts(folded: string): string[] {
  return folded
    .split(/\s*\/\s*/)
    .map((part) => part.replace(/[:]+$/, '').trim())
    .filter(Boolean);
}

function tokenLooksLikeCustomerReferenceMetadata(token: string): boolean {
  if (/^(?:vostro|your|notre|ihr|codice|code|nr\.?|n[°ºo]\.?|no\.?|number|nummer|riferimento|rif\.?|ref\.?)$/i.test(token)) {
    return true;
  }
  if (token.length >= 8 && tokenEditDistance(token, 'riferimento') <= 2) return true;
  if (token.length >= 5 && tokenEditDistance(token, 'codice') <= 1) return true;
  return false;
}

function isAtomicCustomerReferenceLabel(folded: string, original: string): boolean {
  if (CUSTOMER_REFERENCE_LABEL.test(folded)
    || CUSTOMER_REFERENCE_LABEL_REVERSED.test(folded)
    || CUSTOMER_REFERENCE_LABEL_ATOMIC.test(folded)) {
    return true;
  }
  if (LEGAL_FORM.test(original)) return false;
  const tokens = folded.replace(/\//g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  const hasCustomerWord = tokens.some((token) => /^(?:cliente|customer|client|kunde)s?$/i.test(token));
  const hasRefWord = tokens.some((token) => tokenLooksLikeCustomerReferenceMetadata(token));
  return hasCustomerWord && hasRefWord;
}

/** Customer-account labels (codice cliente, customer code, Kundennummer) are not party names. */
export function isCustomerReferenceLabel(value: string): boolean {
  const folded = foldPartySurface(value);
  if (!folded) return false;
  if (isAtomicCustomerReferenceLabel(folded, value)) return true;
  const parts = bilingualSlashParts(folded);
  if (parts.length < 2) return false;
  return parts.every((part) => isAtomicCustomerReferenceLabel(part, part));
}

export function isPartyLabelOnly(value: string): boolean {
  const folded = value.trim().replace(/[:]+$/, '').replace(/\s+/g, ' ');
  if (!folded) return false;
  if (isCustomerReferenceLabel(folded) || PARTY_LABEL_ONLY.test(folded)) return true;
  const heading = foldHeadingOcrConfusions(value);
  if (/^[a-z][a-z' ]{2,40}\s*\/\s*[a-z][a-z' ]{2,40}$/.test(heading) &&
    /(?:cliente|customer|bill|ship|destinaz|destinat|fornit|supplier|sede|consegna|delivery)/i.test(heading)) {
    return true;
  }
  return false;
}

export function isLegalSuffixOnly(value: string): boolean {
  if (!LEGAL_FORM.test(value)) return false;
  const stem = value
    .replace(LEGAL_FORM, ' ')
    .replace(/[.\s,/-]/g, '')
    .trim();
  if (!stem) return true;
  if (isShortBrandOrganizationToken(stem) || (stem.length >= 2 && /[A-Za-z0-9]/.test(stem))) return false;
  return stem.length < 3;
}

export function isPartyIdentifierNotName(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (LEGAL_FORM.test(text) && text.split(/\s+/).filter(Boolean).length >= 2) return false;
  if (EMAIL_OR_PHONE.test(text)) return true;
  if (AMOUNT_OR_DATE.test(text)) return true;
  if (/\b(?:iban|bic|swift|p\.?\s*iva|vat|tva|mwst|c\.?f\.?|codice\s+fiscale)\b/i.test(text)
    && text.split(/\s+/).length <= 4) {
    return true;
  }
  const compact = text.replace(/\s/g, '');
  if (IDENTIFIER_OR_CONTACT.test(compact) && /\d/.test(compact) && compact.length >= 6 && compact.length <= 32) {
    const letters = compact.replace(/[^A-Za-z]/g, '');
    const digits = compact.replace(/\D/g, '');
    return digits.length >= 3 && letters.length <= 12;
  }
  return false;
}

export function isBankOrPaymentFragment(value: string): boolean {
  return BANK_OR_PAYMENT.test(value);
}

export function isDocumentFieldHeading(value: string): boolean {
  return DOCUMENT_FIELD_HEADING.test(value);
}

const COUNTRY_OR_REGION_NAME =
  /^(?:france|italy|italia|spain|espa[nñ]a|germany|deutschland|switzerland|suisse|austria|belgium|belgio|portugal|netherlands|europe|europa|united\s+kingdom|united\s+states|u\.?s\.?a\.?|uk|england|scotland|wales)$/i;

const UK_POSTCODE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i;
const CONTINENTAL_POSTAL = /\b\d{4,5}\s+[A-ZÀ-ÿ]/;

export function looksLikeDeliveryRequestOrDateField(value: string): boolean {
  const folded = foldPartySurface(value);
  if (!folded) return false;
  if (DOCUMENT_FIELD_HEADING.test(value) || DOCUMENT_FIELD_HEADING.test(folded)) return true;
  if (/\b(?:livraison\s+souhait|requested\s+delivery|data\s+consegna|lieferdatum|delivery\s+date|date\s+de\s+livraison)\b/i.test(folded)
    && /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(value)) {
    return true;
  }
  return false;
}

export function looksLikeAddressLikeOrganizationName(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (LEGAL_FORM.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1] ?? '';
  if (
    words.length >= 2
    && words.length <= 4
    && /^\d{1,3}[A-Z]?(?:\/[A-Z0-9]+)?$/i.test(lastWord)
  ) {
    return true;
  }
  if (/\b(?:tee|gade|vej|väg|vag|katu|tänav|tnav)\b/i.test(text)) return true;
  if (COUNTRY_OR_REGION_NAME.test(text)) return true;
  if (UK_POSTCODE.test(text) && !LEGAL_FORM.test(text)) return true;
  if (CONTINENTAL_POSTAL.test(text) && text.split(/\s+/).filter(Boolean).length <= 6 && !LEGAL_FORM.test(text)) {
    return true;
  }
  if (/\b(?:united\s+kingdom|united\s+states)\b/i.test(text) && !LEGAL_FORM.test(text)) return true;
  return false;
}

const PARTY_FUNCTION_WORD =
  /^(?:de|del|des|di|da|du|of|the|and|und|von|van|der|den|dem|la|le|el|les|los|las|y|e|a)$/i;

function tokenLooksLikeStrongOcrJunk(token: string): boolean {
  if (/[a-zà-ÿ][A-ZÀ-Ü]/.test(token)) return true;
  const letters = token.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (/^[a-zà-ÿ]{5,10}$/.test(letters)) return true;
  if (/^[A-ZÀ-Ü][a-zà-ÿ]{0,2}[A-ZÀ-Ü]$/.test(letters)) return true;
  const vowels = (letters.match(/[aeiouàèéìòù]/gi) ?? []).length;
  return letters.length >= 5 && vowels <= 1;
}

function tokenLooksLikeLowInformation(token: string): boolean {
  if (PARTY_FUNCTION_WORD.test(token) || LEGAL_FORM.test(token)) return false;
  const letters = token.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 2 || letters.length > 4) return false;
  return /^[a-zà-ÿ]+$/.test(letters);
}

/** OCR chrome / mixed-case junk is not an organization, even if it has two tokens. */
export function looksLikeOcrGarbageOrganization(value: string): boolean {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || LEGAL_FORM.test(text)) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  const content = tokens.filter((token) => !PARTY_FUNCTION_WORD.test(token));
  if (content.length === 0) return true;
  const strongJunk = content.filter((token) => tokenLooksLikeStrongOcrJunk(token));
  if (strongJunk.length >= content.length) return true;
  const lowInformation = content.filter((token) =>
    !tokenLooksLikeStrongOcrJunk(token) && tokenLooksLikeLowInformation(token));
  return content.length >= 2
    && strongJunk.length >= 1
    && strongJunk.length + lowInformation.length >= content.length;
}

export function organizationQualityScore(name: string, evidence?: PartyNameEvidence): number {
  const text = name.trim();
  if (!text || looksLikeOcrGarbageOrganization(text)) return 0;
  if (classifyPartyNameRejection(text) && !LEGAL_FORM.test(text)) return 0;
  let score = partyNameConfidence(text);
  if (LEGAL_FORM.test(text) || evidence?.hasLegalSuffix) score += 0.35;
  if (evidence?.hasAddress || evidence?.hasPostal) score += 0.2;
  if (evidence?.hasVat) score += 0.2;
  if (evidence?.hasEmail || evidence?.hasPhone || evidence?.hasWebsite) score += 0.15;
  if (/^[A-ZÀ-Ü0-9 .,'&-]{8,}$/.test(text) && /[A-ZÀ-Ü]{3,}/.test(text)) score += 0.1;
  return score;
}

export function classifyPartyNameRejection(value: string | null | undefined): PartyRejectionReason | undefined {
  const text = value?.trim() ?? '';
  if (!text) return 'empty';
  if (isPartyLabelOnly(text)) return 'label_only';
  if (looksLikePartySectionHeading(text) || isSalesContactLabel(text)) return 'section_heading';
  if (isDocumentFieldHeading(text) || TOTALS_OR_TABLE_HEADER_AS_NAME.test(text) || looksLikeDocumentIdentityAsOrganization(text)) {
    return 'document_field_heading';
  }
  if (isLegalSuffixOnly(text)) return 'legal_suffix_only';
  if (isBankOrPaymentFragment(text)) return 'bank_or_payment';
  if (isPartyIdentifierNotName(text)) return 'identifier';
  if (text.length < 3 || text.length > 120) return 'implausible_organization';
  if (/^[A-Za-zÀ-ÿ]{3,5}$/.test(text) && !LEGAL_FORM.test(text)) return 'implausible_organization';
  if (looksLikeOcrGarbageOrganization(text)) return 'implausible_organization';
  if (looksLikeDeliveryRequestOrDateField(text) || looksLikeAddressLikeOrganizationName(text)) {
    return 'document_field_heading';
  }
  return undefined;
}

export function partyNameLooksLikeItemDescription(
  name: string | null | undefined,
  itemDescriptions: readonly string[],
): boolean {
  const folded = name?.trim().toLowerCase() ?? '';
  if (!folded || LEGAL_FORM.test(name ?? '')) return false;
  return itemDescriptions.some((desc) => {
    const other = desc.trim().toLowerCase();
    if (!other) return false;
    if (other === folded) return true;
    if (folded.length >= 10 && other.includes(folded)) return true;
    if (other.length >= 10 && folded.includes(other)) return true;
    return false;
  });
}

export interface PartyNameEvidence {
  hasAddress?: boolean;
  hasPostal?: boolean;
  hasCity?: boolean;
  hasVat?: boolean;
  hasPhone?: boolean;
  hasEmail?: boolean;
  hasLegalSuffix?: boolean;
  hasWebsite?: boolean;
}

/** Title-case 2–5 letter tokens (OCR/UI chrome) are never organization names. */
export function isUiOrOcrJunkPartyToken(value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text.length > 5 || LEGAL_FORM.test(text)) return false;
  return /^[A-ZÀ-Ü][a-zà-ÿ]{1,4}$/.test(text);
}

/** Short all-caps / digit brands (IBM, SAP, 3M) may be valid when a party block is complete. */
export function isShortBrandOrganizationToken(value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text.length > 5 || LEGAL_FORM.test(text)) return false;
  if (isUiOrOcrJunkPartyToken(text)) return false;
  const folded = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return /^[A-Z0-9]{2,5}$/.test(folded) && /[A-Z]/.test(folded);
}

function partyEvidenceComplete(evidence?: PartyNameEvidence): boolean {
  if (!evidence) return false;
  return !!(
    evidence.hasAddress
    || evidence.hasPostal
    || evidence.hasCity
    || evidence.hasVat
    || evidence.hasPhone
    || evidence.hasEmail
    || evidence.hasLegalSuffix
    || evidence.hasWebsite
  );
}

/**
 * Shared organization-name gate for customer / ship-to / recipient / bill-to.
 * Length alone is not enough: short brands survive only with block evidence.
 */
export function organizationNameAllowed(
  value: string | null | undefined,
  evidence?: PartyNameEvidence,
): boolean {
  const text = value?.trim() ?? '';
  if (!text) return false;
  if (isUiOrOcrJunkPartyToken(text) || isPartyLabelOnly(text)) return false;
  const reason = classifyPartyNameRejection(text);
  if (!reason) return true;
  if (reason !== 'implausible_organization') return false;
  if (isShortBrandOrganizationToken(text) || text.length <= 5) {
    return partyEvidenceComplete(evidence);
  }
  return false;
}

export function isImplausibleOrganizationName(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  // A real short all-caps brand can look like OCR garbage to the generic noise
  // detector. Preserve it here; downstream party-block evidence still decides
  // whether the brand is eligible for issuer/customer assignment.
  if (isShortBrandOrganizationToken(text)) return false;
  if (isUiOrOcrJunkPartyToken(text) || looksLikeOcrGarbageOrganization(text)) return true;
  const reason = classifyPartyNameRejection(text);
  if (!reason) return false;
  if (reason === 'implausible_organization' && isShortBrandOrganizationToken(text)) {
    return false;
  }
  return true;
}

export function partyNameConfidence(value: string | null | undefined): number {
  const text = value?.trim() ?? '';
  if (!text) return 0;
  if (classifyPartyNameRejection(text)) return 0;
  let score = 0.45;
  if (LEGAL_FORM.test(text)) score += 0.25;
  if (text.split(/\s+/).filter(Boolean).length >= 2) score += 0.15;
  if (/[A-Za-z\u00c0-\u024f]{4,}/.test(text)) score += 0.1;
  return Math.min(1, score);
}

/**
 * Replace only when the current value is empty, a label, an identifier,
 * a bank fragment, implausible, or strictly weaker than a strong incoming name.
 */
export function shouldReplacePartyValue(
  current: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  const next = incoming?.trim() ?? '';
  if (!next || isImplausibleOrganizationName(next)) return false;
  const existing = current?.trim() ?? '';
  if (!existing) return true;
  if (isImplausibleOrganizationName(existing)) return true;
  const existingWords = existing.split(/\s+/).filter(Boolean).length;
  if (existingWords >= 2 && partyNameConfidence(existing) >= 0.45) return false;
  return partyNameConfidence(next) > partyNameConfidence(existing) + 0.35;
}

export function samePartyName(left: string | null | undefined, right: string | null | undefined): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = fold(left ?? '');
  const b = fold(right ?? '');
  return a.length >= 4 && a === b;
}

export function resolveExclusivePartyRoles(input: {
  issuer?: string | null;
  customer?: string | null;
}): { issuer: string | null; customer: string | null } {
  const issuer = isImplausibleOrganizationName(input.issuer) ? null : input.issuer?.trim() ?? null;
  const customer = isImplausibleOrganizationName(input.customer) ? null : input.customer?.trim() ?? null;
  if (issuer && customer && samePartyName(issuer, customer)) {
    return { issuer, customer: null };
  }
  return { issuer, customer };
}
