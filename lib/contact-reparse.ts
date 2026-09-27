import type { Address, BusinessCard, OcrQualityMetadata } from '../types';
import { parseCardFromPages } from './parser';
import { pagesFromRawText } from './extraction-review';
import type { CardPage } from './parser-engine/pipeline';
import { getAllContacts } from './storage';
import { clearAllAppData } from './app-migration';
import { scanBusinessCardBest } from './ocr';
import { resolveImageUri } from './image-uri';
import {
  clearAllContactsWithAssets,
  replaceSavedContactImagePage,
  updateContactWithAssetCleanup,
  type ValidateRotatedContact,
} from './persistence';
import { PARSER_BUILD_ID } from './parser-version';
import { diffReparseCard, type ReparseFieldChange } from './reparse-diff';
import {
  mergeReparseWithQualityGate,
  type ReparseFieldDecision,
} from './reparse-quality-gate';
import type { ExtractedField } from './parser-engine/card-extraction-result';
import {
  mergeReparsedEmailState,
  type EmailEvidenceMetadata,
} from './email-evidence';
import { alignCompanyToEmailDomain } from './parser-engine/validators/company';
import { aggregateOcrQuality } from './ocr-quality';
import { buildCardTitle } from './card-title';
import { runtimeLogger } from './safe-runtime-logger';
import type { OperationLease } from './guarded-operation';
import {
  applyContactCandidatePreservingManual,
  applyContactReparseProposal,
  contactReviewFingerprint,
  createContactReparseProposal,
  type ApplyContactReparseResult,
  type ContactReparseFieldKey,
  type ContactReparseProposal,
} from './contact-review-state';

function isValidItalianVat(v: string | undefined | null): boolean {
  const digits = (v ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let n = parseInt(digits[i]!, 10);
    if ((i & 1) === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function isValidItalianCf16(v: string | undefined | null): boolean {
  return /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test((v ?? '').trim());
}

function labeledFiscalDigitCandidates(rawText: string): string[] {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:p\s*[.\s]*[il1]|partita\s+iva|vat)\b/i.test(lines[index]!)) continue;
    const window = `${lines[index]} ${lines[index + 1] ?? ''}`;
    const tokens = window.match(/[A-Z0-9-]{10,16}/gi) ?? [];
    for (const token of tokens) {
      const digits = token
        .toUpperCase()
        .replace(/[OQ]/g, '0')
        .replace(/[IL]/g, '1')
        .replace(/S/g, '5')
        .replace(/[^0-9]/g, '');
      if (digits.length >= 10 && digits.length <= 11) candidates.push(digits);
    }
  }
  return [...new Set(candidates)];
}

/**
 * Una sequenza posta sotto un'etichetta fiscale OCR (anche "PL" al posto di
 * "P.I.") non puo diventare un telefono. Non la promuoviamo a P.IVA: la
 * usiamo esclusivamente come barriera contro un recapito falso.
 */
function fiscalLabelPhoneArtifactDigits(rawText: string): string[] {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:p\s*[.\s]*[il1]|partita\s+iva|cod(?:ice)?\s*fisc(?:ale)?|c\s*[.\s]*f\s*[.]?)\b/i.test(lines[index]!)) {
      continue;
    }
    const window = `${lines[index]} ${lines[index + 1] ?? ''}`;
    for (const token of window.match(/[A-Z0-9-]{8,18}/gi) ?? []) {
      const digits = token
        .toUpperCase()
        .replace(/[OQ]/g, '0')
        .replace(/[IL]/g, '1')
        .replace(/S/g, '5')
        .replace(/[^0-9]/g, '');
      if (digits.length >= 9) candidates.push(digits);
    }
  }
  return [...new Set(candidates)];
}

function isBinaryNoisePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  // Un numero di contatto di un biglietto non è una sequenza di 7 cifre:
  // queste provengono normalmente da date, CAP o rumore grafico OCR.
  if (digits.length < 8) return true;
  const binaryDigits = digits.replace(/[01]/g, '').length;
  return binaryDigits <= 1;
}

function recoverLabeledItalianVat(rawText: string): string | undefined {
  return labeledFiscalDigitCandidates(rawText).find(isValidItalianVat);
}

/** Conserva P.IVA/CF validi se il nuovo parse non trova alternative migliori. */
function preserveFiscalFields(
  prev: BusinessCard,
  next: BusinessCard
): Pick<BusinessCard, 'vatNumber' | 'taxCode'> {
  let vatNumber = next.vatNumber;
  let taxCode = next.taxCode;

  if (!vatNumber?.trim() && prev.vatNumber?.trim() && isValidItalianVat(prev.vatNumber)) {
    vatNumber = prev.vatNumber;
  }
  if (
    !vatNumber?.trim() &&
    prev.taxCode?.trim() &&
    isValidItalianVat(prev.taxCode) &&
    !isValidItalianCf16(prev.taxCode)
  ) {
    vatNumber = prev.taxCode;
  }
  if (!taxCode?.trim() && prev.taxCode?.trim()) {
    if (isValidItalianCf16(prev.taxCode)) {
      taxCode = prev.taxCode;
    } else if (isValidItalianVat(prev.taxCode) && !vatNumber?.trim()) {
      taxCode = prev.taxCode;
    }
  }
  if (
    taxCode?.trim() &&
    isValidItalianVat(taxCode) &&
    !isValidItalianCf16(taxCode) &&
    !vatNumber?.trim()
  ) {
    vatNumber = taxCode;
    if (prev.taxCode?.trim() && isValidItalianCf16(prev.taxCode)) {
      taxCode = prev.taxCode;
    } else {
      taxCode = undefined;
    }
  }

  return { vatNumber, taxCode };
}

const NON_GEOGRAPHIC_CITY_RE =
  /^(?:room|building|block|floor|suite|unit|office)\b/i;
const CONTACT_CITY_RE =
  /(?:https?:\/\/|www\.|@|\b(?:web|website|e-?mail|tel|fax)\b)/i;
const STREET_DESIGNATOR_RE =
  /\b(?:street|road|avenue|boulevard|via|viale|corso|piazza|stra(?:ss|\u00df)e|straat|rue)\b/i;
const POSTAL_BOX_RE = /^(?:p\.?\s*o\.?\s*box|postfach|casella postale)\b/i;

function normalizedEvidence(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function withinOneEdit(left: string, right: string): boolean {
  const a = normalizedEvidence(left);
  const b = normalizedEvidence(right);
  if (!a || !b || Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  if (a.length === b.length) {
    let differences = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++differences > 1) return false;
    }
    return true;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      longIndex += 1;
    }
  }
  return true;
}

function reconcileRuntimePerson(
  prev: BusinessCard,
  next: BusinessCard
): Pick<BusinessCard, 'firstName' | 'lastName'> {
  const sameLastName =
    normalizedEvidence(prev.lastName) === normalizedEvidence(next.lastName);
  const previousEvidence = prev.extractionReview?.firstName;
  const nextEvidence = next.extractionReview?.firstName;
  const parsedInitial = prev.contactReviewState?.parsedInitial;
  const initialFirstName = parsedInitial?.firstName?.trim() ?? '';
  const initialLastName = parsedInitial?.lastName?.trim() ?? '';
  const immutableInitialMatchesPrevious =
    normalizedEvidence(initialFirstName) ===
      normalizedEvidence(prev.firstName) &&
    normalizedEvidence(initialLastName) ===
      normalizedEvidence(prev.lastName);
  const recoverImmutableInitial =
    prev.contactReviewState?.tracking === 'parsed' &&
    prev.contactReviewState.fieldOrigins.firstName === 'reparse' &&
    !Object.prototype.hasOwnProperty.call(
      prev.contactReviewState.manualOverrides,
      'firstName'
    ) &&
    initialFirstName.length > 0 &&
    normalizedEvidence(initialLastName) === normalizedEvidence(prev.lastName) &&
    normalizedEvidence(initialLastName) === normalizedEvidence(next.lastName) &&
    normalizedEvidence(prev.firstName) === normalizedEvidence(next.firstName) &&
    normalizedEvidence(initialFirstName) !== normalizedEvidence(next.firstName) &&
    withinOneEdit(initialFirstName, next.firstName) &&
    normalizedEvidence(nextEvidence?.value ?? undefined) ===
      normalizedEvidence(next.firstName);
  if (recoverImmutableInitial) {
    return { firstName: initialFirstName, lastName: initialLastName };
  }
  const previousScore = previousEvidence?.score ?? 0;
  const nextScore = nextEvidence?.score ?? 0;
  const previousIsProven =
    normalizedEvidence(previousEvidence?.value ?? undefined) ===
      normalizedEvidence(prev.firstName) &&
    normalizedEvidence(nextEvidence?.value ?? undefined) ===
      normalizedEvidence(next.firstName) &&
    (
      previousScore > nextScore ||
      (immutableInitialMatchesPrevious && previousScore + 0.01 >= nextScore)
    );
  if (
    sameLastName &&
    prev.firstName.trim() &&
    next.firstName.trim() &&
    withinOneEdit(prev.firstName, next.firstName) &&
    previousIsProven
  ) {
    return { firstName: prev.firstName, lastName: prev.lastName };
  }
  return { firstName: next.firstName, lastName: next.lastName };
}

/**
 * Preferisce una riga nome/cognome realmente letta dall'OCR quando la
 * local-part di una mailbox personale la conferma (m.frati / MARIO FRATI).
 * Non usa il dominio, quindi non trasforma mai il nome in un brand aziendale.
 */
function recoverPersonFromRawAndEmail(
  person: Pick<BusinessCard, 'firstName' | 'lastName'>,
  rawText: string,
  emails: readonly string[]
): Pick<BusinessCard, 'firstName' | 'lastName'> {
  const firstKey = normalizedEvidence(person.firstName);
  if (firstKey.length < 3) return person;
  // Se l'inizio della mailbox osservata e' un nome quasi identico (una sola
  // lettera OCR), puo' correggere il nome letto. Non ricava mai un nome dal
  // dominio e non modifica cognome/azienda.
  for (const email of emails) {
    const localFirst = email.split('@')[0]?.split(/[._-]/)[0] ?? '';
    if (
      localFirst.length >= 3 &&
      localFirst.length === firstKey.length &&
      withinOneEdit(normalizedEvidence(localFirst), firstKey) &&
      normalizedEvidence(localFirst) !== firstKey
    ) {
      return {
        firstName: localFirst.charAt(0).toUpperCase() + localFirst.slice(1).toLowerCase(),
        lastName: person.lastName,
      };
    }
  }
  // Un nome può essere seguito da una qualifica sulla stessa riga
  // ("Alexander Pohl, CEO"). Se la mailbox personale conferma
  // iniziale+cognome, la riga OCR è più affidabile del cognome fuso.
  const nameLine = /^(?:(?:dott(?:\.ssa)?|dr|prof|ing|arch|avv|geom)\.?\s+)?([A-Za-zÀ-Ü][A-Za-zÀ-Ü'’-]{1,30})\s+([A-Za-zÀ-Ü][A-Za-zÀ-Ü'’-]{1,40})(?:\s*,\s*[A-Za-zÀ-Ü][A-Za-zÀ-Ü0-9'’&/ .-]{1,70})?$/i;
  for (const rawLine of rawText.split(/\r?\n/)) {
    const match = rawLine.trim().match(nameLine);
    if (!match) continue;
    const first = match[1]!;
    const last = match[2]!;
    if (normalizedEvidence(first) !== firstKey) continue;
    const expectedInitial = `${first.charAt(0)}${last}`;
    const expectedFull = `${first}${last}`;
    const confirmed = emails.some((email) => {
      const local = normalizedEvidence(email.split('@')[0]);
      return local === normalizedEvidence(expectedInitial) ||
        local === normalizedEvidence(expectedFull);
    });
    if (confirmed) return { firstName: first, lastName: last };
  }
  return person;
}

/**
 * Elimina una mailbox OCR monca soltanto quando il nominativo della stessa
 * carta conferma una mailbox più completa con identico dominio. Non tocca
 * alias validi come "m.rossi": il frammento deve corrispondere al cognome
 * (entro un singolo errore OCR) ed essere molto più corto.
 */
function removeTruncatedSamePersonEmails(
  evidence: readonly EmailEvidenceMetadata[],
  person: Pick<BusinessCard, 'firstName' | 'lastName'>
): EmailEvidenceMetadata[] {
  const first = normalizedEvidence(person.firstName);
  const last = normalizedEvidence(person.lastName);
  if (first.length < 3 || last.length < 4) return [...evidence];

  return evidence.filter((candidate) => {
    const [local = '', host = ''] = candidate.value.toLowerCase().split('@');
    const localKey = normalizedEvidence(local);
    if (!host || localKey.length < 3 || localKey.length > last.length) return true;

    return !evidence.some((other) => {
      if (other === candidate) return false;
      const [otherLocal = '', otherHost = ''] = other.value.toLowerCase().split('@');
      const otherKey = normalizedEvidence(otherLocal);
      return otherHost === host &&
        otherKey.length >= first.length + last.length &&
        otherKey.includes(first) &&
        otherKey.includes(last) &&
        withinOneEdit(localKey, last);
    });
  });
}

/**
 * Ricompone intestazioni aziendali spezzate in tre righe, ad esempio
 * "PROVINCIA REGIONALE / DI / MESSINA". Richiede il connettore isolato e
 * una sola parola alfabetica successiva: non concatena slogan o indirizzi.
 */
function recoverCompanyConnectorContinuation(company: string, rawText: string): string {
  const current = company.trim();
  if (!current || current.split(/\s+/).length < 2) return current;
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const companyKey = normalizedEvidence(current);
  const index = lines.findIndex((line) => normalizedEvidence(line) === companyKey);
  if (index < 0) return current;

  const connector = lines[index + 1]?.replace(/[.:,;]+$/g, '').trim();
  const continuation = lines[index + 2]?.replace(/[.:,;]+$/g, '').trim();
  if (!connector || !continuation) return current;
  if (!/^(?:di|del|dello|della|dei|degli|delle|d['’])$/i.test(connector)) return current;
  if (!/^[A-Za-zÀ-Ü][A-Za-zÀ-Ü'’-]{1,40}$/.test(continuation)) return current;
  return `${current} ${connector.toLowerCase()} ${continuation}`;
}

function websiteHost(value: string | undefined): string | undefined {
  const host = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/, 1)[0]
    ?.replace(/\.+$/, '');
  return host && /^[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}$/.test(host)
    ? host
    : undefined;
}

const RUNTIME_GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'libero.it', 'live.com', 'tiscali.it', 'alice.it', 'virgilio.it', 'tin.it',
  'email.it', 'pec.it', 'legalmail.it',
]);

function inferRuntimeWebsiteFromEmails(emails: readonly string[]): string | undefined {
  const hosts = [...new Set(
    emails
      .map((email) => websiteHost(email.split('@').pop()))
      .filter((host): host is string => Boolean(host))
      .filter((host) => !RUNTIME_GENERIC_EMAIL_DOMAINS.has(host) && !/pec/i.test(host))
  )];
  return hosts.length === 1 ? `www.${hosts[0]}` : undefined;
}

/** Recupera un sito scritto esplicitamente nel raw OCR, senza inferirlo da dati vecchi. */
function inferObservedWebsiteFromRaw(rawText: string): string | undefined {
  // Un dominio e' una prova di sito solo se l'OCR ha letto il suo marcatore
  // esplicito. Senza http/www sequenze come "P.IVA", "1.De Zio" o
  // "Marco Longo" possono sembrare domini, ma non lo sono.
  const matches = rawText.match(/\b(?:https?:\/\/|www\.)[a-z0-9][a-z0-9.-]*(?:\.[a-z]{2,24})+\b/gi) ?? [];
  for (const value of matches) {
    const host = value
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .toLowerCase();
    if (host && !/^(?:gmail|yahoo|hotmail|outlook)\./i.test(host)) {
      return `www.${host}`;
    }
  }
  return undefined;
}

function observedDomainRoot(value: string | undefined): string | undefined {
  const host = websiteHost(value);
  if (!host) return undefined;
  const label = host.split('.')[0]?.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return label && label.length >= 3 ? label : undefined;
}

function formatObservedDomainBrand(root: string): string {
  return root
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^[0-9]+[a-z]+$/i.test(part)) return part.toUpperCase();
      if (part.length <= 3 && /[0-9]/.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

function compactObservedDottedAcronym(value: string): string {
  const match = value.trim().match(/^((?:[A-Z]\.?\s*){2,})(.*)$/);
  if (!match) return value;
  const compact = match[1]!.replace(/\s+/g, '');
  return `${compact}${match[2] ?? ''}`.replace(/\s+/g, ' ').trim();
}

function lineHasDomainTokens(line: string, root: string): boolean {
  const words = line.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const matching = words.filter((word) => root.includes(word));
  return matching.length >= 2 && matching.reduce((total, word) => total + word.length, 0) >= 7;
}

/**
 * La ragione sociale e' recuperata solo da prove osservate sulla stessa
 * carta: dominio esplicito o almeno due mailbox aziendali valide. Non usa mai
 * un logo/grafica OCR isolata come fonte decisiva.
 */
export function recoverCompanyFromStructuralEvidence(
  company: string,
  emails: readonly string[],
  observedWebsite: string | undefined,
  rawText: string,
): string {
  const current = compactObservedDottedAcronym(company.trim());
  const currentKey = normalizedEvidence(current);
  if (!currentKey) return current;
  const roots = emails
    .map((email) => observedDomainRoot(email.split('@')[1]))
    .filter((root): root is string => Boolean(root));
  const repeatedRoot = [...new Set(roots)].find((root) => roots.filter((item) => item === root).length >= 2);
  const websiteRoot = observedDomainRoot(observedWebsite);
  const corroboratedRoot = repeatedRoot ?? websiteRoot ?? roots[0];
  if (!corroboratedRoot) return current;

  const rootKey = normalizedEvidence(corroboratedRoot);
  // Il suffisso geografico del dominio non e' parte del brand. Una differenza
  // di un solo carattere rispetto alla radice osservata e' il caso OCR
  // correggibile (ORIUM / corium-mi), non una conversione societaria.
  for (const root of [...new Set(roots)]) {
    const brandRoot = root.split(/[-_]/)[0] ?? root;
    const brandKey = normalizedEvidence(brandRoot);
    if (
      current.split(/\s+/).length === 1 && brandKey.length >= 4 &&
      currentKey !== brandKey && withinOneEdit(currentKey, brandKey)
    ) {
      return current === current.toUpperCase()
        ? brandRoot.toUpperCase()
        : formatObservedDomainBrand(brandRoot);
    }
  }
  // Se il dominio esplicito contiene i token di una ragione sociale con '&',
  // quella riga testuale prevale su una parola OCR non correlata (es. logo).
  const phrase = rawText.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /&/.test(line) && !/@|https?:\/\/|www\./i.test(line))
    .find((line) => lineHasDomainTokens(line, rootKey));
  if (phrase && currentKey !== rootKey && !rootKey.includes(currentKey)) {
    return phrase
      .replace(/\s+di\s+[\p{L}][\p{L}'’ .-]{2,}$/iu, '')
      .replace(/\s*&\s*/g, ' & ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Un dominio con trattino e una company OCR fusa costituiscono una prova
  // non ambigua della separazione (3a-strategy -> 3A Strategy).
  if (websiteRoot && /[-_]/.test(websiteRoot) && currentKey === rootKey) {
    return formatObservedDomainBrand(websiteRoot);
  }

  // Due mailbox osservate dello stesso dominio sono una prova piu' forte di
  // una sola parola non correlata, tipicamente un logo semi-grafico.
  if (repeatedRoot && current.split(/\s+/).length === 1 &&
      currentKey !== rootKey && !rootKey.includes(currentKey)) {
    return formatObservedDomainBrand(repeatedRoot);
  }

  // Studio associato: il dominio concatena i due cognomi, l'OCR ha letto '&'
  // e la seconda parte e' presente nel testo. Nessun elenco fisso di aziende.
  if (current.split(/\s+/).length === 1 && rootKey.startsWith(currentKey)) {
    const remainder = rootKey.slice(currentKey.length);
    if (remainder.length >= 3 && /&/.test(rawText) &&
      new RegExp(`(?:^|[^a-z])${remainder}(?:[^a-z]|$)|[a-z]${remainder}`, 'i').test(rawText.replace(/[^a-z]/gi, ' '))) {
      return `${current} & ${formatObservedDomainBrand(remainder)}`;
    }
  }
  return current;
}

/** Uniforma solo gli spazi introdotti dall'OCR dentro una mailbox. */
function normalizeObservedRawEmailText(rawText: string): string {
  return rawText.replace(
    /([a-z0-9._%+-]{2,})\s*@\s*([a-z0-9-]+(?:\s*\.\s*[a-z]{2,24})+)/gi,
    (_match, local: string, domain: string) => `${local}@${domain.replace(/\s/g, '')}`
  );
}

/**
 * Nel vero ri-OCR una email diventa operativa solo se e' leggibile nel raw
 * appena ottenuto. Questo elimina mail fuse dal layout (telefono@nome) e
 * recupera quelle con spazi attorno alla @, senza conservare dati vecchi.
 */
function observedRawEmailEvidence(
  rawText: string,
  person?: Pick<BusinessCard, 'firstName' | 'lastName'>
): EmailEvidenceMetadata[] {
  const normalizedRaw = normalizeObservedRawEmailText(rawText);
  const seen = new Set<string>();
  const evidence: EmailEvidenceMetadata[] = [];
  for (const match of normalizedRaw.matchAll(/\b([a-z][a-z0-9._%+-]{1,63}@[a-z0-9-]+(?:\.[a-z]{2,24})+)\b/gi)) {
    let value = match[1]!.toLowerCase();
    const [local, host] = value.split('@');
    const first = person?.firstName?.trim();
    const last = person?.lastName?.trim();
    // Solo l'iniziale OCR ambigua (1/I/l) viene riparata, e solo se la
    // parte restante e' il cognome della stessa persona: 1.dezio -> l.dezio.
    if (
      local && host && first && last &&
      /^[1il][._-]/i.test(local) &&
      normalizedEvidence(local.slice(1)) === normalizedEvidence(`.${last}`)
    ) {
      value = `${first.charAt(0).toLowerCase()}${local.slice(1)}@${host}`;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    evidence.push({
      value,
      rawValue: value,
      origin: 'observed',
      pageIndex: null,
      lineId: null,
      rawOcr: value,
      transformations: [],
      confidence: 0.75,
      validationStatus: 'valid',
      requiresReview: false,
      confirmed: true,
    });
  }
  return evidence;
}

/**
 * Se sito e dominio email differiscono per una sola lettera OCR, il dominio
 * della mailbox aziendale e' la fonte piu affidabile. Siti realmente diversi
 * (brand/prodotto) non vengono toccati.
 */
function reconcileNearEmailDomainWebsite(
  website: string | undefined,
  emails: readonly string[]
): string | undefined {
  const siteHost = websiteHost(website);
  if (!siteHost) return website;
  const emailHosts = [...new Set(
    emails
      .map((email) => websiteHost(email.split('@').pop()))
      .filter((host): host is string => Boolean(host))
      .filter((host) => !RUNTIME_GENERIC_EMAIL_DOMAINS.has(host))
  )];
  if (emailHosts.length !== 1 || emailHosts[0] === siteHost) return website;
  const emailHost = emailHosts[0]!;
  const siteRoot = siteHost.split('.').slice(0, -1).join('.');
  const emailRoot = emailHost.split('.').slice(0, -1).join('.');
  return siteRoot.length >= 5 && emailRoot.length >= 5 && withinOneEdit(siteRoot, emailRoot)
    ? `www.${emailHost}`
    : website;
}

function reconcileRuntimeWebsite(
  prev: BusinessCard,
  next: BusinessCard
): string | undefined {
  const rawText = prev.rawText ?? '';
  const operationalDomains = new Set(
    [...(prev.emails ?? []), ...(next.emails ?? [])]
      .map((email) => websiteHost(email.split('@').pop()))
      .filter((host): host is string => Boolean(host))
  );
  const rawEmailDomains = new Set<string>();
  for (const match of rawText.matchAll(/@([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    const host = websiteHost(match[1]);
    if (host) rawEmailDomains.add(host);
  }
  for (const match of rawText.matchAll(/@([a-z0-9.-]+)\s+([a-z]{2,})\b/gi)) {
    const host = websiteHost(`${match[1]}.${match[2]}`);
    if (host) rawEmailDomains.add(host);
  }

  const explicitWebsites = [...rawText.matchAll(/(?:https?:\/\/|www\.)[a-z0-9.-]+\.[a-z]{2,}/gi)]
    .map((match) => match[0]);
  const candidates = [next.website, prev.website, ...explicitWebsites]
    .filter((value): value is string => Boolean(value?.trim()));
  let selected = next.website;
  let selectedScore = -1;

  for (const value of candidates) {
    const host = websiteHost(value);
    if (!host) continue;
    let score = 0;
    if (operationalDomains.has(host)) score += 4;
    if (explicitWebsites.some((item) => websiteHost(item) === host)) score += 3;
    if (rawEmailDomains.has(host)) score += 2;
    if (normalizedEvidence(rawText).includes(normalizedEvidence(host))) score += 1;
    if (score > selectedScore) {
      selected = value === prev.website ? prev.website : `www.${host}`;
      selectedScore = score;
    }
  }

  return selectedScore >= 2 ? selected : next.website;
}

function isPlausibleRuntimeCity(
  value: string | undefined,
  country: string | undefined
): value is string {
  const city = value?.trim();
  if (
    !city ||
    /\d/.test(city) ||
    NON_GEOGRAPHIC_CITY_RE.test(city) ||
    CONTACT_CITY_RE.test(city)
  ) {
    return false;
  }
  const countryCode = country?.trim();
  return !(
    countryCode &&
    new RegExp(`(?:^|[\\s,.-])${countryCode.replace(/[^a-z]/gi, '')}(?:$|[\\s,.-])`, 'i')
      .test(city)
  );
}

function isStreetSegmentCandidate(
  city: string,
  street: string | undefined
): boolean {
  if (!street?.trim() || !STREET_DESIGNATOR_RE.test(city)) return false;
  const tokens = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  const cityTokens = tokens(city);
  if (cityTokens.length === 0) return false;
  return street
    .split(/[,;\n]|\s+-\s+/)
    .some((segment) => {
      const segmentTokens = tokens(segment);
      for (let start = 0; start <= segmentTokens.length - cityTokens.length; start++) {
        const matches = cityTokens.every(
          (token, offset) => segmentTokens[start + offset] === token
        );
        if (!matches) continue;
        const surrounding = segmentTokens.filter(
          (_, index) => index < start || index >= start + cityTokens.length
        );
        return surrounding.every(
          (token) => /^\d+(?:km|m)?$/.test(token) || STREET_DESIGNATOR_RE.test(token)
        );
      }
      return false;
    });
}

function inferCityFromFull(
  full: string | undefined,
  country: string | undefined,
  street: string | undefined
): string | undefined {
  const text = full?.trim();
  if (!text) return undefined;
  const postalProvinceCity = text.match(
    /\b\d{4,6}\s+([a-zà-öø-ÿ][a-zà-öø-ÿ .'-]*?)\s*\([a-z]{1,3}\)(?:\s+[a-zà-öø-ÿ]+)?(?:,|$)/i
  )?.[1]?.trim();
  if (
    isPlausibleRuntimeCity(postalProvinceCity, country) &&
    !isStreetSegmentCandidate(postalProvinceCity, street)
  ) {
    return postalProvinceCity;
  }
  const cityProvincePostal = text.match(
    /\b([a-zà-öø-ÿ][a-zà-öø-ÿ .'-]*?)\s*\([a-z]{1,3}\)\s*\d{4,6}\b/i
  )?.[1]?.trim();
  if (
    isPlausibleRuntimeCity(cityProvincePostal, country) &&
    !isStreetSegmentCandidate(cityProvincePostal, street)
  ) {
    return cityProvincePostal;
  }
  const internationalCityBeforePostal = text.match(
    /,\s*([a-zà-öø-ÿ][a-zà-öø-ÿ .'-]*?)\s+\d{4,6}\s*,\s*[a-zà-öø-ÿ .'-]+$/i
  )?.[1]?.trim();
  if (
    isPlausibleRuntimeCity(internationalCityBeforePostal, country) &&
    !isStreetSegmentCandidate(internationalCityBeforePostal, street)
  ) {
    return internationalCityBeforePostal;
  }
  const postalThenCity = text.match(
    /\b\d{4,6}\s+([a-zà-öø-ÿ][a-zà-öø-ÿ .'-]*?)(?=,|$)/i
  )?.[1]?.trim();
  if (
    isPlausibleRuntimeCity(postalThenCity, country) &&
    !isStreetSegmentCandidate(postalThenCity, street)
  ) {
    return postalThenCity;
  }
  const segments = text.split(',').map((part) => part.trim()).filter(Boolean);
  const postalIndex = segments.findIndex((part) => /\b\d{4,6}\b/.test(part));
  const beforePostal = postalIndex > 0 ? segments[postalIndex - 1] : undefined;
  return beforePostal &&
    isPlausibleRuntimeCity(beforePostal, country) &&
    !isStreetSegmentCandidate(beforePostal, street)
    ? beforePostal
    : undefined;
}

function reconcileRuntimeAddress(
  previous: Address | undefined,
  parsed: Address | undefined
): Address | undefined {
  if (!parsed) return parsed;
  const address: Address = { ...parsed };
  const inferredCity = inferCityFromFull(
    address.full,
    address.country,
    address.street
  );
  if (
    !isPlausibleRuntimeCity(address.city, address.country) ||
    (address.city && isStreetSegmentCandidate(address.city, address.street)) ||
    Boolean(
      inferredCity &&
      /\b(?:district|dist\.?)$/i.test(address.city ?? '') &&
      normalizedEvidence(inferredCity) !== normalizedEvidence(address.city)
    )
  ) {
    address.city = undefined;
  }
  address.city ??= inferredCity;
  if (address.city) {
    if (address.region) {
      address.city = address.city.replace(
        new RegExp(`\\s+${address.region.replace(/[^A-Za-z]/g, '')}$`, 'i'),
        ''
      );
    }
    const particles = new Set(['del', 'della', 'delle', 'dei', 'di', 'da', 'dal', 'al', 'alla', 'sul']);
    address.city = address.city
      .split(/\s+/)
      .map((word, index) => {
        const lower = word.toLowerCase();
        if (index > 0 && particles.has(lower)) return lower;
        return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
      })
      .join(' ');
  }

  const postal = address.postalCode?.trim();
  if (
    postal &&
    new RegExp(`\\b(?:unit|suite|building|bldg|phase|floor|fl)\\.?\\s*${postal}\\b`, 'i')
      .test(address.full ?? '')
  ) {
    address.postalCode = undefined;
  }
  const civic = address.civicNumber?.trim();
  if (
    civic &&
    new RegExp(`\\b(?:phase|unit|suite|building|bldg|floor|fl)\\.?\\s*${civic}\\b`, 'i')
      .test(address.full ?? '')
  ) {
    address.civicNumber = undefined;
  }

  const samePostalCode = Boolean(
    previous?.postalCode?.trim() &&
    address.postalCode?.trim() &&
    previous.postalCode.trim() === address.postalCode.trim()
  );
  const previousCity = previous?.city?.trim();
  const previousCityObservedInFull = Boolean(
    previousCity &&
    [address.full, previous?.full].some((full) =>
      full
        ?.split(/[,;\n]/)
        .map((part) => normalizedEvidence(part))
        .some((part) => part === normalizedEvidence(previousCity))
    )
  );

  if (
    (samePostalCode || previousCityObservedInFull) &&
    previousCity &&
    isPlausibleRuntimeCity(previousCity, previous?.country) &&
    (!isStreetSegmentCandidate(previousCity, address.street) || previousCityObservedInFull) &&
    !isStreetSegmentCandidate(previousCity, previous?.street) &&
    (!address.city?.trim() || previousCityObservedInFull)
  ) {
    address.city = previousCity;
  }
  if (samePostalCode) {
    address.region ??= previous?.region;
    address.country ??= previous?.country;
  }
  if (
    samePostalCode &&
    address.street?.trim() &&
    POSTAL_BOX_RE.test(address.street) &&
    previous?.street?.trim() &&
    !POSTAL_BOX_RE.test(previous.street)
  ) {
    address.street = previous.street;
    address.civicNumber = previous.civicNumber;
    address.full = previous.full;
  }
  const full = address.full?.trim();
  const street = address.street?.trim();
  if (full && street) {
    const index = full.toLowerCase().indexOf(street.toLowerCase());
    const prefix = index > 0 ? full.slice(0, index) : '';
    // Prefissi con una lunga sequenza numerica/alfanumerica sono rumore OCR,
    // non una localita' valida (es. fronte/retro degradato prima della via).
    if (prefix && /(?:\d[O0IL\d]{5,}|[O0IL]{3,}\d)/i.test(prefix)) {
      address.full = full.slice(index).replace(/^[-,\s]+/, '').trim();
    }
  }
  return address;
}

function recoverRuntimeStreetFromRaw(
  parsed: Address | undefined,
  rawText: string
): Address | undefined {
  if (!parsed) return parsed;
  const candidates = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/([\p{L}])[_|]([0-9]{1,5}[\p{L}]?)(?=$|\s)/gu, '$1, Nr. $2'))
    .map((line) => line.match(
      /(?:^|\s*[-–,]\s*)((?:(?:via|viale|vicolo|corso|piazza|strada)\s+[A-Za-zÀ-ü][A-Za-zÀ-ü .'-]{1,60}|[A-Za-zÀ-ü][A-Za-zÀ-ü .'-]{1,60}?(?:straat|strasse|straße|street|road|avenue|boulevard|lane|drive|way))\s*,?\s*(?:Nr\.\s*)?\d+[A-Za-z0-9/-]*)\b/i
    )?.[1]?.replace(/^.*?\s[-–]\s(?=[A-Za-zÀ-ü])/i, '').trim())
    .filter((value): value is string => Boolean(value));
  const observedStreet = candidates.sort((a, b) => b.length - a.length)[0];
  if (!observedStreet) return parsed;
  if (normalizedEvidence(parsed.street).includes(normalizedEvidence(observedStreet))) {
    return parsed;
  }
  const civicNumber = observedStreet.match(/\b(\d+[A-Za-z0-9/-]*)\s*$/)?.[1];
  const location = [parsed.postalCode, parsed.city, parsed.region, parsed.country]
    .filter(Boolean)
    .join(' - ');
  return {
    ...parsed,
    street: observedStreet,
    civicNumber: civicNumber ?? parsed.civicNumber,
    full: [observedStreet, location].filter(Boolean).join(' - '),
  };
}

function discardPostOfficeBoxAsStreetAddress(
  address: Address | undefined,
  rawText: string,
): Address | undefined {
  if (!address || !/\b(?:p\.?\s*o\.?\s*box|postfach|casella\s+postale)\b/i.test(rawText)) {
    return address;
  }
  const boxNumbers = new Set(
    [...rawText.matchAll(/\b(?:p\.?\s*o\.?\s*box|postfach|casella\s+postale)\s*#?\s*(\d{3,8})/gi)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  );
  if (!boxNumbers.size) return address;
  const next = { ...address };
  if (next.postalCode && boxNumbers.has(next.postalCode)) next.postalCode = undefined;
  if (next.civicNumber && boxNumbers.has(next.civicNumber.replace(/\D/g, ''))) next.civicNumber = undefined;
  if (!next.city) {
    const locality = rawText
      .split(/\r?\n/)
      .map((line) => line.match(/,\s*([\p{L}][\p{L}'’ -]{2,40})\s*,\s*[A-Z]{2,4}\s*$/u)?.[1]?.trim())
      .find((value): value is string => Boolean(value) && isPlausibleRuntimeCity(value, undefined));
    if (locality) next.city = locality;
  }
  return next;
}

function recoverObservedAddressLocality(
  address: Address | undefined,
  rawText: string,
): Address | undefined {
  if (!address) return address;
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  // Formato internazionale esplicito: "..., Taichung City 40452, Taiwan".
  // La citta' immediatamente prima del CAP e del paese e' evidenza piu'
  // forte di un'ultima parola OCR isolata letta su un'altra riga.
  for (const line of lines) {
    const match = line.match(/,\s*([\p{L}][\p{L}'’ .-]{2,50}?)\s+\d{4,6}\s*,\s*[\p{L}][\p{L}'’ .-]{2,40}\s*$/u);
    const city = match?.[1]?.trim();
    if (!city || !isPlausibleRuntimeCity(city, undefined)) continue;
    return { ...address, city, full: address.full?.replace(address.city ?? '', city) ?? line };
  }

  // Carte con sedi mondiali: prima della lista delle societa' locali la
  // zona personale puo' contenere "Dublin 8". Se seguono piu' forme legali
  // diverse, non promuoviamo la prima sede estera successiva (Paris/Frankfurt)
  // al posto della localita' del contatto.
  const legalCount = lines.filter((line) => /\b(?:s\.?r\.?l\.?|sarl|gmbh|ltd\.?|corporation|inc\.?|llc|spa|snc|sas)\b/i.test(line)).length;
  if (legalCount >= 2) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index]!.match(/^([\p{L}][\p{L}'’ .-]{2,40}?)\s+\d{1,2}$/u);
      const city = match?.[1]?.trim();
      if (!city || !isPlausibleRuntimeCity(city, undefined)) continue;
      const hasNearbyCountry = lines.slice(index + 1, index + 5)
        .some((line) => /^(?:ireland|italy|italia|france|germany|usa|uk|belgium|austria|switzerland|taiwan|uae|dubai)$/i.test(line));
      if (hasNearbyCountry) {
        return { ...address, street: undefined, civicNumber: undefined, postalCode: undefined, city, region: undefined, full: city };
      }
    }
  }
  return address;
}

export function recoverStandaloneRoleFromRaw(
  currentRole: string | undefined,
  company: string | undefined,
  rawText: string,
): string | undefined {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const companyKey = normalizedEvidence(company);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const key = normalizedEvidence(line);
    if (!key || key === companyKey || /\d|@|www\.|https?:\/\/|\b(?:tel|fax|mail|via|viale|piazza|corso|srl|spa|snc|sas|gmbh|ltd)\b/i.test(line)) continue;
    if (!/^[\p{Lu}][\p{Lu}'’ -]{2,35}$/u.test(line)) continue;
    const followsNarrative = Boolean(
      lines[index - 1] &&
      (lines[index - 1]!.match(/[\p{L}]{3,}/gu) ?? []).length >= 2,
    );
    const precedesContact = Boolean(lines[index + 1] && /\d{7,}|\b(?:tel|fax|mail|www)\b/i.test(lines[index + 1]!));
    if (followsNarrative || precedesContact) return line;
  }
  return currentRole;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * L'OCR mobile talvolta legge il separatore della mailbox come "a", "at" o
 * "O" (per esempio "nomeOdominio.com"). La riparazione resta stretta: usa
 * esclusivamente il dominio web gia osservato sulla stessa carta, quindi non
 * inventa domini né mailbox da testo generico.
 */
function repairKnownDomainEmailTokens(rawText: string, website?: string): string {
  const host = website
    ?.replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    ?.trim()
    .toLowerCase();
  if (!host || !/^[a-z0-9-]+(?:\.[a-z]{2,24})+$/i.test(host)) return rawText;

  const observedHost = host
    .split('')
    .map((char) => char === '.' ? '[\\s.]+' : escapeRegExp(char))
    .join('');
  const mailbox = new RegExp(
    `([a-z0-9._%+-]{2,}?)\\s*(?:@|\\ba\\b|\\bat\\b|[o0])\\s*${observedHost}(?![a-z0-9-])`,
    'gi'
  );
  // Alcuni biglietti riportano "e-mail ... - www..." senza uno spazio. Se
  // entrambi i domini coincidono con il sito osservato, il secondo e' solo un
  // duplicato grafico e non fa parte dell'indirizzo email (Technical Touch).
  const duplicatedWebsiteSuffix = new RegExp(
    `([a-z0-9._%+-]{2,})\\s*@\\s*${observedHost}\\s*[-–—]\\s*(?:https?:\\/\\/)?(?:www\\.)?${observedHost}(?![a-z0-9-])`,
    'gi'
  );
  const repairLocal = (local: string) =>
    // Sequenza tipografica OCR "ILu" dentro una mailbox: la L maiuscola
    // spur ia e' ammessa solo davanti a u e solo nel token originale misto.
    local.replace(/I[Ll](?=u)/g, 'i');
  return rawText
    .replace(duplicatedWebsiteSuffix, (_match, local: string) => `${repairLocal(local)}@${host}`)
    .replace(mailbox, (_match, local: string) => `${repairLocal(local)}@${host}`);
}

/**
 * Ultimo recupero strettamente locale per OCR che trasforma il separatore
 * della mailbox in O/0 e aggiunge o perde una singola lettera nel cognome.
 * E' ammesso solo quando nome+cognome gia' presenti nel contatto coincidono a
 * una modifica con la parte locale, e il dominio e' scritto sulla carta.
 */
function recoverNameAlignedEmailEvidence(
  rawText: string,
  website: string | undefined,
  firstName: string | undefined,
  lastName: string | undefined,
): EmailEvidenceMetadata | undefined {
  const host = websiteHost(website);
  if (!host) return undefined;
  const observedNames: Array<{ first: string; last: string }> = [];
  if (firstName?.trim() && lastName?.trim()) {
    observedNames.push({ first: firstName.trim(), last: lastName.trim() });
  }
  // Se il classificatore non ha ancora promosso il nominativo, usiamo solo
  // una riga OCR chiaramente composta da due parole personali. Il dominio e
  // il quasi-match della mailbox restano entrambi obbligatori.
  for (const line of rawText.split(/\r?\n/)) {
    const match = line.trim().match(/^([\p{L}][\p{L}'’-]{2,30})\s+([\p{L}][\p{L}'’-]{2,40})$/u);
    if (!match) continue;
    const first = match[1]!;
    const last = match[2]!;
    if (first === first.toUpperCase() && last === last.toUpperCase()) continue;
    if (!observedNames.some((item) => normalizedEvidence(item.first) === normalizedEvidence(first) && normalizedEvidence(item.last) === normalizedEvidence(last))) {
      observedNames.push({ first, last });
    }
  }
  if (!observedNames.length) return undefined;

  const observedHost = host
    .split('')
    .map((char) => char === '.' ? '[\\s.]+' : escapeRegExp(char))
    .join('');
  const token = new RegExp(
    `([a-z0-9._%+-]{2,}?)\\s*(?:@|\\ba\\b|\\bat\\b|[o0])\\s*${observedHost}(?![a-z0-9-])`,
    'gi'
  );
  let expectedLocal: string | undefined;
  let match: RegExpExecArray | undefined;
  for (const names of observedNames) {
    const expected = `${names.first}.${names.last}`.toLowerCase();
    const candidate = [...rawText.matchAll(token)].find((item) =>
      withinOneEdit(item[1] ?? '', expected)
    );
    if (candidate) {
      expectedLocal = expected;
      match = candidate;
      break;
    }
  }
  if (!match || !expectedLocal) return undefined;

  const value = `${expectedLocal}@${host}`;
  return {
    value,
    rawValue: match[0],
    repairedValue: value,
    origin: 'observed',
    pageIndex: null,
    lineId: null,
    rawOcr: match[0],
    transformations: ['name_aligned_local_ocr_repair'],
    confidence: 0.75,
    validationStatus: 'valid',
    requiresReview: false,
    confirmed: true,
  };
}

/** Evita di salvare un frammento breve nato da O/I/0 dentro una riga Tel/Fax. */
function isCorruptedShortLabeledPhone(rawText: string, number: string): boolean {
  const digits = number.replace(/\D/g, '');
  if (digits.length >= 9) return false;
  return rawText.split(/\r?\n/).some((line) => {
    // ML Kit puo' unire l'etichetta al primo numero (es. "Fax39").
    // Riconosciamo sia la forma separata sia quella immediatamente seguita
    // da una cifra, senza allargare il filtro alle normali righe numeriche.
    const hasContactLabel =
      /\b(?:tel|telefono|fax|mobile|cell)\b/i.test(line) ||
      /(?:tel|telefono|fax|mobile|cell)(?=\s*\d)/i.test(line);
    if (!hasContactLabel || !/[OILSQ]/i.test(line)) {
      return false;
    }
    const ocrDigits = line
      .toUpperCase()
      .replace(/[OQ]/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/S/g, '5')
      .replace(/[^0-9]/g, '');
    return ocrDigits.includes(digits);
  });
}

/** Mantiene coerente il valore visualizzato con civico gia estratto. */
function includeCivicInRuntimeAddressFull(address: Address | undefined): Address | undefined {
  const street = address?.street?.trim();
  const civic = address?.civicNumber?.trim();
  const full = address?.full?.trim();
  if (!address || !street || !civic || !full) return address;
  const civicInFull = new RegExp(`(?:^|[^0-9])${escapeRegExp(civic)}(?:[^0-9]|$)`).test(full);
  if (civicInFull) return address;
  const startsWithStreet = new RegExp(`^${escapeRegExp(street)}(?=\\s|,|-|$)`, 'i');
  if (!startsWithStreet.test(full)) return address;
  return {
    ...address,
    full: full.replace(startsWithStreet, `${street}, Nr. ${civic}`),
  };
}

function reconcileRuntimeExtractionReview(
  prev: BusinessCard,
  reconciled: BusinessCard
): BusinessCard['extractionReview'] {
  const review = reconciled.extractionReview;
  if (!review) return review;

  const field = <T>(
    current: ExtractedField<T>,
    value: T | null,
    changed: boolean,
    source: 'legacy' | 'observed'
  ) => changed
    ? {
        ...current,
        value,
        source,
        reasons: [...current.reasons, 'runtime reconciliation aligned operational evidence'],
      }
    : current;
  const reviewedFirstName = review.firstName.value ?? '';
  const reviewedLastName = review.lastName.value ?? '';
  const personChanged =
    reconciled.firstName !== reviewedFirstName ||
    reconciled.lastName !== reviewedLastName;
  const websiteChanged = reconciled.website !== (review.website.value ?? undefined);
  const addressChanged =
    JSON.stringify(reconciled.address ?? null) !==
    JSON.stringify(review.address.value ?? null);

  return {
    ...review,
    firstName: field(
      review.firstName,
      reconciled.firstName || null,
      reconciled.firstName !== reviewedFirstName,
      'legacy'
    ),
    lastName: field(
      review.lastName,
      reconciled.lastName || null,
      personChanged && reconciled.lastName !== reviewedLastName,
      'legacy'
    ),
    website: field(
      review.website,
      reconciled.website ?? null,
      websiteChanged,
      reconciled.website === prev.website ? 'legacy' : 'observed'
    ),
    address: field(
      review.address,
      reconciled.address ?? null,
      addressChanged,
      reconciled.address?.full === prev.address?.full ? 'legacy' : 'observed'
    ),
  };
}

export interface ReparseProgress {
  current: number;
  total: number;
  contactId: string;
}

export interface ReparseSummary {
  updated: number;
  skipped: number;
  errors: number;
  /** Contatti il cui fingerprint campi principali è cambiato. */
  changed: number;
  /** Contatti salvati ma con stessi valori di prima. */
  unchanged: number;
  /** Campi rifiutati dal quality gate (regressioni bloccate). */
  fieldsKeptOld: number;
  /** Campi accettati dal quality gate. */
  fieldsAccepted: number;
  /** Solo simulazione — nessun salvataggio. */
  dryRun: boolean;
  parserBuildId: string;
  sampleChanges: Array<{ contactId: string; title: string; changes: ReparseFieldChange[] }>;
  blockedSamples: Array<{ contactId: string; title: string; decisions: ReparseFieldDecision[] }>;
  skippedSamples: Array<{
    contactId: string;
    title: string;
    reason: 'missing_raw_ocr' | 'legacy_review_tracking';
  }>;
}

export interface ReparseAllOptions {
  dryRun?: boolean;
}

export async function clearAllContactsFromDevice(): Promise<number> {
  return (await clearAllContactsWithAssets()).removed;
}

/** Elimina contatti + documenti + cartella scans (reset completo locale). */
export async function wipeAllLocalScannerData(): Promise<void> {
  await clearAllAppData();
}

interface BuildReparseCandidateOptions {
  /**
   * Il testo arriva da una nuova lettura delle foto. In questo percorso i
   * vecchi campi derivati dal parser non sono evidenza: conservarli qui
   * annullerebbe proprio le correzioni ottenute dal nuovo OCR. Gli eventuali
   * override manuali vengono protetti successivamente dal review state.
   */
  freshOcr?: boolean;
  /** Pagine OCR originali: preservano geometria e confidenza del telefono. */
  pages?: CardPage[];
}

function buildReparseCandidate(
  card: BusinessCard,
  options: BuildReparseCandidateOptions = {}
): {
  card: BusinessCard;
  decisions: ReparseFieldDecision[];
} {
  if (!card.rawText?.trim()) return { card, decisions: [] };

  const pages = options.pages?.length
    ? options.pages
    : pagesFromRawText(card.rawText);
  const parsed = parseCardFromPages(pages);
  // Le coordinate ML Kit sono utili per persona e indirizzo, ma su righe
  // dense possono far perdere una email che il testo OCR completo consente
  // invece di verificare. Il secondo passaggio e limitato alle email assenti
  // e conserva sempre la provenance/review del parser testuale.
  // Il recupero e' sicuro anche nel comando "Rielabora tutti i contatti":
  // usa esclusivamente il sito scritto nello stesso raw OCR, quindi non
  // inventa domini. In questo modo una correzione non dipende dal fare una
  // seconda scansione delle immagini gia' memorizzate.
  // Per il vero ri-OCR non promuoviamo un candidato "website" del parser se
  // non e' scritto esplicitamente nel raw: il parser puo confondere P.IVA,
  // una riga nome o una mailbox spezzata con un URL.
  const observedWebsite = inferObservedWebsiteFromRaw(card.rawText);
  const normalizedRawText = normalizeObservedRawEmailText(card.rawText);
  const emailRecoveryText = repairKnownDomainEmailTokens(normalizedRawText, observedWebsite);
  const textualEmailFallback = parseCardFromPages(
    pagesFromRawText(emailRecoveryText)
  );
  const fallbackEmails = textualEmailFallback?.emails ?? [];
  const nameAlignedEvidence = recoverNameAlignedEmailEvidence(
    card.rawText,
    observedWebsite,
    parsed.firstName && parsed.lastName ? parsed.firstName : card.firstName,
    parsed.firstName && parsed.lastName ? parsed.lastName : card.lastName,
  );
  const rawEmailEvidence = observedRawEmailEvidence(emailRecoveryText, {
    firstName: parsed.firstName ?? '',
    lastName: parsed.lastName ?? '',
  });
  const verifiedRawEmailEvidence = removeTruncatedSamePersonEmails(rawEmailEvidence, {
    firstName: parsed.firstName ?? '',
    lastName: parsed.lastName ?? '',
  });
  // Quando il raw contiene almeno una mailbox completa, quelle sono la fonte
  // primaria e impediscono che una riga grafica fusa diventi una falsa email.
  const baseParsedEmails = verifiedRawEmailEvidence.length
    ? verifiedRawEmailEvidence.map((item) => item.value)
    : [...new Set([
        ...(parsed.emails ?? []),
        ...fallbackEmails,
        ...(nameAlignedEvidence ? [nameAlignedEvidence.value] : []),
      ])];
  const parsedEmails = nameAlignedEvidence
    ? (() => {
        const [expectedLocal, expectedHost] = nameAlignedEvidence.value.toLowerCase().split('@');
        let replaced = false;
        const values = baseParsedEmails.map((email) => {
          const [local, host] = email.toLowerCase().split('@');
          if (host === expectedHost && withinOneEdit(local, expectedLocal)) {
            replaced = true;
            return nameAlignedEvidence.value;
          }
          return email;
        });
        return [...new Set(replaced ? values : [...values, nameAlignedEvidence.value])];
      })()
    : baseParsedEmails;
  const baseParsedEmailEvidence = verifiedRawEmailEvidence.length
    ? verifiedRawEmailEvidence
    : [
        ...(fallbackEmails.length
          ? (textualEmailFallback?.emailEvidence ?? [])
          : (parsed.emailEvidence ?? [])),
        ...(nameAlignedEvidence ? [nameAlignedEvidence] : []),
      ];
  const parsedEmailEvidence = nameAlignedEvidence
    ? [
        ...baseParsedEmailEvidence.filter((item) => {
          const [local, host] = item.value.toLowerCase().split('@');
          const [expectedLocal, expectedHost] = nameAlignedEvidence.value.toLowerCase().split('@');
          return host !== expectedHost || !withinOneEdit(local, expectedLocal);
        }),
        nameAlignedEvidence,
      ]
    : baseParsedEmailEvidence;
  const parsedReview = textualEmailFallback && fallbackEmails.length && parsed.extractionReview
    ? {
        ...parsed.extractionReview,
        emails: textualEmailFallback.extractionReview?.emails ?? parsed.extractionReview.emails,
        emailEvidence: textualEmailFallback.extractionReview?.emailEvidence ?? parsed.extractionReview.emailEvidence,
        reviewFields: [...new Set([
          ...parsed.extractionReview.reviewFields.filter((field) => field !== 'emails'),
          ...(textualEmailFallback.extractionReview?.reviewFields ?? []).filter((field) => field === 'emails'),
        ])],
        needsReview: parsed.extractionReview.needsReview || Boolean(textualEmailFallback.extractionReview?.needsReview),
      }
    : parsed.extractionReview;
  const parsedAddress = options.freshOcr
    ? includeCivicInRuntimeAddressFull(discardPostOfficeBoxAsStreetAddress(
        recoverObservedAddressLocality(recoverRuntimeStreetFromRaw(
          reconcileRuntimeAddress(undefined, parsed.address),
          card.rawText
        ), card.rawText),
        card.rawText,
      ))
    : reconcileRuntimeAddress(card.address, parsed.address);
  const parsedCandidate: BusinessCard = {
    ...card,
    firstName: parsed.firstName ?? '',
    lastName: parsed.lastName ?? '',
    role: recoverStandaloneRoleFromRaw(parsed.role, parsed.company, card.rawText) ?? '',
    company: options.freshOcr
      ? recoverCompanyFromStructuralEvidence(
          alignCompanyToEmailDomain(
            recoverCompanyConnectorContinuation(parsed.company ?? '', card.rawText),
            parsedEmails,
            card.rawText
          ),
          parsedEmails,
          observedWebsite,
          card.rawText,
        )
      : parsed.company ?? '',
    emails: parsedEmails,
    emailEvidence: parsedEmailEvidence,
    phones: parsed.phones ?? [],
    website: reconcileNearEmailDomainWebsite(observedWebsite, parsedEmails),
    address: parsedAddress,
    vatNumber: parsed.vatNumber ?? (options.freshOcr
      ? recoverLabeledItalianVat(card.rawText)
      : undefined),
    taxCode: parsed.taxCode,
    confidence: parsed.confidence,
    extractionReview: parsedReview,
  };
  // Il parser V5 produce già il valore operativo conservativo e mantiene le
  // proposte incerte in extractionReview. Un secondo quality gate basato sui
  // soli valori precedenti reintroduceva campi che il parser aveva scartato.
  // Gli override utente vengono protetti più avanti dalla review persistita.
  const emailMergeSource = options.freshOcr && card.emailEvidence === undefined
    ? { ...card, emailEvidence: [] }
    : card;
  const emailMerged = mergeReparsedEmailState(emailMergeSource, parsedCandidate);
  const selectedPerson = options.freshOcr
    ? {
        firstName: emailMerged.firstName,
        lastName: emailMerged.lastName,
      }
    : reconcileRuntimePerson(card, emailMerged);
  const person = recoverPersonFromRawAndEmail(
    selectedPerson,
    card.rawText,
    parsedEmails
  );
  const reconciled: BusinessCard = {
    ...emailMerged,
    ...person,
    website: options.freshOcr
      ? reconcileNearEmailDomainWebsite(
          emailMerged.website ?? inferRuntimeWebsiteFromEmails(emailMerged.emails),
          emailMerged.emails
        )
      : reconcileRuntimeWebsite(card, emailMerged),
  };
  const canonical: BusinessCard = {
    ...reconciled,
    role: recoverStandaloneRoleFromRaw(reconciled.role, reconciled.company, card.rawText) ?? '',
    extractionReview: options.freshOcr
      ? reconciled.extractionReview
      : reconcileRuntimeExtractionReview(card, reconciled),
  };
  const fiscal = preserveFiscalFields(card, canonical);
  const fiscalDigits = new Set(
    [
      fiscal.vatNumber,
      fiscal.taxCode,
      ...(options.freshOcr ? labeledFiscalDigitCandidates(card.rawText) : []),
      ...(options.freshOcr ? fiscalLabelPhoneArtifactDigits(card.rawText) : []),
    ]
      .map((value) => (value ?? '').replace(/\D/g, ''))
      .filter(Boolean)
  );

  const candidate: BusinessCard = {
    ...canonical,
    phones: canonical.phones.filter((phone) => {
      const digits = phone.number.replace(/\D/g, '');
      return !isBinaryNoisePhone(phone.number) && !isCorruptedShortLabeledPhone(card.rawText, phone.number) && ![...fiscalDigits].some(
        (fiscalValue) =>
          fiscalValue === digits ||
          (fiscalValue.length === 11 && fiscalValue.startsWith('0') && fiscalValue.slice(1) === digits)
      );
    }),
    vatNumber: fiscal.vatNumber,
    taxCode: fiscal.taxCode,
    rawText: card.rawText,
    title: buildCardTitle(
      canonical.company ?? '',
      canonical.firstName ?? '',
      canonical.lastName ?? ''
    ),
    updatedAt: new Date(),
    lastParserBuildId: PARSER_BUILD_ID,
  };

  // Vale sia per il vecchio raw OCR sia per il vero ri-OCR: un valore nuovo
  // viene applicato solo se non degrada semanticamente un campo esistente.
  // Gli override manuali restano poi protetti dal review state.
  return mergeReparseWithQualityGate(card, candidate);
}

/** Crea una proposta da raw OCR senza modificare il contatto corrente. */
export function buildBusinessCardReparseProposal(
  card: BusinessCard
): ContactReparseProposal | null {
  if (!card.rawText?.trim()) return null;
  const { card: candidate } = buildReparseCandidate(card);
  return createContactReparseProposal(
    card,
    candidate,
    PARSER_BUILD_ID
  );
}

/** Applica soltanto i campi selezionati e mai quelli marcati come manuali. */
export function applyBusinessCardReparseProposal(
  card: BusinessCard,
  proposal: ContactReparseProposal,
  selectedFields: readonly ContactReparseFieldKey[]
): ApplyContactReparseResult {
  return applyContactReparseProposal(card, proposal, selectedFields);
}

export type BusinessCardReocrProposalStatus =
  | 'ready'
  | 'missing_images'
  | 'no_text';

export interface BusinessCardReocrProposalResult {
  status: BusinessCardReocrProposalStatus;
  /** Contatto originale con solo raw OCR/qualita aggiornati dalle foto. */
  reocrCard: BusinessCard;
  /** Differenze dei campi estratti, sempre confrontate col contatto originale. */
  proposal: ContactReparseProposal | null;
}

type BusinessCardOcrScan = Awaited<ReturnType<typeof scanBusinessCardBest>>;

export interface BusinessCardReocrOptions {
  operation?: OperationLease;
  /** Injection point riservato ai test: in app resta scanBusinessCardBest. */
  scanImage?: (
    imageUri: string,
    operation?: OperationLease
  ) => Promise<BusinessCardOcrScan>;
  resolveImage?: (imageUri: string) => string;
}

export interface BusinessCardReocrBatchProgress {
  current: number;
  total: number;
  contactId: string;
}

export type BusinessCardReocrBatchSkipReason =
  | 'missing_images'
  | 'no_text'
  | 'legacy_review_tracking'
  | 'stale_before_apply';

export interface PreparedBusinessCardReocrBatchItem {
  contactId: string;
  baseFingerprint: string;
  next: BusinessCard;
  changes: ReparseFieldChange[];
  protectedFields: ContactReparseFieldKey[];
}

export interface PreparedBusinessCardReocrBatch {
  parserBuildId: string;
  total: number;
  ready: number;
  changed: number;
  unchanged: number;
  skipped: number;
  errors: number;
  protectedFields: number;
  items: PreparedBusinessCardReocrBatchItem[];
  skippedSamples: Array<{
    contactId: string;
    title: string;
    reason: BusinessCardReocrBatchSkipReason;
  }>;
}

export interface PrepareBusinessCardReocrBatchOptions
  extends BusinessCardReocrOptions {
  /** Injection point test; in app i contatti arrivano dal DB locale. */
  contacts?: readonly BusinessCard[];
}

export interface ApplyBusinessCardReocrBatchSummary {
  applied: number;
  stale: number;
  errors: number;
}

function businessCardReocrBatchFingerprint(card: BusinessCard): string {
  return JSON.stringify({
    review: contactReviewFingerprint(card),
    rawText: card.rawText ?? '',
    images: card.images ?? [],
    updatedAt:
      card.updatedAt instanceof Date
        ? card.updatedAt.toISOString()
        : String(card.updatedAt ?? ''),
  });
}

async function collectBusinessCardOcrFromImages(
  card: BusinessCard,
  options: BusinessCardReocrOptions = {}
): Promise<{
  pageTexts: string[];
  pages: CardPage[];
  ocrQuality: OcrQualityMetadata;
}> {
  const scanImage = options.scanImage ?? scanBusinessCardBest;
  const resolveImage = options.resolveImage ?? resolveImageUri;
  const pageTexts: string[] = [];
  const pages: CardPage[] = [];
  const qualities: OcrQualityMetadata[] = [];

  for (const imageUri of card.images ?? []) {
    if (options.operation && !options.operation.isActive()) break;
    const result = await scanImage(resolveImage(imageUri), options.operation);
    qualities.push(result.quality);
    if (result.text?.trim()) {
      const text = result.text.trim();
      pageTexts.push(text);
      pages.push({
        rawText: text,
        lines: result.lines.length > 0
          ? result.lines
          : pagesFromRawText(text).flatMap((page) => page.lines),
      });
    }
  }

  return {
    pageTexts,
    pages,
    ocrQuality: aggregateOcrQuality(qualities),
  };
}

/**
 * Riparte davvero dalle immagini salvate e prepara una review campo-per-campo.
 * Non modifica né salva il contatto: il chiamante deve mostrare la proposta.
 */
export async function buildBusinessCardReocrProposal(
  card: BusinessCard,
  options: BusinessCardReocrOptions = {}
): Promise<BusinessCardReocrProposalResult> {
  if ((card.images ?? []).length === 0) {
    return { status: 'missing_images', reocrCard: card, proposal: null };
  }

  const { pageTexts, pages, ocrQuality } = await collectBusinessCardOcrFromImages(
    card,
    options
  );
  if (pageTexts.length === 0) {
    return {
      status: 'no_text',
      reocrCard: { ...card, ocrQuality },
      proposal: null,
    };
  }

  const reocrCard: BusinessCard = {
    ...card,
    rawText: pageTexts.join('\n\n'),
    ocrQuality,
    updatedAt: new Date(),
  };
  const { card: candidate } = buildReparseCandidate(reocrCard, {
    freshOcr: true,
    pages,
  });
  return {
    status: 'ready',
    reocrCard,
    proposal: createContactReparseProposal(card, candidate, PARSER_BUILD_ID),
  };
}

/**
 * Applica i soli campi scelti e, nello stesso draft, conserva il nuovo raw OCR.
 * Gli override manuali continuano ad essere protetti dal review state.
 */
export function applyBusinessCardReocrProposal(
  card: BusinessCard,
  reocr: BusinessCardReocrProposalResult,
  selectedFields: readonly ContactReparseFieldKey[]
): ApplyContactReparseResult {
  if (reocr.status !== 'ready' || !reocr.proposal) {
    return {
      status: 'unchanged',
      appliedResult: card,
      appliedFields: [],
      protectedFields: [],
    };
  }
  const applied = applyContactReparseProposal(
    card,
    reocr.proposal,
    selectedFields
  );
  if (applied.status === 'stale') return applied;

  // L'indirizzo viene normalizzato anche da altri strati al salvataggio. Qui
  // imponiamo l'invariante di presentazione sull'oggetto finale, non solo sul
  // candidato del parser: se il civico e strutturato, deve essere visibile.
  const appliedResult = {
    ...applied.appliedResult,
    address: includeCivicInRuntimeAddressFull(applied.appliedResult.address),
  };
  return {
    ...applied,
    status: 'applied',
    appliedResult: {
      ...appliedResult,
      rawText: reocr.reocrCard.rawText,
      ocrQuality: reocr.reocrCard.ocrQuality,
      updatedAt: new Date(),
      lastParserBuildId: PARSER_BUILD_ID,
    },
  };
}

/**
 * QA: esegue una sola volta il vero OCR e mantiene i risultati in memoria.
 * Nessun contatto viene scritto finché applyPreparedBusinessCardReocrBatch
 * non viene chiamata dopo l'anteprima/avviso.
 */
export async function prepareBusinessCardReocrBatch(
  onProgress?: (progress: BusinessCardReocrBatchProgress) => void,
  options: PrepareBusinessCardReocrBatchOptions = {}
): Promise<PreparedBusinessCardReocrBatch> {
  const contacts = options.contacts
    ? [...options.contacts]
    : await getAllContacts();
  const batch: PreparedBusinessCardReocrBatch = {
    parserBuildId: PARSER_BUILD_ID,
    total: contacts.length,
    ready: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    protectedFields: 0,
    items: [],
    skippedSamples: [],
  };

  const skip = (
    card: BusinessCard,
    reason: BusinessCardReocrBatchSkipReason
  ) => {
    batch.skipped += 1;
    if (batch.skippedSamples.length < 15) {
      batch.skippedSamples.push({
        contactId: card.id,
        title: card.title ?? card.id,
        reason,
      });
    }
  };

  for (let index = 0; index < contacts.length; index += 1) {
    const card = contacts[index]!;
    onProgress?.({
      current: index + 1,
      total: contacts.length,
      contactId: card.id,
    });
    if (options.operation && !options.operation.isActive()) break;
    if (!card.contactReviewState || card.contactReviewState.tracking !== 'parsed') {
      skip(card, 'legacy_review_tracking');
      continue;
    }
    if ((card.images ?? []).length === 0) {
      skip(card, 'missing_images');
      continue;
    }

    try {
      const reocr = await buildBusinessCardReocrProposal(card, options);
      if (reocr.status !== 'ready' || !reocr.proposal) {
        skip(card, reocr.status === 'missing_images' ? 'missing_images' : 'no_text');
        continue;
      }
      const selectedFields = reocr.proposal.fields.map((field) => field.field);
      const applied = applyBusinessCardReocrProposal(
        card,
        reocr,
        selectedFields
      );
      const next = selectedFields.length > 0
        ? applied.appliedResult
        : {
            ...reocr.reocrCard,
            lastParserBuildId: PARSER_BUILD_ID,
          };
      const changes = diffReparseCard(card, next);
      batch.ready += 1;
      batch.protectedFields += applied.protectedFields.length;
      if (changes.length > 0) batch.changed += 1;
      else batch.unchanged += 1;
      batch.items.push({
        contactId: card.id,
        baseFingerprint: businessCardReocrBatchFingerprint(card),
        next,
        changes,
        protectedFields: applied.protectedFields,
      });
    } catch (error) {
      batch.errors += 1;
      runtimeLogger.warn('CONTACT_REPARSE_FAILED', error, {
        status: 'failed',
        stage: 'read',
        source: 'local',
      });
    }
  }

  return batch;
}

/** Applica il batch gia OCRizzato, rifiutando contatti cambiati nel frattempo. */
export async function applyPreparedBusinessCardReocrBatch(
  batch: PreparedBusinessCardReocrBatch
): Promise<ApplyBusinessCardReocrBatchSummary> {
  const currentById = new Map(
    (await getAllContacts()).map((card) => [card.id, card] as const)
  );
  const summary: ApplyBusinessCardReocrBatchSummary = {
    applied: 0,
    stale: 0,
    errors: 0,
  };

  for (const item of batch.items) {
    const current = currentById.get(item.contactId);
    if (
      !current ||
      businessCardReocrBatchFingerprint(current) !== item.baseFingerprint
    ) {
      summary.stale += 1;
      continue;
    }
    try {
      await updateContactWithAssetCleanup(item.next);
      summary.applied += 1;
    } catch (error) {
      summary.errors += 1;
      runtimeLogger.warn('CONTACT_REPARSE_FAILED', error, {
        status: 'failed',
        stage: 'database',
        source: 'local',
      });
    }
  }
  return summary;
}

/** Rielabora in modalità compatibilità, preservando sempre gli override manuali. */
export function reparseBusinessCardWithDecisions(card: BusinessCard): {
  card: BusinessCard;
  decisions: ReparseFieldDecision[];
  appliedFields: ContactReparseFieldKey[];
  protectedFields: ContactReparseFieldKey[];
} {
  if (!card.rawText?.trim()) {
    return {
      card,
      decisions: [],
      appliedFields: [],
      protectedFields: [],
    };
  }
  const built = buildReparseCandidate(card);
  const protectedMerge = applyContactCandidatePreservingManual(
    card,
    built.card,
    'reparse'
  );
  return {
    card: {
      ...protectedMerge.appliedResult,
      updatedAt: built.card.updatedAt,
      lastParserBuildId: built.card.lastParserBuildId,
    },
    decisions: built.decisions,
    appliedFields: protectedMerge.appliedFields,
    protectedFields: protectedMerge.protectedFields,
  };
}

export function reparseBusinessCard(card: BusinessCard): BusinessCard {
  return reparseBusinessCardWithDecisions(card).card;
}

/** Rielabora e salva tutti i contatti (mantiene id, immagini, note). */
export async function reparseAllBusinessCards(
  onProgress?: (progress: ReparseProgress) => void,
  options: ReparseAllOptions = {}
): Promise<ReparseSummary> {
  const dryRun = options.dryRun === true;
  const contacts = await getAllContacts();
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let changed = 0;
  let unchanged = 0;
  let fieldsKeptOld = 0;
  let fieldsAccepted = 0;
  const sampleChanges: ReparseSummary['sampleChanges'] = [];
  const blockedSamples: ReparseSummary['blockedSamples'] = [];
  const skippedSamples: ReparseSummary['skippedSamples'] = [];

  for (let i = 0; i < contacts.length; i++) {
    const card = contacts[i];
    onProgress?.({ current: i + 1, total: contacts.length, contactId: card.id });

    if (!card.rawText?.trim()) {
      skipped += 1;
      if (skippedSamples.length < 15) {
        skippedSamples.push({
          contactId: card.id,
          title: card.title ?? card.id,
          reason: 'missing_raw_ocr',
        });
      }
      continue;
    }
    if (
      !card.contactReviewState ||
      card.contactReviewState.tracking !== 'parsed'
    ) {
      // I record legacy non distinguono parser e modifiche manuali. Il bulk
      // non può chiedere una scelta campo-per-campo, quindi fallisce chiuso:
      // il contatto resta invariato e può essere rielaborato dalla sua review.
      skipped += 1;
      if (skippedSamples.length < 15) {
        skippedSamples.push({
          contactId: card.id,
          title: card.title ?? card.id,
          reason: 'legacy_review_tracking',
        });
      }
      continue;
    }

    try {
      const {
        card: next,
        decisions,
        appliedFields,
        protectedFields,
      } = reparseBusinessCardWithDecisions(card);

      for (const d of decisions) {
        if (d.decision === 'keep_old' && d.oldValue !== d.newValue) fieldsKeptOld += 1;
      }
      fieldsAccepted += appliedFields.length;
      fieldsKeptOld += protectedFields.length;

      const blocked = decisions.filter((d) => d.decision === 'keep_old' && d.oldValue !== d.newValue);
      if (blocked.length && blockedSamples.length < 15) {
        blockedSamples.push({
          contactId: card.id,
          title: card.title ?? `${card.firstName} ${card.lastName}`.trim(),
          decisions: blocked,
        });
      }

      const fieldChanges = diffReparseCard(card, next);
      if (fieldChanges.length) {
        changed += 1;
        if (sampleChanges.length < 12) {
          sampleChanges.push({
            contactId: card.id,
            title: card.title ?? `${card.firstName} ${card.lastName}`.trim(),
            changes: fieldChanges,
          });
        }
      } else {
        unchanged += 1;
      }

      if (!dryRun) {
        await updateContactWithAssetCleanup(next);
      }
      updated += 1;

      if (__DEV__ && fieldChanges.length) {
        runtimeLogger.debug(
          'CONTACT_REPARSE_DIFF',
          {
            status: 'completed',
            stage: 'parse',
            source: 'local',
            changed: fieldChanges.length,
          },
          {
            parserBuildId: PARSER_BUILD_ID,
            dryRun,
            contactId: card.id,
            title: card.title ?? card.id,
            changes: fieldChanges,
          }
        );
      }
      if (__DEV__ && blocked.length) {
        runtimeLogger.debug(
          'CONTACT_REPARSE_BLOCKED',
          {
            status: 'blocked',
            stage: 'parse',
            source: 'local',
            rejected: blocked.length,
          },
          {
            contactId: card.id,
            title: card.title ?? card.id,
            decisions: blocked,
          }
        );
      }
    } catch (error) {
      errors += 1;
      runtimeLogger.warn('CONTACT_REPARSE_FAILED', error, {
        status: 'failed',
        stage: 'parse',
        source: 'local',
      });
    }
  }

  if (__DEV__) {
    runtimeLogger.debug(
      'CONTACT_REPARSE_SUMMARY',
      {
        status: 'completed',
        stage: 'parse',
        source: 'local',
        updated,
        changed,
        unchanged,
        accepted: fieldsAccepted,
        rejected: fieldsKeptOld,
        skipped,
        count: errors,
      },
      { parserBuildId: PARSER_BUILD_ID, dryRun }
    );
  }

  return {
    updated,
    skipped,
    errors,
    changed,
    unchanged,
    fieldsKeptOld,
    fieldsAccepted,
    dryRun,
    parserBuildId: PARSER_BUILD_ID,
    sampleChanges,
    blockedSamples,
    skippedSamples,
  };
}

/**
 * Ri-OCR dopo una rotazione, senza applicare automaticamente il parser ai
 * campi correnti. La review costruisce poi una proposta esplicita dal rawText.
 */
export async function reocrBusinessCardFromImages(
  card: BusinessCard,
  options: BusinessCardReocrOptions = {}
): Promise<BusinessCard> {
  const images = card.images ?? [];
  if (images.length === 0) return card;

  const { pageTexts, ocrQuality } = await collectBusinessCardOcrFromImages(
    card,
    options
  );
  if (pageTexts.length === 0) return { ...card, ocrQuality };

  const rawText = pageTexts.join('\n\n');
  return {
    ...card,
    rawText,
    ocrQuality,
    updatedAt: new Date(),
  };
}

/** Ruota una pagina draft senza scrivere nello storage permanente. */
export async function rotateDraftBusinessCardImagePage(
  card: BusinessCard,
  pageIndex: number,
  rotatedUri: string
): Promise<BusinessCard> {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= card.images.length) {
    throw new Error('Indice pagina da ruotare non valido');
  }
  const images = [...card.images];
  images[pageIndex] = rotatedUri;
  return reocrBusinessCardFromImages({ ...card, images });
}

/** Ruota con asset versionato, ri-OCR e commit DB atomico applicativo. */
export async function rotateBusinessCardImagePage(
  card: BusinessCard,
  pageIndex: number,
  rotatedUri: string,
  validate?: ValidateRotatedContact
): Promise<BusinessCard> {
  return replaceSavedContactImagePage(
    card,
    pageIndex,
    rotatedUri,
    reocrBusinessCardFromImages,
    validate
  );
}
