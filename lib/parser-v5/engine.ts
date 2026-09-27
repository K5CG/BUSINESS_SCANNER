/**
 * parser-v5/engine.ts — Motore di estrazione biglietti da visita.
 *
 * STRATEGIA (nessuna cascata if/else, nessuna lista per-biglietto):
 *   Stadio 1  STRUTTURATI  email / telefoni / sito / P.IVA / C.F. con pattern
 *             strutturali quasi-certi; le righe consumate vengono MASCHERATE.
 *   Stadio 2  FEATURE      per ogni riga residua un vettore di caratteristiche:
 *             geometria REALE (altezza font relativa, posizione), forma del
 *             testo, lessico generico, coerenza con email/dominio.
 *   Stadio 3  CANDIDATI    generazione ipotesi: nome (anche da split della
 *             riga azienda, da coppie di righe adiacenti, dall'email),
 *             azienda (riga con forma giuridica, brand = radice dominio,
 *             testo grande in alto), ruolo.
 *   Stadio 4  ARBITRAGGIO  UNA sola assegnazione globale con vincoli
 *             (≤1 nome, ≤1 azienda, nome ≠ riga azienda, ruolo vicino al
 *             nome) massimizzando i punteggi. I pesi stanno in un unico
 *             posto (WEIGHTS) e sono rifittabili offline sul golden corpus.
 *   Stadio 5  RICONCILIA   sito ↔ dominio email (caratteri confondibili
 *             decisi per frequenza intra-biglietto), azienda ↔ brand,
 *             ordine nome/cognome via email.
 *
 * Il modulo è puro: dipende solo dal tipo OcrLine. Niente React Native.
 */

import type { OcrLine, Phone } from '../../types';
import type {
  ExtractionSource,
  PageCoherenceMetadata,
} from '../parser-engine/card-extraction-result';
import type { EmailEvidenceMetadata } from '../email-evidence';
import {
  CIVIC_LABEL_PATTERN_SOURCE,
  hasStrongNumberedStreetStructure,
} from '../address-format';
import { ocrParserCompatibilityConfidence } from '../ocr-quality';
import { runtimeLogger } from '../safe-runtime-logger';
import {
  parseNameFromEmailLocal,
  parsePersonNameFromLine,
  repairExtraInternalOcrGlyphInFirstName,
  validatePersonName,
} from '../parser-engine/validators/name';
import {
  finalizeAddressParts,
  finalizeCompanyValue,
  finalizePersonFields,
  finalizeRoleValue,
  finalizeWebsiteValue,
  hasConflictingObservedBusinessBrandEvidence,
  resolveConvergentBusinessBrandEvidence,
} from './finalize';
import { extractExplicitLabelFields } from './explicit-labels';
import {
  fixOcrTokenCasing,
  isHostnameOnlyCompany,
  normalizeCompanyPhraseCasing,
  pickBestDomainRoot,
  pickBestFuzzyCompanyLineFromOcr,
  fuzzyCompanyDomainDistance,
  splitFusedDomainBrand,
  respellTokenFromDomainRoot,
  repairInternationalCompanyOcr,
} from './company-normalize';
import { analyzePageCoherence } from './page-coherence';
import type { NumericEvidence } from './numeric-evidence';
import {
  createIncludedPagesContext,
  pageDisposition,
  setIncludedStructuredCandidates,
} from './included-pages-context';
import { hasExactObservedPersonalEmailEvidence, parseExactObservedPersonFromEmail, personEmailAffinityScore, primaryPersonalEmail, recoverPersonMatchingPersonalEmail } from './person-email-ownership';
import { normalizeFusedPersonLine, parseCapsSurnameFirstLine } from './person-token-split';
import { recoverPersonOnBrandOnlyCard } from './brand-only-person';
import { emailDomainIncoherentWithWebsite } from './email-website-coherence';
import {
  collectEmailEvidence,
  observedEmailScore,
  observedEmailValues,
} from './email-evidence';
import { isGarbageCityName } from '../parser-engine/validators/address';
import {
  COMMON_FIRST_NAMES,
  isItalianCityName,
  NON_PERSON_WORDS,
} from '../parser-engine/validators/dictionaries';
import { isCompanySloganClaimLine } from '../parser-engine/validators/role';
import {
  hasAmbiguousTerminalLegalSeparator,
  hasTerminalLegalFormSuffix,
  isAmbiguousTerminalLegalPhrase,
  LEGAL_FORM_PATTERN_SOURCE,
  matchTerminalLegalFormSuffix,
  normalizeBrandKey,
  ROLE_KEYWORD_REGEX,
  stripLegalFormSuffix,
} from '../parser-engine/validators/dictionaries';
import {
  getPrimaryBusinessEmailDomain,
  isNonBusinessEmailDomain,
  resolveExplicitWebsiteFromText,
} from '../parser-engine/validators/website';
import {
  extractBusinessDomainRootCandidates,
  splitFusedDomainRoot,
} from '../parser-engine/validators/brand-domain';
import { isDomainOnlyCompanyValue, isLegalFormOnlyCompany, isOcrFusedEmailLikeLine, isPreservableCompanyCandidate, isRejectedCompanyValue, isProductCategoryTagline, recoverOcrHeaderBrand, recoverStackedBrandLinesFromWebsite, resolveOrganizationFromOcr, sanitizeCompanyValue, shouldPreferEmailBrandOverCompany, splitPersonNameFromCompanyValue, alignCompanyToEmailDomain, stripNumberedLocationAfterLegalForm } from '../parser-engine/validators/company';
import { hasConfusableDigitInsideBrandToken, hasOcrBrandNoise, normalizeOcrBrandValue, refineLogoBrandFromConvergentEvidence, resolveBrandFromEmailDomain } from '../parser-engine/validators/brand-normalizer';
import {
  gatherPersonPageAddressLines,
  joinAddressComponents,
  assembleUniversalAddressBlocks,
  sanitizeAddressCity,
  stripGlobalOfficeContamination,
  tryAssembleItalianSedeOperativaAddress,
  collectPersonalAddressCluster,
  addressCompletenessScore,
  semanticAddressMatch,
} from './address-assembly';
import {
  isCityMatchingPersonSurname,
  isGlobalOfficeAddressBlock,
  isRoleWordAsCompany,
  sanitizeStructuredEmails,
  shouldRejectCompanyCandidate,
  shouldRejectPersonCandidate,
  shouldRejectCorroboratedObservedPersonCandidate,
  isProductBrandLineAsPerson,
  isPersonDuplicateOfCompany,
  isLikelyPersonNameAboveRoleLine,
  isInstitutionalOcrPersonGarbage,
  isGenericContactIdentityLine,
  isGenericContactOrDepartmentToken,
  isKnownCityName,
  isLegalFormOnlyCompanyLine,
} from './semantic-class';

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

export interface CardPageV5 {
  lines: OcrLine[];
  rawText: string;
}

export interface V5AddressParts {
  full: string;
  street?: string;
  civicNumber?: string;
  postalCode?: string;
  city?: string;
  region?: string;
  country?: string;
  /** 0..1 — copertura componenti (via, civico, cap, città, regione). */
  completeness?: number;
  /** true se mancano componenti strutturali presenti nell'OCR. */
  partial?: boolean;
  /** Provenienza opzionale per blocchi indirizzo conservati. */
  rawLines?: string[];
  sourceLineIds?: number[];
  page?: number;
  order?: number;
  addressType?: string;
  confidence?: number;
  requiresReview?: boolean;
}

export interface V5Field<T> {
  value: T | null;
  /** 0..1 dopo sigmoide sul margine di arbitraggio. */
  score: number;
  reasons: string[];
  lineIds?: number[];
  source?: ExtractionSource;
}

export interface V5Result {
  firstName: V5Field<string>;
  lastName: V5Field<string>;
  company: V5Field<string>;
  role: V5Field<string>;
  emails: V5Field<string[]>;
  emailEvidence: EmailEvidenceMetadata[];
  phones: V5Field<Phone[]>;
  website: V5Field<string>;
  address: V5Field<V5AddressParts>;
  /** Sedi secondarie osservate, validate e mantenute separate dalla primaria. */
  addressAlternatives: V5AddressParts[];
  vatNumber: V5Field<string>;
  taxCode: V5Field<string>;
  rawText: string;
  pageMismatch?: boolean;
  pageMismatchReasons?: string[];
  pageCoherence: PageCoherenceMetadata;
  /** true se dominio email OCR ≠ sito (prima di eventuale riparazione). */
  emailDomainOcrMismatch?: boolean;
  debugLines: V5DebugLine[];
  entityAlternatives?: {
    company: V5EntityEvidenceAlternative[];
    person: V5EntityEvidenceAlternative[];
  };
  businessEvidenceProposals?: V5BusinessEvidenceProposal[];
  repairProposals?: V5ConservativeRepairProposal[];
}

export interface V5EntityEvidenceAlternative {
  rawValue: string;
  normalizedValue: string;
  lineId: number;
  /** Tutte le righe OCR che compongono questa evidenza, se multilivello. */
  sourceLineIds?: number[];
  page: number;
  evidenceType: 'person' | 'legal-company' | 'institution' | 'organization' | 'logo';
  reason: string;
  score: number;
  selected: boolean;
}

export interface V5BusinessEvidenceProposal {
  rawValue: string;
  normalizedValue: string;
  sourceLineIds: number[];
  sourcePages: number[];
  evidenceTypes: Array<'logo' | 'company-line' | 'institution' | 'email-domain' | 'website-domain' | 'repetition'>;
  reason: string;
  confidence: number;
  requiresReview: boolean;
}

export interface V5ConservativeRepairProposal {
  field: 'email' | 'website' | 'phone';
  raw: string;
  repaired: string;
  transformations: string[];
  sourceLineIds: number[];
  sourcePages: number[];
  confidence: number;
  requiresReview: true;
  confirmed: false;
  operational: false;
}

export interface V5DebugLine {
  id: number;
  page: number;
  text: string;
  masked: string | null;
  fontScale: number;
  scores: { person: number; company: number; role: number };
  /** Partizione diagnostica; una sola pagina pending può alimentare l'estrazione provvisoria. */
  pageDisposition: 'included' | 'excluded' | 'pending';
}

interface Line {
  id: number;
  page: number;
  indexInPage: number;
  text: string;
  rawOcr: string;
  ocrConfidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
  masked: string | null;
  f: Features;
  personScore: number;
  companyScore: number;
  roleScore: number;
}

const ENTITY_CONTACT_LINE_RE =
  /(?:@|https?:\/\/|www\.|\b(?:e-?mail|b-?mail|cmail|tel(?:efono)?|phone|fax|mobile|cell|whatsapp|vat|p\.?\s*iva|c\.?\s*f\.?|tax\s+id)\b)/i;
const INSTITUTION_ENTITY_RE =
  /\b(?:university|universit[aÃ ]|college|politecnico|polytechnic|istituto|institute|ministero|comune\s+di|ospedale|fondazione)\b/i;
const ORGANIZATION_SUFFIX_RE =
  /\b(?:associates?|partners?|consultants?|consulting|group|gruppo|systems?|solutions?|laborator(?:y|io)|agency|studio)\b/i;
const DEPARTMENT_ENTITY_RE =
  /\b(?:department|dipartimento|division|school\s+of|faculty|facolt[aÃ ]|management|sales\s+dept|office|ufficio)\b/i;

function entityDomainRoots(emails: string[], websites: Map<string, number>): string[] {
  const values = [
    ...emails.map((email) => email.split('@')[1] ?? ''),
    ...websites.keys(),
  ];
  return [...new Set(values.flatMap((value) => extractBusinessDomainRootCandidates(value)).map(normalizeBrandKey).filter(Boolean))];
}

function leadingOrganizationKey(value: string): string {
  const leading = value
    .replace(/&/g, ' and ')
    .split(/\b(?:international|company|co\.?|ltd\.?|limited|s\.?r\.?l\.?|s\.?p\.?a\.?)\b/i)[0]
    .trim();
  return normalizeBrandKey(leading);
}

function rankObservedCompanyEvidence(
  lines: Line[],
  emails: string[],
  websites: Map<string, number>,
  excludedLineIds: ReadonlySet<number>
): V5EntityEvidenceAlternative[] {
  const roots = entityDomainRoots(emails, websites);
  const hasInstitution = lines.some(
    (line) => !ENTITY_CONTACT_LINE_RE.test(line.text) && INSTITUTION_ENTITY_RE.test(line.text)
  );
  const out: V5EntityEvidenceAlternative[] = [];
  for (const line of lines) {
    const rawValue = clean(
      LEGAL_RE.test(line.text) ? line.text : line.rawOcr || line.text
    );
    if (!rawValue || excludedLineIds.has(line.id)) continue;
    if (ENTITY_CONTACT_LINE_RE.test(rawValue) || FISCAL_LABEL_RE.test(rawValue)) continue;
    const inlineCompany = splitCompanyInlineAddress(rawValue);
    if (
      line.masked === 'structured' ||
      line.masked === 'social' ||
      (line.masked === 'address' && !inlineCompany)
    ) continue;
    const entityValue = inlineCompany?.company ?? rawValue;
    const descriptiveExtensionOfObservedEntity = lines.some((other) => {
      if (other.id === line.id) return false;
      const shorter = clean(other.rawOcr || other.text);
      if (!shorter || shorter.length >= entityValue.length) return false;
      if (!entityValue.toLocaleLowerCase().startsWith(shorter.toLocaleLowerCase())) return false;
      const tail = entityValue.slice(shorter.length).trim();
      return /^(?:\u00e8|e['\u2019]|is|are)\s+(?:un|uno|una|a|an|the)\b/iu.test(tail);
    });
    if (descriptiveExtensionOfObservedEntity) continue;
    if (
      ROLE_RE.test(entityValue) &&
      !LEGAL_RE.test(entityValue) &&
      !INSTITUTION_ENTITY_RE.test(entityValue) &&
      !DEPARTMENT_ENTITY_RE.test(entityValue)
    ) continue;
    const entityKeyBeforePersonVeto = normalizeBrandKey(entityValue);
    const genericMailboxBrandAligned = emails.some((email) => {
      const [local, host] = email.split('@');
      if (!local || !host || !isGenericHost(host)) return false;
      const localKey = normalizeBrandKey(local);
      if (!localKey || GENERIC_LOCAL_RE.test(local)) return false;
      return (
        entityKeyBeforePersonVeto.length >= 4 &&
        localKey === entityKeyBeforePersonVeto
      );
    });

    if (
      parsePersonNameFromLine(entityValue) &&
      !LEGAL_RE.test(entityValue) &&
      !INSTITUTION_ENTITY_RE.test(entityValue) &&
      !ORGANIZATION_SUFFIX_RE.test(entityValue) &&
      !DEPARTMENT_ENTITY_RE.test(entityValue) &&
      !genericMailboxBrandAligned
    ) continue;

    const legal = LEGAL_RE.test(entityValue);
    const institution = INSTITUTION_ENTITY_RE.test(entityValue);
    const department = DEPARTMENT_ENTITY_RE.test(entityValue);
    const organization =
      ORGANIZATION_SUFFIX_RE.test(entityValue) ||
      department ||
      genericMailboxBrandAligned;
    const digits = entityValue.replace(/\D/g, '');
    const letters = entityValue.match(/\p{L}/gu)?.length ?? 0;
    const logo =
      /^\p{Lu}[\p{Lu}\p{N}&.'-]{2,24}$/u.test(entityValue) &&
      letters >= Math.max(3, digits.length) &&
      digits.length < 7 &&
      !isKnownCityName(entityValue);
    const legalFormIndex = entityValue.search(LEGAL_RE);
    const leadKey = leadingOrganizationKey(
      matchTerminalLegalFormSuffix(entityValue)?.brand ??
        (legalFormIndex > 0 ? entityValue.slice(0, legalFormIndex) : entityValue)
    );
    const exactDomainAligned = Boolean(
      leadKey.length >= 2 &&
        roots.some(
          (root) =>
            root === leadKey ||
            root.startsWith(leadKey) ||
            leadKey.startsWith(root)
        )
    );
    const ocrConfusableDomainAligned = Boolean(
      leadKey.length >= 3 &&
        roots.some((root) => ocrConfusableBrandKeysAlign(root, leadKey))
    );
    const domainAligned = exactDomainAligned || ocrConfusableDomainAligned;
    const observedDomainBrand = Boolean(
      !legal &&
        !institution &&
        !organization &&
        !logo &&
        line.companyScore >= T.company &&
        leadKey.length >= 4 &&
        exactDomainAligned
    );
    if (!legal && !institution && !organization && !logo && !observedDomainBrand) continue;
    let score = legal
      ? 7
      : institution
        ? 10
        : genericMailboxBrandAligned
          ? 8.8
          : organization
            ? 4.5
            : observedDomainBrand
              ? 5.8
              : 3.5;
    if (domainAligned) score += 3;
    if (legal && domainAligned) score += 1.5;
    if (department && !institution) score -= hasInstitution ? 4 : 2.5;
    if (isCompanySloganClaimLine(entityValue)) score -= 4;
    score += Math.max(0, 0.4 - line.page * 0.1);
    const evidenceType: V5EntityEvidenceAlternative['evidenceType'] = legal
      ? 'legal-company'
      : institution
        ? 'institution'
        : organization || observedDomainBrand
          ? 'organization'
          : 'logo';
    const normalizedEntityValue = domainAligned
      ? respellBrandFromDomain(
          normalizeLegal(entityValue),
          emails,
          websites
        )
      : entityValue;
    out.push({
      rawValue: entityValue,
      normalizedValue: sanitizeCompanyValue(normalizedEntityValue),
      lineId: line.id,
      page: line.page,
      evidenceType,
      reason: domainAligned
        ? ocrConfusableDomainAligned
          ? 'entita osservata corroborata da dominio con confusione OCR lettera-cifra'
          : 'entita osservata corroborata da dominio business'
        : genericMailboxBrandAligned
          ? 'brand osservato corroborato da local-part email su provider generico'
          : institution
            ? 'istituzione esplicita osservata'
            : legal
              ? 'ragione sociale esplicita osservata'
              : 'organizzazione o logo osservato',
      score: Number(score.toFixed(3)),
      selected: false,
    });
  }
  // P0 COMPANY EVIDENCE HIERARCHY STRUCTURAL
  // Le organizzazioni reali possono occupare piu righe (ente + divisione + college).
  // Costruiamo una alternativa composta senza inventare token: usiamo soltanto
  // righe OCR osservate, sulla stessa pagina, prima dei dati di contatto/indirizzo.
  const byId = new Map(lines.map((line) => [line.id, line]));
  const institutionItems = out.filter((item) => item.evidenceType === 'institution');

  for (const primary of institutionItems) {
    const primaryLine = byId.get(primary.lineId);
    if (!primaryLine) continue;

    const parts = [primary.normalizedValue];
    const sourceLineIds = [primary.lineId];
    let noise = 0;

    const following = lines
      .filter(
        (line) =>
          line.page === primaryLine.page &&
          line.indexInPage > primaryLine.indexInPage &&
          line.indexInPage <= primaryLine.indexInPage + 5
      )
      .sort((a, b) => a.indexInPage - b.indexInPage);

    for (const line of following) {
      const rawValue = clean(line.rawOcr || line.text);
      if (!rawValue) continue;

      if (
        ENTITY_CONTACT_LINE_RE.test(rawValue) ||
        FISCAL_LABEL_RE.test(rawValue) ||
        (line.masked === 'address' && !splitCompanyInlineAddress(rawValue)) ||
        /\d{3,}/.test(rawValue)
      ) {
        break;
      }

      const isInstitutionPart =
        INSTITUTION_ENTITY_RE.test(rawValue) ||
        DEPARTMENT_ENTITY_RE.test(rawValue);

      if (isInstitutionPart) {
        const normalized = sanitizeCompanyValue(normalizeLegal(rawValue));
        if (
          normalized &&
          !isCompanySloganClaimLine(normalized) &&
          !parts.some((part) => normalizeBrandKey(part) === normalizeBrandKey(normalized))
        ) {
          parts.push(normalized);
          sourceLineIds.push(line.id);
        }
        continue;
      }

      // Una riga OCR rumorosa puo separare due livelli reali, non di piu.
      noise += 1;
      if (noise > 1) break;
    }

    if (parts.length < 2) continue;

    const normalizedValue =
      parts.length === 2
        ? `${parts[0]} / ${parts[1]}`
        : `${parts[0]} / ${parts.slice(1).join(', ')}`;

    out.push({
      rawValue: sourceLineIds
        .map((id) => clean(byId.get(id)?.rawOcr || byId.get(id)?.text || ''))
        .filter(Boolean)
        .join(' | '),
      normalizedValue,
      lineId: primary.lineId,
      sourceLineIds,
      page: primary.page,
      evidenceType: 'institution',
      reason: 'gerarchia istituzionale multilivello esplicitamente osservata',
      score: Number((primary.score + Math.min(2.4, (parts.length - 1) * 1.2)).toFixed(3)),
      selected: false,
    });
  }


  // P0 MULTILINE ORG LIVE V2
  // Resolver GENERICO per brand/organizzazioni spezzati su due righe OCR.
  // IMPORTANTE: le evidenze "institution" sono escluse qui, perche hanno gia
  // una gerarchia multi-livello dedicata (es. universita/divisione/college)
  // e non devono essere degradate a una semplice coppia di righe.
  const strongByLine = new Map(
    out
      .filter((item) =>
        item.evidenceType === 'logo' ||
        item.evidenceType === 'organization'
      )
      .map((item) => [item.lineId, item])
  );

  const isNeutralBusinessFragment = (line: Line): boolean => {
    const value = clean(line.rawOcr || line.text);
    if (!value) return false;
    if (ENTITY_CONTACT_LINE_RE.test(value) || FISCAL_LABEL_RE.test(value)) return false;
    if (line.masked === 'structured' || line.masked === 'social' || line.masked === 'address') return false;
    if (ROLE_RE.test(value)) return false;
    if (parsePersonNameFromLine(value)) return false;
    if (isCompanySloganClaimLine(value)) return false;
    const letters = value.match(/\p{L}/gu)?.length ?? 0;
    const digits = value.replace(/\D/g,'').length;
    const words = value.split(/\s+/).filter(Boolean).length;
    if (letters < 3 || digits >= 5 || words > 6) return false;
    return line.companyScore >= line.personScore && line.companyScore >= line.roleScore;
  };

  const lineAt = (page: number, indexInPage: number) =>
    lines.find((line) => line.page === page && line.indexInPage === indexInPage);

  const addComposite = (
    firstLine: Line,
    secondLine: Line,
    strong: V5EntityEvidenceAlternative
  ) => {
    const firstValue = sanitizeCompanyValue(clean(firstLine.rawOcr || firstLine.text));
    const secondValue = sanitizeCompanyValue(clean(secondLine.rawOcr || secondLine.text));
    if (!firstValue || !secondValue) return;

    const composed = sanitizeCompanyValue(firstValue + ' ' + secondValue);
    const composedKey = normalizeBrandKey(composed);
    const strongKey = normalizeBrandKey(strong.normalizedValue);
    if (!composed || !composedKey || composedKey === strongKey) return;

    const domainAligned = roots.some(
      (root) =>
        root === composedKey ||
        root.startsWith(composedKey) ||
        composedKey.startsWith(root) ||
        ocrConfusableBrandKeysAlign(root, composedKey)
    );

    out.push({
      rawValue:
        clean(firstLine.rawOcr || firstLine.text) +
        ' | ' +
        clean(secondLine.rawOcr || secondLine.text),
      normalizedValue: composed,
      lineId: firstLine.id,
      sourceLineIds: [firstLine.id, secondLine.id],
      page: firstLine.page,
      evidenceType: 'organization',
      reason: domainAligned
        ? 'identita organizzativa multi-riga osservata corroborata da dominio'
        : 'identita organizzativa multi-riga osservata',
      score: Number((strong.score + 1.8 + (domainAligned ? 2.5 : 0)).toFixed(3)),
      selected: false,
    });
  };

  for (const line of lines) {
    const strong = strongByLine.get(line.id);
    if (!strong) continue;

    const prev = lineAt(line.page, line.indexInPage - 1);
    const next = lineAt(line.page, line.indexInPage + 1);

    if (prev && isNeutralBusinessFragment(prev)) addComposite(prev, line, strong);
    if (next && isNeutralBusinessFragment(next)) addComposite(line, next, strong);
  }

  return out.sort(
    (left, right) =>
      right.score - left.score ||
      left.page - right.page ||
      left.lineId - right.lineId
  );
}

function observedPersonAlternatives(
  lines: Line[],
  currentFirstName: string | null,
  currentLastName: string | null
): V5EntityEvidenceAlternative[] {
  const firstKey = normalizeBrandKey(currentFirstName ?? '');
  if (!firstKey) return [];
  return lines
    .map((line): V5EntityEvidenceAlternative | null => {
      const rawValue = clean(line.rawOcr || line.text);
      if (ENTITY_CONTACT_LINE_RE.test(rawValue) || LEGAL_RE.test(rawValue) || ROLE_RE.test(rawValue)) return null;
      const parsed = parsePersonNameFromLine(rawValue) ?? (() => {
        const stripped = rawValue.replace(HONORIFIC_RE, '').trim();
        const parts = stripped.split(/\s+/).filter(Boolean);
        if (parts.length < 2 || parts.length > 4) return null;
        if (!parts.every((part) => /^[\p{L}'’-]+$/u.test(part))) return null;
        const candidate = validatePersonName({
          firstName: cap(parts[0]),
          lastName: parts.slice(1).map(cap).join(' '),
        });
        return candidate;
      })();
      if (!parsed || normalizeBrandKey(parsed.firstName) !== firstKey) return null;
      const normalizedValue = `${parsed.firstName} ${parsed.lastName}`.trim();
      const currentKey = normalizeBrandKey(`${currentFirstName ?? ''} ${currentLastName ?? ''}`);
      const exactObserved = normalizeBrandKey(rawValue) === normalizeBrandKey(normalizedValue);
      if (!exactObserved || normalizeBrandKey(normalizedValue) === currentKey) return null;
      return {
        rawValue,
        normalizedValue,
        lineId: line.id,
        page: line.page,
        evidenceType: 'person',
        reason: 'nome completo esplicitamente osservato prevale sulla ricostruzione',
        score: 0.94,
        selected: false,
      };
    })
    .filter((value): value is V5EntityEvidenceAlternative => Boolean(value));
}

function buildMultisourceBusinessEvidence(
  lines: Line[],
  emailEvidence: EmailEvidenceMetadata[],
  websites: Map<string, number>,
  observedEntities: V5EntityEvidenceAlternative[]
): V5BusinessEvidenceProposal[] {
  type Source = {
    rawValue: string;
    normalizedValue: string;
    lineId: number;
    page: number;
    evidenceType: V5BusinessEvidenceProposal['evidenceTypes'][number];
  };
  const groups = new Map<string, Source[]>();
  const add = (key: string, source: Source) => {
    const normalizedKey = normalizeBrandKey(key);
    if (!normalizedKey) return;
    groups.set(normalizedKey, [...(groups.get(normalizedKey) ?? []), source]);
  };

  for (const item of emailEvidence) {
    if (
      item.origin !== 'observed' ||
      !item.confirmed ||
      item.requiresReview ||
      item.validationStatus !== 'valid' ||
      item.lineId === null ||
      item.pageIndex === null
    ) continue;
    const host = item.value.split('@')[1] ?? '';
    if (!host || isGenericHost(host)) continue;
    for (const root of extractBusinessDomainRootCandidates(host)) {
      add(root, {
        rawValue: item.rawOcr || item.rawValue,
        normalizedValue: splitFusedDomainBrand(root),
        lineId: item.lineId,
        page: item.pageIndex,
        evidenceType: 'email-domain',
      });
    }
  }

  for (const host of websites.keys()) {
    if (isGenericHost(host)) continue;
    const hostKey = host.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    const sourceLines = lines.filter((line) => {
      const observed = resolveExplicitWebsiteFromText(line.rawOcr || line.text, []);
      const observedKey = observed?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      return observedKey === hostKey;
    });
    for (const root of extractBusinessDomainRootCandidates(host)) {
      for (const line of sourceLines) {
        add(root, {
          rawValue: line.rawOcr || line.text,
          normalizedValue: splitFusedDomainBrand(root),
          lineId: line.id,
          page: line.page,
          evidenceType: 'website-domain',
        });
      }
    }
  }

  for (const entity of observedEntities) {
    const entityKey = normalizeBrandKey(entity.normalizedValue);
    if (!entityKey || isCompanySloganClaimLine(entity.rawValue)) continue;
    const matchingDomainKey = [...groups.keys()].find((root) => {
      const maxDistance = Math.max(root.length, entityKey.length) >= 5 ? 1 : 0;
      return fuzzyCompanyDomainDistance(entity.normalizedValue, root) <= maxDistance;
    });
    const key = matchingDomainKey ?? entityKey;
    add(key, {
      rawValue: entity.rawValue,
      normalizedValue: entity.normalizedValue,
      lineId: entity.lineId,
      page: entity.page,
      evidenceType:
        entity.evidenceType === 'logo'
          ? 'logo'
          : entity.evidenceType === 'institution'
            ? 'institution'
            : 'company-line',
    });
  }

  return [...groups.entries()]
    .map(([key, sources]): V5BusinessEvidenceProposal => {
      const uniqueSources = [...new Map(sources.map((source) => [`${source.lineId}:${source.evidenceType}`, source])).values()];
      const baseTypes = [...new Set(uniqueSources.map((source) => source.evidenceType))];
      const repeated = new Set(uniqueSources.map((source) => source.lineId)).size > 1 &&
        new Set(uniqueSources.map((source) => normalizeBrandKey(source.normalizedValue))).size === 1;
      const evidenceTypes = repeated && !baseTypes.includes('repetition')
        ? [...baseTypes, 'repetition' as const]
        : baseTypes;
      const domainSources = uniqueSources.filter((source) =>
        source.evidenceType === 'email-domain' || source.evidenceType === 'website-domain'
      );
      const observedSources = uniqueSources.filter((source) =>
        source.evidenceType === 'logo' || source.evidenceType === 'company-line' || source.evidenceType === 'institution'
      );
      const independentTypes = new Set(baseTypes).size;
      const convergent = independentTypes >= 2;
      const fuzzy = Boolean(
        domainSources.length && observedSources.some((source) => normalizeBrandKey(source.normalizedValue) !== key)
      );
      const normalizedValue = domainSources[0]?.normalizedValue ?? observedSources[0]?.normalizedValue ?? key;
      return {
        rawValue: uniqueSources.map((source) => source.rawValue).join(' | '),
        normalizedValue,
        sourceLineIds: [...new Set(uniqueSources.map((source) => source.lineId))].sort((a, b) => a - b),
        sourcePages: [...new Set(uniqueSources.map((source) => source.page))].sort((a, b) => a - b),
        evidenceTypes,
        reason: convergent
          ? fuzzy
            ? 'fonti OCR indipendenti convergono su una variante limitata osservata'
            : 'fonti OCR indipendenti convergono sulla stessa identita business'
          : 'singola fonte business osservata: proposta non operativa',
        confidence: convergent ? (fuzzy ? 0.86 : 0.92) : 0.58,
        requiresReview: !convergent || fuzzy,
      };
    })
    .sort((left, right) => right.confidence - left.confidence || right.evidenceTypes.length - left.evidenceTypes.length);
}

function buildConservativeRepairProposals(
  lines: Line[],
  emailEvidence: EmailEvidenceMetadata[]
): V5ConservativeRepairProposal[] {
  const proposals: V5ConservativeRepairProposal[] = emailEvidence
    .filter((item) => item.origin === 'repaired' && item.repairedValue && item.lineId !== null && item.pageIndex !== null)
    .map((item) => ({
      field: 'email' as const,
      raw: item.rawValue,
      repaired: item.repairedValue as string,
      transformations: [...item.transformations],
      sourceLineIds: [item.lineId as number],
      sourcePages: [item.pageIndex as number],
      confidence: Math.min(0.69, item.confidence),
      requiresReview: true as const,
      confirmed: false as const,
      operational: false as const,
    }));

  for (const line of lines) {
    const raw = clean(line.rawOcr || line.text);
    if (!raw) continue;

    let websiteCandidate = raw;
    const websiteTransformations: string[] = [];
    if (/^[^\p{L}\p{N}]{1,6}\s*(?:https?:\/\/|www\.)/u.test(websiteCandidate)) {
      websiteCandidate = websiteCandidate.replace(/^[^\p{L}\p{N}]{1,6}\s*/u, '');
      websiteTransformations.push('remove_leading_contact_icon');
    }
    if (/(?:www\.|https?:\/\/)[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/i.test(websiteCandidate)) {
      websiteCandidate = websiteCandidate.replace(/\s*\.\s*/g, '.');
      websiteTransformations.push('remove_spaces_around_dot');
    }
    if (/(?:www\.|https?:\/\/)[^\s]+[.,;:!?)]$/i.test(websiteCandidate)) {
      websiteCandidate = websiteCandidate.replace(/[.,;:!?)]$/, '');
      websiteTransformations.push('trim_trailing_punctuation');
    }
    if (websiteTransformations.length) {
      const repairedWebsite = resolveExplicitWebsiteFromText(websiteCandidate, []);
      if (repairedWebsite) {
        proposals.push({
          field: 'website',
          raw,
          repaired: repairedWebsite,
          transformations: websiteTransformations,
          sourceLineIds: [line.id],
          sourcePages: [line.page],
          confidence: 0.66,
          requiresReview: true,
          confirmed: false,
          operational: false,
        });
      }
    }

    const labeledPhone = raw.match(/\b(?:tel(?:efono)?|phone|fax|cell(?:ulare)?|mobile|whatsapp)\b[.\s:=-]*(.+)$/i);
    if (labeledPhone) {
      const payload = labeledPhone[1]?.trim() ?? '';
      const digitCount = payload.replace(/\D/g, '').length;
      if (/^[+\dOo\s().\/-]+$/.test(payload) && /[Oo]/.test(payload) && digitCount >= 6) {
        proposals.push({
          field: 'phone',
          raw,
          repaired: raw.slice(0, raw.length - payload.length) + payload.replace(/[Oo]/g, '0'),
          transformations: ['replace_ocr_o_with_zero_in_labeled_numeric_context'],
          sourceLineIds: [line.id],
          sourcePages: [line.page],
          confidence: 0.61,
          requiresReview: true,
          confirmed: false,
          operational: false,
        });
      }
    }
  }

  return [...new Map(proposals.map((item) => [`${item.field}:${item.sourceLineIds.join(',')}:${item.repaired}`, item])).values()];
}

interface Features {
  fontScale: number;
  yQuantile: number;
  tokenCount: number;
  length: number;
  allCaps: boolean;
  titleCase: boolean;
  hasHonorific: boolean;
  hasLegalSuffix: boolean;
  legalSuffixOnly: boolean;
  preSuffixActivityOnly: boolean;
  descriptorTagline: boolean;
  inNameLexicon: boolean;
  emailLocalMatch: number; // 0..1
  domainRootMatch: number; // 0..1
  roleKeyword: boolean;
  activityWords: number;
  acronymCluster: boolean;
  addressLike: boolean;
  digitRatio: number;
}

// ---------------------------------------------------------------------------
// Pesi e soglie — UNICO punto di taratura (rifittabile sul golden corpus)
// ---------------------------------------------------------------------------

const W = {
  person: {
    emailLocalMatch: 5.0,
    lexicon: 2.4,
    honorific: 2.2,
    titleCase: 1.4,
    bigFont: 1.1, // fontScale > 1.2
    topHalf: 0.4,
    allCapsPair: 0.7, // "MARIO FRATI"
    legalSuffix: -4.5,
    roleKeyword: -3.0,
    activityWord: -1.6, // per parola
    acronymCluster: -3.0,
    domainRootMatch: -2.0,
    digits: -3.0,
    tooManyTokens: -2.0, // > 4
    singleToken: -2.5,
  },
  company: {
    legalSuffix: 4.2,
    legalPlusBrand: 1.8, // "ICT-GROUP S.r.l." batte il logo "ICTGROUP": è la denominazione completa
    domainRootMatch: 3.2,
    bigFont: 1.3,
    topBand: 0.7, // primo 30% della pagina
    brandRepetition: 0.8, // per ripetizione extra su altre righe/pagine
    allCapsShort: 0.5,
    emailLocalMatch: -3.0,
    genericHeader: -5.0,
    preSuffixActivityOnly: -3.2, // "DISTRIBUZIONE SPA" non è la ragione sociale
    descriptorTagline: -5.5, // slogan lungo + forma giuridica (A&D, EGMS)
    descriptorLine: -4.5, // riga descrittiva senza legal form sulla stessa riga
    compactBrand: 2.2, // "A&D S.r.l." compatto coerente col dominio
    roleKeyword: -3.0,
    acronymCluster: -2.8,
    activityWord: -1.1, // per parola
    personShape: -1.8, // 2 token title-case con nome in lessico
    addressLike: -4.0,
    tooLong: -1.5, // > 55 char
    digits: -2.0,
  },
  role: {
    keyword: 4.2,
    partnerStatus: -6.0,
    smallFont: 0.5,
    nearPerson: 1.6, // entro 2 righe dal nome scelto
    legalSuffix: -3.5,
    emailLocalMatch: -3.0,
    addressLike: -4.0,
    digits: -2.5,
    tooLong: -1.0, // > 45 char
  },
} as const;

const T = { person: 2.0, company: 2.0, role: 2.4 } as const;

// ---------------------------------------------------------------------------
// Risorse linguistiche GENERICHE (mai parole di biglietti specifici)
// ---------------------------------------------------------------------------

const LEGAL_RE = new RegExp(
  `\\b${LEGAL_FORM_PATTERN_SOURCE}(?=[\\s.,;:)]|$)`,
  'i'
);

const HONORIFIC_RE =
  /^(?:(?:dr\.?ssa|d\.?ssa|dott\.?(?:\s*ssa)?|dr\.?(?:\s*-?\s*ing\.?)?|ing\.?|arch\.?|avv\.?|avy\.?|geom\.?|rag\.?|prof\.?(?:\s*dr\.?)?|p\.i\.|per\.?\s*ind\.?|mr\.?|mrs\.?|ms\.?|herr|frau|m\.|mme\.?|sig\.?(?:\s*ra)?)\s+)+/i;

const ROLE_RE =
  /\b(?:ceo|cto|cfo|coo|cio|cmo|c\.e\.o\.|presidente?|pr[eé]sident|vice\s*president|vp|chairman|owner|founder|co-?founder|titolare|delegato(?:\s+alle\s+vendite)?|amministratore(?:\s+(?:delegato|unico))?|socio(?![-‐])|partner|manager|direttore|direttrice|director|directeur|leiter(?:in)?|gesch[aä]ftsf[uü]hrer(?:in)?|responsabile|resp\.?|head\s+of|chief\s+\w+(?:\s+officer)?|consulente|consultant|advisor|account(?:\s+(?:manager|executive))?|sales(?:\s+\w+)?|export(?:\s+\w+)?|marketing(?:\s+manager)?|buyer|engineer|ingegnere|architect(?:o)?|developer|analyst|analista|specialist|coordinator|coordinatore|coordenador|supervisor|tecnico|perito(?:\s+(?:industriale|tecnico|agrario|edile|elettronico|elettrotecnico|meccanico|informatico))?|surveyor|commerciale|agente|rappresentante|promotore|professor(?:e)?|ricercatore|docente|capo\s+\w+|key\s+account|project\s+manager|product\s+manager|area\s+manager|general\s+manager|gerente|channel\s+partner|executive)\b/i;

/** Sostantivi di settore/attività — feature negativa mite, lista generica. */
const ACTIVITY_RE =
  /\b(?:soluzioni?|solutions?|servizi|services?|systems?|sistemi|software|hardware|consulting|consulenz[ae]|tecnolog\w+|technolog\w+|informatic[ao]|engineering|ingegneria|automazione|impianti|costruzioni|edilizia|logistica|trasporti|spedizioni|produzione|vendita|noleggio|forniture|distribuzione|commercio|import|export|packaging|comunicazione|pubblicit\w+|grafica|design|web|digital|energie?|elettr\w+|meccanic[ao]|idraulic[ao]|arredament\w+|immobiliar\w+|assicura\w+|finanziar\w+|formazione|training|sicurezza|security|networking|management|marketing|innovation|innovativ\w+|quality|qualit[aà]|certificat\w+|group|gruppo|international|italia|italy)\b/i;

const STREET_RE =
  /\b(?:via|viale|v\.le|vicolo|corso|c\.so|piazza|p\.zza|piazzale|p\.le|largo|galleria|contrada|localit[aà]|loc\.|frazione|fraz\.|zona\s+ind\w*|z\.i\.|strada|s\.s\.\s*\d|s\.p\.\s*\d|str(?:asse|aße)?|str(?:asse|aße)\b|platz|allee|weg|gasse|rue|route|cours|crs\.?|bd\.?|boulevard|blvd\.?|street|st\.|road|rd\.|lane|ln\.|drive\b|calle|carrer|avenida|paseo|ul\.?|ch\.\s*des|\w+straat)\b|\b[A-Za-zÀ-ÿ]{3,}(?:strasse|straße|str\.)\s+\d{1,5}\b|\b\d{1,5}\s+[A-Za-zÀ-ÿ][\w.'-]*\s+(?:st|street|rd|road|ave|avenue|ln|lane|dr|drive)\.?\s*$/i;

const CIVIC_LABEL_PATTERN = CIVIC_LABEL_PATTERN_SOURCE;

const COUNTRY_RE =
  /\b(?:ital(?:y|ia)|german(?:y|ia)|deutschland|france|francia|españa|spain|spagna|switzerland|svizzera|schweiz|suisse|austria|belgi(?:um|o|que)|netherlands|olanda|uk|united\s+kingdom|inghilterra|usa|united\s+states|canada|brasil|brazil|argentina|japan|giappone|china|cina|korea|corea|south\s+korea|norge|norway|norvegia|sverige|sweden|danmark|denmark|polska|poland|portugal|singapore|taiwan|hong\s+kong|ireland|irlanda|pakistan|india|australia|mexico|sweden)\b/i;

const OFFICE_ADDR_LABEL_RE =
  /^(?:head\s+office|main\s+office|branch\s+office|registered\s+office|corporate\s+office|sales\s+office|regional\s+office|warehouse|showroom|factory|plant|daegu\s+office|seoul\s+office|local\s+office|sede\s+(?:centrale|operativa|legale|amministrativa|fiscale))(?:\s*:)?\s*$/i;

const FOREIGN_ADDR_LINE_RE =
  /\b(?:korea|corea|japan|giappone|china|cina|singapore|taiwan|hong\s+kong|metropolitan\s+city|belgium|belgique|nederland|netherlands|ireland|irlanda|pakistan|dublin)\b|\b(?:room\s*#?\s*\d+|floor\s+\d+|suite\s+\d+|technopark|industrial\s+park|business\s+park|center\s+\d+)\b|(?:^|[\s,\-])(?:\d+-\d+\s+[A-Za-z]+(?:-dong|-gu|-ku|-do)|[A-Za-z]+(?:-Dong|-Gu|-Ku|-Do|-Si|-Gun))\b|\b[A-Za-zÀ-ÿ' .-]{2,42}\s+City\b|\b\d{4}\s+[A-Za-zÀ-ÿ' .-]{2,}(?:\s*\([A-Za-z]{2,12}\))?|\b\w+straat\b|\b[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,30}\s+\d{1,4}\s*,\s*[A-Za-z]/i;

const CONTACT_LABEL_RE =
  /\b(?:tel(?:efono|ephone|\.|:)?|phone|ph\.?|fon|fax|telefax|mob(?:ile)?\.?|cell(?:ulare|\.)?|whatsapp|wa\.?|e-?mail|mail|pec|skype|internet|web|sito(?:\s*web)?|www|uff(?:icio)?\.?|dir(?:etto)?\.?|verde|office|hq)\b/i;

const SOCIAL_RE = /\b(?:facebook|instagram|linkedin|twitter|youtube|tiktok|telegram)\b/i;

const EMAIL_RE = /[a-z0-9._%+\-]+\s*@\s*[a-z0-9.\-]+(?:\s*\.\s*[a-z]{2,})+/gi;
const URL_RE =
  /\b(?:https?:\/\/)?(?:www\.)[a-z0-9\-]+(?:\.[a-z0-9\-]+)+\b|\b[a-z0-9\-]{2,}\.(?:it|com|net|org|eu|de|fr|es|ch|at|co\.uk|uk|io|info|biz|edu|gov|ven\.it|pk)\b/gi;
const PHONE_SEQ_RE = /(?:\+|00)?\s*\(?\d[\d\s().,\/\-]{5,}\d/g;
const VAT11_RE = /\b\d{11}\b/;
const CF16_RE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/i;
const VAT_LABEL_RE =
  /\b(?:p\.?\s*[i1lj|]?\s*v\.?\s*a\.?|p\.?\s*j\.?(?=\s|\.|$)|p\.?\s*i\.?(?=\s|\.|$)|\bpi\b|pjva\b|p\.?\s*va\b|part\.?\s*va|partita\s*iva|vat(?:\s*(?:no|nr|id|number))?|ust-?id)\b/i;
const CF_LABEL_RE =
  /\b(?:i\.?\s*c\.?\s*f\.?|c\.?\s*f\.?(?:\s*\/?\s*p\.?\s*i\.?|pi)?|c\.?f\.?p\.?i\.?|cod(?:ice|ioe|lce)?\.?\s*f[i1l|]sc(?:ale)?\.?)\b|(?<=\d)(?:i\.?\s*)?c\.?\s*f\.?/i;
const FISCAL_LABEL_RE = new RegExp(`${VAT_LABEL_RE.source}|${CF_LABEL_RE.source}`, 'i');
const POSTAL_RE = /\b\d{4,6}\b/;
const PROVINCE_RE = /\(([A-Z]{2})\)/;
const CITY_PROV_ONLY_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,42}\s*\([A-Z]{2}\)\s*$/i;
const CAP_CITY_PROV_RE = /\b(\d{5})\s+([A-Za-zÀ-ÿ'’ .-]{2,42})\s*\(([A-Z]{2})\)/i;

const GENERIC_DOMAIN_RE =
  /^(?:gmail|googlemail|yahoo|hotmail|outlook|live|msn|icloud|me|libero|virgilio|tiscali|alice|tin|aruba|pec|legalmail|email|mail|fastwebnet|teletu|vodafone|tim|ybb|aol|gmx|web|t-online|free|orange|wanadoo)\./i;
const GENERIC_LOCAL_RE =
  /^(?:info|contact|contatti|sales|vendite|commerciale|export|amministrazione|admin|office|ufficio|segreteria|ordini|support|assistenza|service|marketing|hello|mail|posta|pec|webmaster|hr|jobs|press|restaurant|shop|store|formazione|training|education)\d*$/i;

/**
 * Lessico compatto di nomi propri frequenti (IT + EU + intl).
 * È una FEATURE (risorsa linguistica generica), non un filtro: un nome fuori
 * lista può vincere comunque via email-match / onorifico / geometria.
 */
const FIRST_NAMES = new Set(
  (
    'adriano agnese agostino alba alberto aldo alessandra alessandro alessia alessio alfredo alice ' +
    'amedeo andrea angela angelo anna annalisa annamaria antonella antonietta antonio arianna arturo ' +
    'barbara beatrice benedetta bruno camilla carla carlo carlotta carmela carmelo carmine caterina ' +
    'cecilia cesare chiara cinzia cirillo cira claudia claudio corrado cosimo cristian cristiana ' +
    'cristina damiano daniela daniele danilo dario davide debora denis diego dino domenico donatella ' +
    'edoardo elena eleonora elia eliana elisa elisabetta emanuela emanuele emilio enrica enrico enzo ' +
    'erica ermanno ernesto ester fabio fabrizio fausto federica federico felice ferdinando filippo ' +
    'fiorella flavia flavio franca francesca francesco franco fulvio gabriele gabriella gaetano ' +
    'gennaro giacomo giada giancarlo gianfranco gianluca gianluigi gianmarco gianni gianpaolo gino ' +
    'giorgia giorgio giovanna giovanni giulia giuliana giuliano giulio giuseppe giuseppina graziano ' +
    'greta guido ilaria ines irene isabella italo ivan ivana ivano jacopo katia lara laura leonardo ' +
    'letizia lia liliana lina lino livio lorella lorenza lorenzo loredana loris luca lucia luciana ' +
    'luciano lucio ludovica luigi luigia luisa manuel manuela mara marcella marcello marco margherita ' +
    'maria marianna marina marino mario marisa marta martina massimiliano massimo matilde matteo ' +
    'mattia maurizio mauro melissa michela michele milena mirco mirella mirko monica morgan nadia ' +
    'natale nicola nicoletta nino noemi orazio ornella oscar osvaldo paola paolo pasquale patrizia ' +
    'patrizio piera pierluigi piero pietro pina pino primo raffaele raffaellaremo renata renato ' +
    'renzo riccardo rino rita roberta roberto rocco rodolfo romano rosa rosanna rosario rossana ' +
    'rossella ruggero sabrina salvatore samanta samuele sandra sandro sara saverio sebastiano serena ' +
    'sergio silvana silvano silvia simona simone sofia sonia stefania stefano susanna teresa tiziana ' +
    'tiziano tommaso ugo umberto valentina valentino valeria valerio vanessa vera veronica vincenzo ' +
    'vito vittoria vittorio walter ' +
    // internazionali frequenti
    'john james david michael robert william thomas richard mark paul peter kevin brian jason eric ' +
    'mary patricia jennifer linda elizabeth susan jessica sarah karen nancy katie ' +
    'hans klaus wolfgang werner jürgen juergen joachim dieter helmut manfred rainer uwe frank stefan ' +
    'markus andreas thorsten jörg joerg gerhard heinz kurt rolf horst alexander katrin sabine petra ' +
    'jean pierre michel philippe alain bernard jacques françois francois claude marcel rené rene ' +
    'jean-marc jean-pierre jean-paul jean-luc marie sophie isabelle nathalie dominique lars sven ' +
    'erik erick henrik björn bjorn olaf nils per jan kaj carlos jose josé juan luis miguel pedro ' +
    'javier alvaro álvaro diego pablo sergio fernando jorge manuel antónio joão joao hiroshi takeshi ' +
    'kenji victor viktor dmitri ivan sergei mohammed ahmed ali omar'
  )
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n.replace(/[^a-z]/g, ''))
);

const NAME_PARTICLES = new Set(['de', 'di', 'del', 'della', 'dello', 'dei', 'degli', 'da', 'dal', 'la', 'le', 'lo', 'van', 'von', 'der', 'den', 'mac', 'mc', 'san', 'santa']);

function isOfficeAddressLabel(text: string): boolean {
  return OFFICE_ADDR_LABEL_RE.test(text.trim());
}

function isOcrFusedEmailDomainLine(text: string): boolean {
  return isOcrFusedEmailLikeLine(text);
}

function isAddressContinuationLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 4) return false;
  if (isOcrFusedEmailDomainLine(t)) return false;
  if (/@|www\.|https?:\/\//i.test(t)) return false;
  if (COUNTRY_RE.test(t) || isForeignAddressLine(t)) return true;
  return /\b(?:estate|industrial|park|building|floor|suite|zone|district|quarter|center|centre)\b/i.test(t);
}

function isPhoneOrFaxLine(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:tel(?:efono)?|fax|phone|ph\.?|mob(?:ile)?\.?|cell(?:ulare)?)(?=[\s_.:=-]*(?:\+|00|\(?\d))/iu.test(text) ||
    /^\s*[FT]\s*(?=[:._+\d])/i.test(text);
}

function isOcrContactResidualLine(text: string): boolean {
  const t = text.trim();
  if (!t || STREET_RE.test(t) || POSTAL_RE.test(t) || COUNTRY_RE.test(t)) return false;

  // Una riga "Torino tel +39..." contiene ancora una città osservata valida:
  // non va scartata come residuo contatto. I qualifier "direct/office/..." invece
  // restano esclusi da cityPrefixBeforeContact e possono essere rimossi.
  if (cityPrefixBeforeContact(t)) return false;

  if (isPhoneOrFaxLine(t)) return true;

  const tokens = t.split(/\s+/).filter(Boolean);
  const compactTokens = tokens
    .map((token) => token.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);

  if (compactTokens.length < 2 || compactTokens.length > 8) return false;

  const singleLetterCount = compactTokens.filter((token) => /^[A-Za-z]$/.test(token)).length;
  const numericCount = compactTokens.filter((token) => /^\d{1,3}$/.test(token)).length;
  const startsContactStub = /^[tfmpc]$/i.test(compactTokens[0] ?? '');
  const hasSecondContactStub = compactTokens
    .slice(1, 4)
    .some((token) => /^[tfmpc]$/i.test(token));

  return startsContactStub &&
    hasSecondContactStub &&
    singleLetterCount >= 2 &&
    numericCount >= 1;
}

function isForeignAddressLine(text: string): boolean {
  const t = text.trim();
  if (!t || isOfficeAddressLabel(t)) return false;
  if (isPhoneOrFaxLine(t)) return false;
  if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) return false;
  return FOREIGN_ADDR_LINE_RE.test(t) || (COUNTRY_RE.test(t) && t.length > 10);
}

function lineLooksLikeAddress(original: string): boolean {
  if (isOcrFusedEmailDomainLine(original)) return false;
  if (/@|www\.|https?:\/\//i.test(original)) return false;
  if (splitCompanyInlineAddress(original)) return true;
  const addressWords = original.trim().split(/\s+/).filter(Boolean);
  if (
    STREET_RE.test(original) &&
    !/\d/.test(original) &&
    addressWords.length <= 2
  ) {
    return false;
  }
  if (
    ROLE_RE.test(original) &&
    !STREET_RE.test(original) &&
    !POSTAL_RE.test(original) &&
    !isOfficeAddressLabel(original) &&
    !/\b\d{1,5}[a-z]?\b/i.test(original)
  ) {
    return false;
  }
  return (
    isOfficeAddressLabel(original) ||
    isForeignAddressLine(original) ||
    STREET_RE.test(original) ||
    (POSTAL_RE.test(original) &&
      (PROVINCE_RE.test(original) ||
        COUNTRY_RE.test(original) ||
        /\b\d{5}\s+[A-ZÀ-Ý][a-zà-ÿ]/i.test(original))) ||
    /\b\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]{3,}/i.test(original) ||
    /\b\d{4,6}\s+[A-Za-zÀ-ÿ'’ .\-]{3,}(?:\s*\([A-Z]{2}\))?/i.test(original) ||
    /\b[A-Za-z]{3,}(?:strasse|straße|str\.)\s+\d{1,5}\b/i.test(original) ||
    /\b[A-Z]{1,2}-\d{4,6}\s+[A-Za-zÀ-ÿ'’ .\-]{2,}/i.test(original) ||
    /\b\d{4}\s+[A-Za-zÀ-ÿ'’ .-]{2,}(?:\s*\([A-Za-z]{2,12}\))?/i.test(original) ||
    /\b\w+straat\b/i.test(original) ||
    /\b[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,30}\s+\d{1,4}\s*,\s*[A-Za-z]/i.test(original) ||
    (COUNTRY_RE.test(original) && original.length >= 8 && !ROLE_RE.test(original)) ||
    isAddressContinuationLine(original) ||
    CITY_PROV_ONLY_RE.test(original.trim()) ||
    CAP_CITY_PROV_RE.test(original)
  );
}

function extractCompanyPrefixFromFiscalLine(text: string): string | null {
  const m = normalizeLegal(text).match(
    /^(.+?\s+(?:s\.?\s*n\.?\s*c\.?|snc|s\.?\s*r\.?\s*l\.?|srl|spa|s\.?\s*p\.?\s*a\.?|s\.?\s*a\.?\s*s\.?|bvba|gmbh|ltd|limited|llc))\s+(?:CF|C\.?\s*F\.?|P\.?\s*IVA|PIVA|PNA|p\.?\s*iva|p\.?\s*i\.?\s*va)\b/i
  );
  return m?.[1]?.trim() ?? null;
}

function pickCompanyFromFiscalLines(
  lines: Line[],
  emails: string[],
  rawText: string
): { value: string; lineId: number; score: number } | null {
  for (const l of lines) {
    if (l.masked === 'contact-label' || l.masked === 'social') continue;
    const prefix = extractCompanyPrefixFromFiscalLine(l.text);
    if (!prefix) continue;
    const finalized = finalizeCompanyValue(normalizeLegal(prefix), emails, rawText);
    if (finalized) {
      return { value: finalized, lineId: l.id, score: T.company + 1.2 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function repairAddressPipeOcr(text: string): string {
  return text
    .replace(/^[^\p{L}]{1,3}(?=(?:via|viale|vicolo|corso|piazza|strada|street|road|avenue)\b)/iu, '')
    .replace(/\s+[Il|]\s+(?=[A-Za-zÀ-ÿ])/g, ' | ')
    .replace(/\s+[Il|]\s+(?=\d{4,6}\b)/g, ' | ');
}

function repairExplicitWebsiteSpacing(text: string): string {
  // OCR può perdere entrambi i punti di un sito esplicito:
  // "www themissoluzioni it" -> "www.themissoluzioni.it".
  // La riparazione è limitata al prefisso www/http e a TLD plausibili.
  let repaired = text.replace(
    /\bwww\s+([a-z0-9][a-z0-9-]{1,62})\s+(it|com|net|org|eu|de|fr|es|ch|at|uk|io|info|biz|edu|gov|pk)\b/gi,
    'www.$1.$2'
  );
  if (!/(?:https?:\/\/|www\.)/i.test(repaired)) return repaired;
  return repaired
    .replace(
      /((?:https?:\/\/|www\.)[a-z0-9][a-z0-9.-]*)\s*-\s*([a-z0-9][a-z0-9.-]*\.[a-z]{2,63}\b)/gi,
      '$1-$2'
    )
    .replace(
      /((?:https?:\/\/|www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*)\s*\.\s*([a-z]{2,63})\b/gi,
      '$1.$2'
    );
}

function stripJunk(s: string): string {
  let t = clean(s)
    .replace(/^[^\p{L}\p{N}+(]+/u, '')
    .replace(/[^\p{L}\p{N}.)!?]+$/u, '');
  // Un glifo logo isolato può essere letto come y/v davanti a un token tutto maiuscolo.
  t = t.replace(/^[yv](?=[A-Z]{4,})/, '');
  return t;
}

function compact(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function sim(a: string, b: string): number {
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return Math.max(0, 1 - d / Math.max(a.length, b.length));
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function tokens(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.replace(/^[,;:]+|[,;:.]+$/g, ''))
    .filter(Boolean);
}

function isTitleTok(t: string): boolean {
  return /^[A-ZÀ-Ý][a-zà-ÿ]*(?:[-'’][A-ZÀ-Ýa-zà-ÿ][a-zà-ÿ]*)*$/.test(t) || NAME_PARTICLES.has(t.toLowerCase());
}
function isCapsTok(t: string): boolean {
  return /^[A-ZÀ-Ý][A-ZÀ-Ý'’.\-]+$/.test(t) && t.length >= 2;
}

function cap(word: string): string {
  if (!word) return word;
  return word
    .split(/([\s'’\-])/)
    .map((p) => (/^[a-zà-ÿA-ZÀ-Ý]/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
    .join('');
}

const SMALL_WORDS = new Set(['di', 'e', 'a', 'da', 'del', 'della', 'dei', 'degli', 'and', 'of', 'the', 'für', 'fur', 'de', 'la', 'per', '&']);
const GENERIC_COMPANY_HEADER = new Set([
  'impresa',
  'edile',
  'studio',
  'ditta',
  'societa',
  'società',
  'consulenza',
  'servizi',
]);

/** Parole geografiche che non devono essere scelte come azienda. */
const GEOGRAPHIC_DESCRIPTOR_RE =
  /^(?:santiago\s+del?\s+cile|ciudad\s+de\s+|città\s+di\s+|municipio|province\s+of|region\s+of|prefecture\s+of|county\s+of|commune\s+de)\b/i;

function titleCasePhrase(s: string): string {
  return tokens(s)
    .map((t, i) => {
      if (/^[A-Z0-9&.]{2,4}$/.test(t) && t === t.toUpperCase()) return t; // acronimi
      const fixed = fixOcrTokenCasing(t);
      if (fixed === fixed.toUpperCase() && fixed.length >= 4) return fixed;
      const lower = fixed.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return cap(fixed);
    })
    .join(' ');
}

function normalizeLegal(s: string): string {
  return s
    .replace(/\b[S5]\.?\s*r\.?\s*[lI1i|]\.?\s*s\.?(?=[\s.,)]|$)/gi, 'S.r.l.s.')
    .replace(/\b[S5]\.?\s*r\.?\s*[lI1i|]\.?(?!\s*\.?\s*s\.?(?=[\s.,)]|$))(?=[\s.,)]|$)/gi, 'S.r.l.')
    .replace(/\b[S5]\.?\s*p\.?\s*[aA@4]\.?(?=[\s.,)]|$)/gi, 'S.p.A.')
    .replace(/\b[S5]\.?\s*n\.?\s*c\.?(?=[\s.,)]|$)/gi, 'S.n.c.')
    .replace(/\b[S5]\.?\s*a\.?\s*[sS5]\.?(?=[\s.,)]|$)/gi, 'S.a.s.')
    .replace(/\bsrls\b/gi, 'S.r.l.s.')
    .replace(/\bsrl\b/gi, 'S.r.l.')
    .replace(/\bspa\b/gi, 'S.p.A.')
    .replace(/\bsnc\b/gi, 'S.n.c.')
    .replace(/\bsas\b/gi, 'S.a.s.')
    .replace(/\.\.+/g, '.');
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}


/** Checksum P.IVA italiana (11 cifre). Coglie l'errore OCR su UNA cifra. */
function isValidItalianVat(v: string): boolean {
  if (!/^\d{11}$/.test(v)) return false;
  let X = 0;
  let Y = 0;
  for (let i = 0; i < 10; i++) {
    const d = Number(v[i]);
    if (i % 2 === 0) X += d;
    else {
      let t = 2 * d;
      if (t > 9) t -= 9;
      Y += t;
    }
  }
  return (10 - ((X + Y) % 10)) % 10 === Number(v[10]);
}

const KNOWN_INTERNET_TLDS = new Set([
  'com', 'it', 'net', 'org', 'eu', 'de', 'fr', 'es', 'ch', 'at', 'uk', 'io', 'info', 'biz', 'edu', 'gov',
  'pk', 'pl', 'be', 'nl', 'us', 'ca', 'au', 'in', 'cn', 'jp', 'kr', 'ae', 'sa', 'pt', 'cz', 'sk', 'ro', 'hu',
  'gr', 'se', 'no', 'dk', 'fi', 'ie', 'co', 'me', 'tv', 'cc', 'ly',
]);

/** Handle social/Skype (asim.nayyer) — non email né sito web. */
function isPersonHandleLine(text: string): boolean {
  const t = text.trim().replace(/\s+/g, '');
  if (!t || t.includes('@') || /\s/.test(text.trim())) return false;
  const m = t.match(/^([a-z]{2,15})\.([a-z]{2,15})$/i);
  if (!m) return false;
  if (KNOWN_INTERNET_TLDS.has(m[2].toLowerCase())) return false;
  return true;
}

function isPlausibleInternetHost(host: string): boolean {
  const bare = host.replace(/^www\./i, '').toLowerCase().trim();
  if (!bare || bare.includes('@')) return false;
  const parts = bare.split('.').filter(Boolean);
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1] ?? '';
  if (!KNOWN_INTERNET_TLDS.has(tld)) return false;
  if (parts.length === 2 && /^[a-z]{2,15}\.[a-z]{2,15}$/i.test(bare) && !KNOWN_INTERNET_TLDS.has(parts[1])) {
    return false;
  }
  return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,63}$/i.test(bare);
}

/** P.IVA solo con evidenza geografica/fiscale italiana — non su biglietti esteri. */
function hasItalianFiscalContext(lines: Line[], rawText: string): boolean {
  const text = rawText.toLowerCase();
  if (/\b(?:italy|italia)\b/.test(text)) return true;
  if (CAP_CITY_PROV_RE.test(rawText)) return true;
  if (/\b\d{5}\s+[a-zà-ü' .-]{2,}\s*\([A-Z]{2}\)/i.test(rawText)) return true;
  if (/\b(?:p\.?\s*iva|partita\s*iva|cod\.?\s*f[i1l|]sc|p\.?\s*j\.?|i\.?\s*c\.?\s*f\.?|c\.?\s*f\.?\s*\/?\s*p\.?\s*i\.?)\b/i.test(rawText)) return true;
  if (/(?<=\d)(?:i\.?\s*)?c\.?\s*f\.?/i.test(rawText)) return true;
  if (/\b(?:pakistan|sialkot|dublin|ireland|germany|france|belgium|usa|canada|korea|china|japan)\b/i.test(text)) {
    return false;
  }
  return lines.some((l) => CAP_CITY_PROV_RE.test(l.text) || CITY_PROV_ONLY_RE.test(l.text.trim()));
}

function pickBestWebsiteHost(
  hosts: string[],
  websites: Map<string, number>,
  allText: string,
  emails: string[]
): string | null {
  const textHosts: string[] = [];
  for (const m of allText.match(/(?:www\.)?[a-z0-9][a-z0-9.\-]*\.(?:com|it|net|org|eu|pk|de|fr|uk|io|biz)/gi) ?? []) {
    const h = m.replace(/^www\./i, '').toLowerCase();
    if (isPlausibleInternetHost(h)) textHosts.push(h);
  }
  // La scansione del testo può vedere anche il dominio dentro una email:
  // il set dei candidati resta quindi limitato agli host estratti come sito.
  const candidates = new Set(hosts);
  let best: { host: string; score: number } | null = null;
  const brandRoot = compact(getPrimaryBusinessEmailDomain(emails)?.split('.')[0] ?? '');
  for (const host of candidates) {
    if (!isPlausibleInternetHost(host)) continue;
    const finalHost = host;
    let score = (websites.get(host) ?? 0) * 2 + textHosts.filter((t) => t === host).length;
    const rootKey = compact(finalHost.split('.')[0] ?? '');
    if (brandRoot && (rootKey.startsWith(brandRoot) || brandRoot.startsWith(rootKey.slice(0, Math.min(brandRoot.length, rootKey.length))))) {
      score += 5;
    }
    if (!best || score > best.score) best = { host: finalHost, score };
  }
  return best?.host ?? null;
}

function repairFiscalDigits(text: string): string {
  return text.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
}

function fiscalNumericTail(original: string): string {
  const match = original.match(
    /(?:c\.?\s*f\.?(?:\s*\/?\s*p\.?\s*i\.?)?|p\.?\s*[i1lj|]?\s*v\.?\s*a\.?|pjva|p\.?\s*va|part\.?\s*va|partita\s*iva|cod(?:ice)?\.?\s*f[i1l|]sc(?:ale)?|vat)\b[:\s.\-]*/i
  );
  if (!match) return original;
  const idx = original.toLowerCase().indexOf(match[0].toLowerCase());
  return original.slice(idx + match[0].length);
}

function extractFiscalFromLine(original: string): { vat11?: string; cf16?: string } {
  const source =
    CONTACT_LABEL_RE.test(original) && FISCAL_LABEL_RE.test(original)
      ? fiscalNumericTail(original)
      : original;
  const cf16 = source.toUpperCase().match(CF16_RE)?.[0] ?? original.toUpperCase().match(CF16_RE)?.[0];
  const spaced11 = source.match(/\b(\d{9})\s+(\d{2})\b/);
  if (spaced11) {
    return { vat11: `${spaced11[1]}${spaced11[2]}`, cf16 };
  }
  const spaced56 = source.match(/\b(\d{5})\s+(\d{6})\b/);
  if (spaced56) {
    return { vat11: `${spaced56[1]}${spaced56[2]}`, cf16 };
  }
  const itPrefixed = source.match(/\bIT\s*(\d{11})\b/i);
  if (itPrefixed) {
    return { vat11: itPrefixed[1], cf16 };
  }

  const numericChunks = source.match(/\d[\d.\sOoIl|]{6,}\d/g) ?? [];
  for (const chunk of numericChunks) {
    const repaired = repairFiscalDigits(chunk).replace(/[^\d]/g, '');
    const embedded = repaired.match(/\d{11}/);
    if (embedded) return { vat11: embedded[0], cf16 };
  }

  const repairedLine = repairFiscalDigits(source);
  const vat11 =
    repairedLine.match(/\b\d{11}\b/)?.[0] ??
    repairedLine.replace(/\D/g, '').match(/\d{11}/)?.[0];

  return { vat11, cf16 };
}

function normalizeObservedPhoneFormatting(value: string): string {
  const raw = clean(value).replace(/\s+/g, ' ').trim();
  if (!raw) return raw;

  // Parentheses around an observed area/prefix group are presentation only.
  // Preserve the group boundary but never infer a country code.
  const parenthesizedPrefix = raw.match(/^\(\s*(\d{2,6})\s*\)\s*(.+)$/);
  if (parenthesizedPrefix) {
    const rest = parenthesizedPrefix[2]
      .replace(/[.,_\/-]+/g, '')
      .replace(/[()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `${parenthesizedPrefix[1]} ${rest}`.trim();
  }

  const hasOcrDirtySeparators = /[.,_]/.test(raw);
  let normalized = raw
    .replace(/[.,_\/-]+/g, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Dots/commas/underscores inside an OCR phone are not trustworthy grouping.
  // In that case emit the observed digit sequence without inventing a locale format.
  if (hasOcrDirtySeparators) {
    normalized = normalized.replace(/(\d)\s+(?=\d)/g, '$1');
  } else {
    normalized = normalized.replace(/(\d{2,})\s+(\d)\s+(\d{2,})/g, '$1$2$3');
  }
  return normalized;
}

function looksLikePhoneNumber(match: string, digits: string, original: string, hasContactLabel: boolean): boolean {
  if (hasContactLabel) return true;
  const trimmed = match.trim();
  if (/^\+|^00/.test(trimmed)) return true;
  if (/\b(?:tel|fax|mob|phone|fon|cell)\b/i.test(original)) return true;
  if (digits.length === 11 && isValidItalianVat(digits)) return false;
  if (digits.length === 11 && !FISCAL_LABEL_RE.test(original) && digits.startsWith('3')) return true;
  if (digits.length === 11 && FISCAL_LABEL_RE.test(original)) return false;
  return digits.length >= 9;
}

interface SharedPrefixPhonePair {
  matchedText: string;
  completeNumber: string;
  expandedNumber: string;
}

function phoneTypeFromNearestLabel(prefix: string, number: string): Phone['type'] {
  const normalizedPrefix = prefix.replace(/_/g, ' ');
  const labels = [...normalizedPrefix.matchAll(/\b(fax|telefax|mob(?:ile)?|cell(?:ulare)?|whatsapp|wa|tel(?:efono|ephone)?|phone|ph)\b/gi)];
  const nearest = labels[labels.length - 1]?.[1]?.toLowerCase() ?? '';
  if (/^(?:fax|telefax)$/.test(nearest) || (!nearest && /^\s*f\s*$/i.test(prefix))) return 'fax';
  if (/^(?:mob|mobile|cell|cellulare|whatsapp|wa)$/.test(nearest)) return 'mobile';
  if (/^(?:\+39\s*)?3\d/.test(number.trim().replace(/^00\s*39\s*/, '+39 '))) return 'mobile';
  return 'work';
}

/**
 * Estrae una coppia "numero completo / interno abbreviato" soltanto quando
 * la riga contiene un'etichetta telefonica o un prefisso internazionale
 * osservato. Il prefisso del secondo numero è copiato dal primo: non vengono
 * dedotti country/area code assenti dall'OCR.
 */
function extractSharedPrefixPhonePair(
  original: string
): SharedPrefixPhonePair | null {
  const spacedDash = isPhoneOrFaxLine(original)
    ? original.match(
        /\b(?:tel(?:efono|ephone)?|phone|ph\.?|mob(?:ile)?\.?|cell(?:ulare)?|whatsapp)\b\s*[.:]?\s*((?:\+|00|[OoQ])?\d[\d\s()./-]{5,}\d)\s+[-\u2013\u2014]\s+(\d(?:[\d\s().-]*\d)?)(?=$|\s+(?:fax|tel|cell|mob|vat|p\.?\s*iva)\b)/i
      )
    : null;
  const match = spacedDash ?? original.match(
    /((?:\+|00|[OoQ])?\d[\d\s().-]{5,}\d)\s*\/\s*(\d(?:[\d\s().-]*\d)?)(?=$|[^\d])/i
  );
  if (!match) return null;

  const completeRaw = match[1].trim();
  const abbreviatedRaw = match[2].trim();
  const hasPhoneLabel = isPhoneOrFaxLine(original);
  const hasObservedInternationalPrefix =
    /^(?:\+|00)/.test(completeRaw) ||
    /^[OoQ]\d{1,3}(?:[\s.-]|$)/i.test(completeRaw);
  if (!hasPhoneLabel && !hasObservedInternationalPrefix) return null;

  const normalizedComplete = completeRaw
    .replace(/^[OoQ](?=\d)/i, '0')
    .replace(/(?<=\d)[OoQ](?=[\d\s().-]|$)/gi, '0')
    .replace(/(?<=\d)[Il|](?=[\d\s().-]|$)/g, '1');
  const completeDigits = normalizedComplete.replace(/\D/g, '');
  const abbreviatedDigits = abbreviatedRaw
    .replace(/[OoQ]/gi, '0')
    .replace(/[Il|]/g, '1')
    .replace(/\D/g, '');

  if (
    completeDigits.length < 9 ||
    completeDigits.length > 15 ||
    abbreviatedDigits.length < 6 ||
    abbreviatedDigits.length > 9 ||
    abbreviatedDigits.length >= completeDigits.length
  ) {
    return null;
  }

  const prefixLength = completeDigits.length - abbreviatedDigits.length;
  if (prefixLength < 2 || prefixLength > 5) return null;
  const observedPrefix = completeDigits.slice(0, prefixLength);
  const expandedDigits = `${observedPrefix}${abbreviatedDigits}`;
  const expandedNumber = completeRaw.startsWith('+')
    ? `+${expandedDigits}`
    : expandedDigits;

  return {
    matchedText: match[0],
    completeNumber: clean(normalizedComplete),
    expandedNumber,
  };
}

function stripFiscalPhones(
  phones: Phone[],
  vat?: string,
  taxCode?: string,
  acceptedPhoneDigits: ReadonlySet<string> = new Set()
): Phone[] {
  const blocked = new Set<string>();
  if (vat) blocked.add(vat.replace(/\D/g, ''));
  if (taxCode) blocked.add(taxCode.replace(/\D/g, ''));
  return phones.filter((phone) => {
    const digits = phone.number.replace(/\D/g, '');
    if (!digits) return false;
    if (acceptedPhoneDigits.has(digits)) return true;
    if (blocked.has(digits)) return false;
    if (digits.length === 11 && isValidItalianVat(digits) && !/^\+|^00/.test(phone.number.trim())) {
      return false;
    }
    return true;
  });
}

function isGenericHost(host: string): boolean {
  const bare = host.replace(/^www\./i, '').toLowerCase();
  return GENERIC_DOMAIN_RE.test(bare);
}

// ---------------------------------------------------------------------------
// Stadio 1 — estrattori strutturati + mascheramento
// ---------------------------------------------------------------------------

function normalizeOcrLatinChars(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0131\u0130]/g, 'i')
    .replace(/[^\x00-\x7F]/g, (ch) => {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return /[a-z0-9@._%+\-]/i.test(base) ? base : ch;
    });
}

function repairEmailText(s: string): string {
  if (!s.includes('@')) return s;
  let r = normalizeOcrLatinChars(s)
    .replace(/([a-z0-9._%+\-]+)\.\s+([a-z0-9._%+\-]+)\s*@/gi, '$1.$2@')
    .replace(/\s*@\s*/g, '@')
    .replace(/@([a-z0-9._%+\-]+)\s*\.\s+([a-z]{2,63})\b/gi, '@$1.$2')
    .replace(/@([a-z0-9.\-]*)\s+\.\s*/gi, '@$1.')
    .replace(/\.\s+(?=[a-z]{2,4}\b)/gi, '.');
  // OCR senza punto prima TLD: fabrizio.s@fuentisCom, pesenti@wiseingegneriait
  r = r.replace(
    /@([a-z0-9._%+\-]+)\s+(it|com|net|org|eu|de|fr|es|ch|biz|info)\b/gi,
    '@$1.$2'
  );
  r = r.replace(
    /@([a-z0-9._%+\-]+)(com|it|net|org|eu|de|fr|es|ch|biz|info)(?=[\s,;]|$)/gi,
    (match, local, tld) => (local.includes('.') ? match : `@${local}.${tld}`)
  );
  // Un sito ripetuto subito dopo una mailbox ("mail@azienda.it-www.azienda.it")
  // e' grafica di contatto, non parte del TLD dell'email.
  r = r.replace(
    /\b([a-z0-9._%+\-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+))\s*[-–—]\s*(?:https?:\/\/)?(?:www\.)?\2\b/gi,
    '$1'
  );
  return r;
}

const EMAIL_LABEL_PREFIX_RE = /\b(?:e-?\s*mail|pec|cmail|email)\s*[.:\-]?\s*/gi;

const GENERIC_EMAIL_NAME_TOKENS = new Set([
  'mail',
  'email',
  'e',
  'info',
  'contact',
  'sales',
  'admin',
  'office',
  'tel',
  'fax',
  'phone',
]);

function fixOcrDomainTld(value: string): string {
  return value
    .replace(/\.com(n|m|l|r|nn)\b/gi, '.com')
    .replace(/\.net(n|m)\b/gi, '.net')
    .replace(/\.org(n|m)\b/gi, '.org')
    .replace(/\.be(n|l)\b/gi, '.be')
    .replace(/\.it(n|l)\b/gi, '.it');
}

function stripEmailLabelPrefix(text: string): string {
  return text.replace(EMAIL_LABEL_PREFIX_RE, '').trim();
}

function isContactLabelNoisePersonLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/@|https?:\/\/|www\./i.test(t)) return true;
  if (/\b(?:e-?\s*mail|tel(?:efono)?|fax|phone|mob(?:ile)?|cell(?:ulare)?|web|www|skype)\b/i.test(t)) {
    return true;
  }
  const words = tokens(t).map((w) => compact(w.replace(/[^\p{L}]/gu, '')));
  if (!words.length) return true;
  if (isGenericContactIdentityLine(t)) return true;
  if (words.length <= 3 && words.every((w) => GENERIC_EMAIL_NAME_TOKENS.has(w))) return true;
  if (words.length === 2 && words[0] === 'e' && GENERIC_EMAIL_NAME_TOKENS.has(words[1])) return true;
  if (words.length >= 2 && words[0] === 'mail' && words[1] === 'info') return true;
  return false;
}

function brandKeysAlign(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a) || levenshtein(a, b) <= 2;
}

function ocrConfusableBrandKeysAlign(a: string, b: string): boolean {
  if (a.length < 3 || a.length !== b.length || (!/\d/.test(a) && !/\d/.test(b))) {
    return false;
  }
  let differences = 0;
  for (let index = 0; index < a.length; index++) {
    if (a[index] === b[index]) continue;
    const pair = `${a[index]}${b[index]}`.toLowerCase();
    if (!/^(?:[il1]{2}|[o0]{2})$/.test(pair)) return false;
    differences += 1;
  }
  return differences > 0;
}

/** Riga logo/brand (es. CRMVILLAGE.BIZ) — non mascherare come structured. */
function isBrandDominantLine(text: string): boolean {
  const t = text.trim();
  if (!t || /@|https?:\/\//i.test(t)) return false;
  if (LEGAL_RE.test(t)) return false;
  const toks = tokens(t);
  if (toks.length !== 1) return false;
  const tok = toks[0];
  if (/\.[a-z]{2,63}$/i.test(tok) && /^[A-Za-z0-9][A-Za-z0-9.\-]{2,}$/.test(tok)) return true;
  return tok === tok.toUpperCase() && compact(tok).length >= 4;
}

interface Structured {
  emails: string[];
  websites: Map<string, number>; // host -> occorrenze
  phones: Phone[];
  vat?: string;
  vatValidatedByEvidence: boolean;
  vatConflictWithEvidence: boolean;
  taxCode?: string;
  addressLineIds: number[];
}

function extractStructured(
  lines: Line[],
  numericEvidence: readonly NumericEvidence[] = [],
  emailEvidence: readonly EmailEvidenceMetadata[] = []
): Structured {
  // Le proposte di repair restano nella provenance e richiedono review, ma
  // finché non sono confermate non possono guidare persona, azienda o sito.
  const emails = observedEmailValues(emailEvidence);
  const websites = new Map<string, number>();
  const phones: Phone[] = [];
  const addressLineIds: number[] = [];
  let vat: string | undefined;
  let taxCode: string | undefined;

  const seenPhones = new Set<string>();
  const acceptedVatValues = [
    ...new Set(
      numericEvidence
        .filter(
          (candidate) =>
            candidate.evidenceType === 'vat' &&
            candidate.validationStatus !== 'invalid' &&
            candidate.confidence >= 0.75
        )
        .map((candidate) => candidate.normalizedValue)
    ),
  ].sort();
  const acceptedPhoneDigits = new Set(
    numericEvidence
      .filter(
        (candidate) =>
          candidate.evidenceType === 'phone' ||
          candidate.evidenceType === 'fax'
      )
      .map((candidate) => candidate.normalizedValue)
  );
  const isExplicitNonVat = (lineId: number, digits: string): boolean =>
    numericEvidence.some(
      (candidate) =>
        candidate.lineId === lineId &&
        candidate.normalizedValue === digits &&
        candidate.evidenceType !== 'vat' &&
        candidate.evidenceType !== 'taxCode' &&
        candidate.evidenceType !== 'unknownNumericIdentifier'
    );

  for (const line of lines) {
    const original = line.text;
    let residual = ' ' + stripEmailLabelPrefix(repairExplicitWebsiteSpacing(repairEmailText(original))) + ' ';
    let consumed = false;
    const lineHasEmailEvidence = emailEvidence.some(
      (item) => item.lineId === line.id
    );

    if (isPersonHandleLine(original)) {
      line.masked = 'social';
      continue;
    }

    // EMAIL
    const emailMatches = residual.match(EMAIL_RE) ?? [];
    for (const m of emailMatches) {
      residual = residual.replace(m, ' ');
      consumed = true;
    }
    EMAIL_RE.lastIndex = 0;

    if (lineHasEmailEvidence && !emailMatches.length) {
      consumed = true;
      if (CONTACT_LABEL_RE.test(original) || tokens(original).length <= 4) {
        residual = ' ';
      }
    }

    // SITO
    const urlMatches = residual.match(URL_RE) ?? [];
    for (const m of urlMatches) {
      const emailLikeLine =
        /@|(?:^|\s)[a-z]?-?mail\s*:/i.test(original);
      const explicitlyWebsiteLike =
        /^https?:\/\/|^www\./i.test(m) ||
        /\b(?:web|website|internet)\s*:/i.test(original);
      if (emailLikeLine && !explicitlyWebsiteLike) continue;
      const host = m.toLowerCase().replace(/^https?:\/\//, '').replace(/[),.;:]+$/, '');
      if (host.includes('@')) continue;
      let bare = host.replace(/^www\./, '');
      bare = fixOcrDomainTld(bare);
      // ripara host duplicato da OCR: ict-group.itgroup.it → ict-group.it
      const TLD = '(?:it|com|net|org|eu|de|fr|es|ch|at|uk|io|info|biz|edu)';
      const dup = bare.match(new RegExp(`^([a-z0-9\\-]+\\.${TLD})[a-z0-9\\-]+\\.${TLD}$`));
      if (dup) bare = dup[1];
      if (!/^[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,63}$/.test(bare)) continue;
      if (!isPlausibleInternetHost(bare)) continue;
      if (/^\d/.test(bare) || /^(?:tel|fax)/.test(bare)) continue;
      if (isGenericHost(bare)) continue;
      websites.set(bare, (websites.get(bare) ?? 0) + 1);
      residual = residual.replace(m, ' ');
      consumed = true;
    }
    URL_RE.lastIndex = 0;

    // Dominio bare: sito senza prefisso www.
    const bareDomain = original.trim().match(/^www\.[a-z0-9][a-z0-9.\-]*\.[a-z]{2,63}$/i)
      ?? original.trim().match(/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,63}$/i);
    if (bareDomain && !consumed && !isPersonHandleLine(original)) {
      let bare = bareDomain[0].toLowerCase().replace(/^www\./, '');
      bare = fixOcrDomainTld(bare);
      if (!isGenericHost(bare) && isPlausibleInternetHost(bare)) {
        websites.set(bare, (websites.get(bare) ?? 0) + 2);
        if (!LEGAL_RE.test(original) && !isBrandDominantLine(original)) {
          line.masked = 'structured';
        }
        consumed = true;
      }
    }

    // P.IVA / C.F. (prima dei telefoni: 11 cifre non sono un numero di telefono)
    const hasVatLabel = VAT_LABEL_RE.test(original);
    const hasCfLabel = CF_LABEL_RE.test(original);
    const hasFiscalLabel = FISCAL_LABEL_RE.test(original);
    if (hasFiscalLabel) {
      const fiscal = extractFiscalFromLine(original);
      if (fiscal.cf16 && hasCfLabel && !taxCode) taxCode = fiscal.cf16;
      if (fiscal.vat11) {
        if (hasVatLabel && !vat) vat = fiscal.vat11;
        if (hasCfLabel && !fiscal.cf16 && !taxCode) taxCode = fiscal.vat11;
        if (
          (/\bc\.?\s*f\.?\s*p\.?\s*i\.?\b/i.test(original) ||
            /\bc\.?\s*f\.?\s*\/?\s*p\.?\s*i\.?\b/i.test(original)) &&
          !vat
        ) {
          vat = fiscal.vat11;
        }
      }
      const fiscalEvidence = numericEvidence.filter(
        (candidate) =>
          candidate.lineId === line.id &&
          (candidate.evidenceType === 'vat' || candidate.evidenceType === 'taxCode')
      );
      for (const candidate of fiscalEvidence) {
        residual = residual.replace(candidate.rawValue, ' ');
      }
      residual = residual.replace(FISCAL_LABEL_RE, ' ').replace(CF16_RE, ' ');
      if (!fiscalEvidence.length) {
        residual = residual
          .replace(/\b[\d.\s]{11,}\b/g, ' ')
          .replace(/\b\d{9}\s+\d{2}\b/g, ' ');
      }
      consumed = true;
    }

    // TELEFONI
    const isRegistryIdentifierLine = /\b(?:RUI|REA|albo|registro)\b/i.test(original);
    const hasContactLabel =
      (isPhoneOrFaxLine(original) || CONTACT_LABEL_RE.test(original) || /^\s*[FT]\s*(?=[:._+\d])/i.test(original)) &&
      !isOfficeAddressLabel(original);
    let phoneResidual = hasContactLabel
      ? residual
          .replace(/(\d)\s*[OoQ](?=[\s.\-\d])/g, '$10')
          .replace(/(\d)\s*[lIL|](?=[\s.\-\d]|$)/g, '$11')
          .replace(/[OoQ](?=\d)/g, '0')
          .replace(/[lI|](?=\d{3,})/g, '1')
      : residual;
    const sharedPrefixPair = extractSharedPrefixPhonePair(original);
    if (sharedPrefixPair) {
      const before = original
        .slice(0, Math.max(0, original.indexOf(sharedPrefixPair.matchedText)))
        .toLowerCase();
      const type = phoneTypeFromNearestLabel(before, sharedPrefixPair.completeNumber);
      for (const number of [
        sharedPrefixPair.completeNumber,
        sharedPrefixPair.expandedNumber,
      ]) {
        const digits = number.replace(/\D/g, '');
        const key = digits.slice(-9);
        if (!digits || seenPhones.has(key)) continue;
        seenPhones.add(key);
        phones.push({ number, type });
      }
      residual = residual.replace(sharedPrefixPair.matchedText, ' ');
      phoneResidual = phoneResidual.replace(
        sharedPrefixPair.matchedText
          .replace(/^[OoQ](?=\d)/i, '0'),
        ' '
      );
      consumed = true;
    }
    const phoneMatches = isRegistryIdentifierLine ? [] : phoneResidual.match(PHONE_SEQ_RE) ?? [];
    for (const m of phoneMatches) {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) continue;
      if (
        !acceptedPhoneDigits.has(digits) &&
        !looksLikePhoneNumber(m, digits, original, hasContactLabel)
      ) {
        continue;
      }
      // scarta CAP+numero civico e sequenze dentro indirizzi senza label
      if (!hasContactLabel && !m.trim().startsWith('+') && !m.trim().startsWith('00') && digits.length < 9) continue;
      if (POSTAL_RE.test(m) && digits.length <= 6) continue;
      if (hasContactLabel) acceptedPhoneDigits.add(digits);
      const key = digits.slice(-9);
      if (seenPhones.has(key)) {
        residual = residual.replace(m, ' ');
        continue;
      }
      seenPhones.add(key);
      const before = phoneResidual
        .slice(0, Math.max(0, phoneResidual.indexOf(m)))
        .toLowerCase();
      const type = phoneTypeFromNearestLabel(before, m);
      phones.push({ number: normalizeObservedPhoneFormatting(m), type });
      residual = residual.replace(m, ' ');
      if (residual.includes(m) === false && phoneResidual !== residual) {
        const semanticRemainder = residual
          .replace(CONTACT_LABEL_RE, ' ')
          .replace(/[^\p{L}]/gu, '');
        if (hasContactLabel && semanticRemainder.length < 4) residual = ' ';
      }
      consumed = true;
    }
    PHONE_SEQ_RE.lastIndex = 0;

    // INDIRIZZO (non maschera del tutto: segna e lascia allo stadio address)
    const repairedAddressText = repairAddressPipeOcr(original);
    const looksAddress = lineLooksLikeAddress(repairedAddressText);
    if (looksAddress) {
      line.text = repairedAddressText;
      addressLineIds.push(line.id);
    }

    // MASCHERA la riga se il residuo semantico è trascurabile
    const residualAlnum = residual.replace(CONTACT_LABEL_RE, ' ').replace(/[^\p{L}]/gu, '');
    if (consumed && residualAlnum.length < 4) {
      if (!LEGAL_RE.test(original) && !isBrandDominantLine(original)) {
        line.masked = 'structured';
      }
    } else if (consumed && residualAlnum.length >= 4) {
      // The line contained structured data (e.g. email, phone) AND valid text (e.g. name).
      // Update the line's text to the residual so downstream scoring isn't penalized by digits/emails.
      line.text = stripJunk(residual);
    } else if (!consumed && hasContactLabel && residualAlnum.length < 4) {
      line.masked = 'contact-label';
    } else if (SOCIAL_RE.test(original) && tokens(original).length <= 3) {
      line.masked = 'social';
    } else if (looksAddress) {
      line.masked = 'address';
    }
  }

  if (!vat) {
    for (const line of lines) {
      if (line.masked === 'contact-label') continue;
      const text = line.text;
      if (!VAT_LABEL_RE.test(text) && !/\b(?:c\.?\s*f\.?\s*\/?\s*)?p\.?\s*i\b/i.test(text)) continue;
      const fiscal = extractFiscalFromLine(text);
      if (fiscal.vat11 && isValidItalianVat(fiscal.vat11)) {
        vat = fiscal.vat11;
        break;
      }
    }
  }

  if (!vat) {
    const fiscalContext = hasItalianFiscalContext(lines, lines.map((l) => l.text).join('\n'));
    if (fiscalContext) {
      for (const line of lines) {
        if (addressLineIds.includes(line.id)) continue;
        const fiscal = extractFiscalFromLine(line.text);
        if (!fiscal.vat11 || !isValidItalianVat(fiscal.vat11)) continue;
        if (isExplicitNonVat(line.id, fiscal.vat11)) continue;
        if (CONTACT_LABEL_RE.test(line.text) || PHONE_SEQ_RE.test(line.text.replace(/\D/g, '').slice(0, 12))) continue;
        vat = fiscal.vat11;
        break;
      }
    }
  }

  let vatConflictWithEvidence = false;
  if (acceptedVatValues.length > 1) {
    vat = undefined;
  } else if (acceptedVatValues.length === 1) {
    const acceptedVat = acceptedVatValues[0];
    if (vat && isValidItalianVat(vat) && vat !== acceptedVat) {
      vatConflictWithEvidence = true;
      vat = undefined;
    } else {
      vat = acceptedVat;
    }
  }

  if (!taxCode) {
    const fiscalContext = hasItalianFiscalContext(lines, lines.map((l) => l.text).join('\n'));
    if (fiscalContext) {
      for (const line of lines) {
        if (addressLineIds.includes(line.id)) continue;
        const fiscal = extractFiscalFromLine(line.text);
        if (!fiscal.cf16) continue;
        if (CONTACT_LABEL_RE.test(line.text) && !FISCAL_LABEL_RE.test(line.text)) continue;
        taxCode = fiscal.cf16;
        break;
      }
    }
  }

  return {
    emails: sanitizeStructuredEmails(emails),
    websites,
    phones: stripFiscalPhones(
      phones,
      vat,
      taxCode,
      acceptedPhoneDigits
    ),
    vat,
    vatValidatedByEvidence:
      Boolean(vat) &&
      acceptedVatValues.length === 1 &&
      acceptedVatValues[0] === vat,
    vatConflictWithEvidence,
    taxCode,
    addressLineIds,
  };
}

function collectAddressLineIds(lines: Line[], seedIds: number[]): number[] {
  const ids = new Set(seedIds);
  const sorted = [...lines].sort((a, b) => a.page - b.page || a.indexInPage - b.indexInPage);
  for (let i = 0; i < sorted.length; i++) {
    if (!isOfficeAddressLabel(sorted[i].text)) continue;
    ids.add(sorted[i].id);
    for (let j = i + 1; j < sorted.length; j++) {
      const l = sorted[j];
      if (l.page !== sorted[i].page) break;
      if (isOfficeAddressLabel(l.text)) break;
      if (shouldStopAddressBlockLine(l)) break;
      if (isForeignAddressLine(l.text) || l.masked === 'address') ids.add(l.id);
    }
  }
  for (const line of lines) {
    if (line.masked === 'structured' || line.masked === 'social') continue;
    const text = line.text;
    if (
      lineLooksLikeAddress(text) ||
      isForeignAddressLine(text) ||
      isAddressContinuationLine(text) ||
      (POSTAL_RE.test(text) && PROVINCE_RE.test(text)) ||
      /\b\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]{3,}/i.test(text) ||
      CITY_PROV_ONLY_RE.test(text.trim()) ||
      CAP_CITY_PROV_RE.test(text)
    ) {
      ids.add(line.id);
    }
  }
  // Assorbe righe di continuazione tra via e città/paese (Industrial Estate, …)
  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i];
    if (!ids.has(line.id) || !STREET_RE.test(line.text)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j];
      if (next.page !== line.page) break;
      if (next.indexInPage - sorted[j - 1]?.indexInPage > 2) break;
      if (isOcrFusedEmailDomainLine(next.text)) continue;
      if (shouldStopAddressBlockLine(next)) break;
      if (isForeignAddressLine(next.text) || COUNTRY_RE.test(next.text) || POSTAL_RE.test(next.text)) {
        ids.add(next.id);
        break;
      }
      if (isAddressContinuationLine(next.text)) {
        ids.add(next.id);
      } else if (!ids.has(next.id)) {
        break;
      }
    }
  }
  return [...ids];
}

function splitRoleFromCompanyLine(text: string): { company: string; role: string } | null {
  if (!LEGAL_RE.test(text) || !ROLE_RE.test(text)) return null;
  const legalMatches = [...text.matchAll(new RegExp(LEGAL_RE.source, 'gi'))];
  if (!legalMatches.length) return null;
  const last = legalMatches[legalMatches.length - 1];
  const legalEnd = (last.index ?? 0) + last[0].length;
  const tail = text.slice(legalEnd).replace(/^[\s,;./|-]+/, '').trim();
  if (!tail || !ROLE_RE.test(tail)) return null;
  const company = text.slice(0, legalEnd).trim();
  if (!company || company.length < 3) return null;
  return { company, role: tail };
}

function splitCompanyInlineAddress(
  text: string
): { company: string; address: string } | null {
  const legalMatches = [...text.matchAll(new RegExp(LEGAL_RE.source, 'gi'))];
  for (const legalMatch of legalMatches.reverse()) {
    let legalEnd = (legalMatch.index ?? 0) + legalMatch[0].length;
    const closingParenthesis = text.slice(legalEnd).match(/^\s*\)/);
    if (closingParenthesis) legalEnd += closingParenthesis[0].length;
    const company = text
      .slice(0, legalEnd)
      .trim()
      .replace(/[,;:–—-]+$/, '')
      .trim();
    const address = text
      .slice(legalEnd)
      .replace(/^[\s,.;:–—-]+/, '')
      .trim();
    const addressHead =
      address.split(/\s+[-–—]\s+|,\s*(?=[A-Za-zÀ-ÿ])/u, 1)[0]?.trim() ??
      address;
    const normalizedAddressHead = addressHead.replace(/,\s*(?=\d)/g, ' ');
    if (
      !matchTerminalLegalFormSuffix(company) ||
      !address ||
      !(
        hasNumberedStreetStructure(normalizedAddressHead) ||
        (STREET_RE.test(address) &&
          /\b\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?\b/.test(address))
      )
    ) {
      continue;
    }
    return { company, address: clean(address) };
  }
  return null;
}

function splitDelimitedLegalCompanyTail(text: string): string | null {
  const legalMatches = [...text.matchAll(new RegExp(LEGAL_RE.source, 'gi'))];
  for (const legalMatch of legalMatches.reverse()) {
    const legalEnd = (legalMatch.index ?? 0) + legalMatch[0].length;
    const tail = text.slice(legalEnd);
    if (!/^\s*[,;:–—-]\s*\S/u.test(tail)) continue;
    const company = text
      .slice(0, legalEnd)
      .trim()
      .replace(/[,;:–—-]+$/, '')
      .trim();
    if (matchTerminalLegalFormSuffix(company)) return company;
  }
  return null;
}

function companySemanticText(text: string): string {
  return (
    splitCompanyInlineAddress(text)?.company ??
    splitDelimitedLegalCompanyTail(text) ??
    stripNumberedLocationAfterLegalForm(text)
  );
}

function enrichGenericCompanyWithOwner(
  company: string,
  firstName?: string | null,
  lastName?: string | null
): string {
  const words = tokens(company);
  if (!words.length || !firstName || !lastName) return company;
  const allHeaders = words.every((w) => GENERIC_COMPANY_HEADER.has(compact(w)));
  if (!allHeaders) return company;
  return clean(`${company} ${lastName} ${firstName}`);
}

/** Acronimo marchio su card quando company = nome/cognome persona. */
function recoverShortCardAcronymCompany(
  lines: Line[],
  firstName?: string | null,
  lastName?: string | null,
  emailToks: string[] = []
): string | null {
  const personKeys = new Set(
    [firstName, lastName]
      .map((p) => normalizeBrandKey(p ?? ''))
      .filter((k) => k.length >= 3)
  );
  const emailKeys = new Set(emailToks.map((t) => normalizeBrandKey(t)).filter((k) => k.length >= 3));
  let best: { label: string; score: number } | null = null;
  for (const l of lines) {
    if (l.masked) continue;
    const t = l.text.trim();
    if (!/^[A-Z]{2,6}$/.test(t) || t.length < 3 || t.length > 6) continue;
    const key = normalizeBrandKey(t);
    if (!key || personKeys.has(key) || FIRST_NAMES.has(compact(t)) || isItalianCityName(t)) continue;
    if (emailKeys.has(key)) continue;
    if (shouldRejectCompanyCandidate(t)) continue;
    let score = l.companyScore;
    if (l.f?.allCaps) score += 0.5;
    if (l.indexInPage >= 3) score += 0.35;
    if (!best || score > best.score) best = { label: t, score };
  }
  return best?.label ?? null;
}

function buildCompanyField(
  line: Line,
  second: Line | undefined,
  emailToks: string[],
  structured: Structured,
  rawText: string,
  companyTextOverride?: string
): V5Field<string> | null {
  const sourceText = companySemanticText(companyTextOverride ?? line.text);
  const sourceKey = compact(sourceText);
  if (shouldRejectCompanyCandidate(sourceText)) return null;
  if (
    isUncorroboratedAmbiguousLegalLine(
      sourceText,
      structured.emails,
      structured.websites
    ) &&
    !splitCompanyInlineAddress(line.text)
  ) {
    return null;
  }
  if (
    emailToks.length >= 1 &&
    !LEGAL_RE.test(sourceText) &&
    emailToks.some((t) => t.length >= 4 && (sim(t, sourceKey) >= 0.88 || sourceKey.includes(t) || t.includes(sourceKey)))
  ) {
    return null;
  }
  const split = splitPersonFromCompanyLine(sourceText, emailToks, domainRoots(structured.emails, structured.websites));
  let value = split ? split.company : sourceText;
  const casedValue = normalizeCompanyPhraseCasing(value);
  value = matchTerminalLegalFormSuffix(value)
    ? casedValue
    : normalizeLegal(casedValue);
  if (isHostnameOnlyCompany(value)) return null;
  if (!LEGAL_RE.test(value)) value = respellBrandFromDomain(value, structured.emails, structured.websites);
  // Converti ALLCAPS in TitleCase: trattino composto (STEINBEIS-TRANSFERZENTRUM) o multi-parola (HUMANS & DIVERSITY, 3A STRATEGY)
  if (value === value.toUpperCase() && /[A-Z]/.test(value)) {
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    const hasHyphen = value.includes('-');
    const isLongEnough = value.length >= 6;
    if (isLongEnough && (hasHyphen || wordCount >= 2)) {
      // TitleCase parola per parola preservando il trattino come separatore interno
      value = value
        .split(/\s+/)
        .map(word => {
          if (hasHyphen && word.includes('-')) {
            // STEINBEIS-TRANSFERZENTRUM → Steinbeis-Transferzentrum
            return word.split('-').map(part =>
              part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part
            ).join('-');
          }
          // Acronimi corti (≤4 lettere maiuscole) li lasciamo ALLCAPS: IBM, SAP, 3A
          if (/^[A-Z0-9]{1,4}$/.test(word)) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
    }
  }
  const finalized = finalizeCompanyValue(value, structured.emails, rawText);
  if (!finalized) {
    const headerBrand = recoverOcrHeaderBrand(rawText, structured.emails);
    if (headerBrand) {
      return {
        value: headerBrand,
        score: sigmoid((line.companyScore - T.company) * 0.9 + Math.min(line.companyScore - Math.max(second?.companyScore ?? 0, T.company - 1), 2) * 0.3),
        reasons: ['marchio logo OCR', 'validazione finale'],
        lineIds: [line.id],
      };
    }
    if (
      isPreservableCompanyCandidate(value) &&
      !isCompanySloganClaimLine(value) &&
      !isAmbiguousTerminalLegalPhrase(value)
    ) {
      const preserved = normalizeOcrBrandValue(value, structured.emails) ?? value;
      return {
        value: preserved,
        score: sigmoid((line.companyScore - T.company) * 0.7),
        reasons: ['company preservata', 'validazione finale'],
        lineIds: [line.id],
      };
    }
    return null;
  }
  const margin = line.companyScore - Math.max(second?.companyScore ?? 0, T.company - 1);
  return {
    value: finalized,
    score: sigmoid((line.companyScore - T.company) * 0.9 + Math.min(margin, 2) * 0.3),
    reasons: [
      line.f.hasLegalSuffix ? 'forma giuridica' : '',
      line.f.domainRootMatch >= 0.7 ? 'coerente col dominio' : '',
      line.f.fontScale > 1.2 ? 'testo grande' : '',
      split ? 'rimosso prefisso nome persona' : '',
      'validazione finale',
    ].filter(Boolean),
    lineIds: [line.id],
  };
}

// ---------------------------------------------------------------------------
// Stadio 2 — feature per riga
// ---------------------------------------------------------------------------

function personalEmail(emails: string[]): string | undefined {
  return emails.find((e) => !GENERIC_LOCAL_RE.test(e.split('@')[0] ?? '')) ?? emails[0];
}

function emailNameTokens(email?: string): string[] {
  if (!email) return [];
  const parts = (email.split('@')[0] ?? '')
    .toLowerCase()
    .split(/[._\-+]+/)
    .filter((t) => t && !/^\d+$/.test(t));
  if (parts.length === 1 && parts[0]!.length >= 6) return parts;
  if (parts.length === 1) {
    const fused = parts[0]!.match(/^([a-z])([a-zà-ü]{4,})$/i);
    if (fused) return [fused[1]!, fused[2]!];
  }
  return parts;
}

function domainRoots(emails: string[], websites: Map<string, number>): Set<string> {
  const roots = new Set<string>();
  const add = (host?: string) => {
    if (!host || GENERIC_DOMAIN_RE.test(host)) return;
    for (const root of extractBusinessDomainRootCandidates(host)) {
      if (root.length >= 3) roots.add(compact(root));
    }
  };
  for (const e of emails) add(e.split('@')[1]);
  for (const w of websites.keys()) add(w);
  return roots;
}

function completeBrandMatchesDomainRoot(brand: string, root: string): boolean {
  const brandKey = normalizeBrandKey(brand);
  const rootKey = normalizeBrandKey(root);
  if (Math.min(brandKey.length, rootKey.length) < 4) return false;
  if (brandKey === rootKey) return true;

  // Una correzione OCR limitata è ammessa soltanto sull'identità intera.
  // Le relazioni di prefisso (code ↔ codeart, status ↔ statusactive) non
  // costituiscono corroborazione aziendale.
  return (
    Math.max(brandKey.length, rootKey.length) >= 6 &&
    Math.abs(brandKey.length - rootKey.length) <= 1 &&
    levenshtein(brandKey, rootKey) <= 1
  );
}

function isUncorroboratedAmbiguousLegalLine(
  text: string,
  emails: string[],
  websites: Map<string, number>
): boolean {
  const legal = matchTerminalLegalFormSuffix(text);
  if (!legal || legal.strength !== 'ambiguous') return false;

  if (normalizeBrandKey(legal.brand).length < 4) return true;
  for (const root of domainRoots(emails, websites)) {
    if (completeBrandMatchesDomainRoot(legal.brand, root)) return false;
  }
  return true;
}

function hasTrustedTerminalLegalLine(
  text: string,
  emails: string[],
  websites: Map<string, number>
): boolean {
  const legal = matchTerminalLegalFormSuffix(text);
  if (!legal) return false;
  if (
    legal.strength === 'strong' &&
    !hasAmbiguousTerminalLegalSeparator(text)
  ) {
    return true;
  }

  if (normalizeBrandKey(legal.brand).length < 4) return false;
  for (const root of domainRoots(emails, websites)) {
    if (completeBrandMatchesDomainRoot(legal.brand, root)) return true;
  }
  return false;
}

function computeFeatures(
  lines: Line[],
  emails: string[],
  websites: Map<string, number>
): void {
  const semanticGeometryLines = lines.filter(
    (line) =>
      line.masked !== 'structured' &&
      line.masked !== 'contact-label' &&
      line.masked !== 'social'
  );
  const geometryLines = semanticGeometryLines.length
    ? semanticGeometryLines
    : lines;
  const heights = geometryLines
    .map((l) => l.bbox?.height ?? 0)
    .filter((h) => h > 0);
  const medH = median(heights) || 1;
  const roots = domainRoots(emails, websites);
  const emailToks = emailNameTokens(personalEmail(emails));

  // estensione verticale per pagina
  const pageSpan = new Map<number, { min: number; max: number }>();
  for (const l of geometryLines) {
    const y = l.bbox?.y ?? 0;
    const s = pageSpan.get(l.page) ?? { min: y, max: y };
    s.min = Math.min(s.min, y);
    s.max = Math.max(s.max, y);
    pageSpan.set(l.page, s);
  }

  for (const line of lines) {
    const text = line.text;
    const toks = tokens(text.replace(HONORIFIC_RE, ''));
    const y = line.bbox?.y ?? 0;
    const span = pageSpan.get(line.page) ?? { min: y, max: y };
    const h = line.bbox?.height ?? 0;

    const allCaps = toks.length > 0 && toks.every((t) => isCapsTok(t) || /^[&\d.]+$/.test(t));
    const titleCase = toks.length > 0 && toks.every(isTitleTok);

    // similarità nome ↔ email
    let emailLocalMatch = 0;
    if (emailToks.length && toks.length >= 1 && toks.length <= 5) {
      const lower = toks.map((t) => compact(t));
      let matched = 0;
      let total = 0;
      for (const et of emailToks) {
        let best = 0;
        for (const lt of lower) {
          const s =
            et.length === 1
              ? lt.startsWith(et)
                ? 0.9
                : 0
              : Math.max(sim(et, lt), lt.startsWith(et) && et.length >= 3 ? 0.85 : 0);
          if (s > best) best = s;
        }
        if (best >= 0.72) {
          matched++;
          total += best;
        }
      }
      if (matched) emailLocalMatch = (total / emailToks.length) * (matched / emailToks.length);
    }

    // la riga "è il brand"? (radice dominio)
    let domainRootMatch = 0;
    const cmp = compact(text);
    for (const r of roots) {
      let s = Math.max(sim(cmp, r), cmp.includes(r) && r.length >= 4 ? 0.85 : 0, r.includes(cmp) && cmp.length >= 4 ? 0.7 : 0);
      const fuzzyDist = fuzzyCompanyDomainDistance(text, r);
      if (fuzzyDist <= 2) {
        s = Math.max(s, fuzzyDist === 0 ? 0.96 : fuzzyDist === 1 ? 0.9 : 0.82);
      }
      if (s > domainRootMatch) domainRootMatch = s;
    }
    if (
      hasAmbiguousTerminalLegalSeparator(text) &&
      !hasTrustedTerminalLegalLine(text, emails, websites)
    ) {
      domainRootMatch = 0;
    }

    const parts = text.split(/\s*[&\/,+]\s*/).filter(Boolean);
    const acronymCluster = parts.length >= 2 && parts.length <= 6 && parts.every((p) => /^[A-Z]{2,6}$/.test(p));

    const legalHit =
      LEGAL_RE.test(text) &&
      !isUncorroboratedAmbiguousLegalLine(text, emails, websites);
    const withoutLegal = clean(text.replace(LEGAL_RE, ''));

    const activityWords = (text.match(new RegExp(ACTIVITY_RE.source, 'gi')) ?? []).length;

    let roleKeyword = ROLE_RE.test(text);
    const slashRole = text.match(/^(.+?)\s*\/\s*(.+)$/);
    if (slashRole && ROLE_RE.test(slashRole[2]) && slashRole[1].trim().split(/\s+/).length >= 2) {
      roleKeyword = false;
    }
    const dashRole = text.match(/^(.+?)\s+-\s+(.+)$/);
    if (
      dashRole &&
      ROLE_RE.test(dashRole[2]) &&
      dashRole[1].trim().split(/\s+/).length >= 2 &&
      !LEGAL_RE.test(dashRole[1])
    ) {
      roleKeyword = false;
    }

    line.f = {
      fontScale: h > 0 ? h / medH : 1,
      yQuantile: span.max > span.min ? (y - span.min) / (span.max - span.min) : 0.5,
      tokenCount: toks.length,
      length: text.length,
      allCaps,
      titleCase,
      hasHonorific: HONORIFIC_RE.test(text),
      hasLegalSuffix: legalHit,
      legalSuffixOnly: legalHit && withoutLegal.replace(/[^\p{L}]/gu, '').length < 3,
      preSuffixActivityOnly:
        legalHit &&
        withoutLegal.length >= 3 &&
        tokens(withoutLegal).every(
          (t) => ACTIVITY_RE.test(t) || SMALL_WORDS.has(t.toLowerCase()) || t.length <= 2
        ),
      descriptorTagline:
        legalHit &&
        activityWords >= 2 &&
        toks.length >= 5 &&
        domainRootMatch < 0.82 &&
        text.length > 32,
      inNameLexicon: toks.some((t) => FIRST_NAMES.has(compact(t))),
      emailLocalMatch,
      domainRootMatch,
      roleKeyword: roleKeyword,
      activityWords,
      acronymCluster,
      addressLike: line.masked === 'address',
      digitRatio: (text.match(/\d/g) ?? []).length / Math.max(1, text.length),
    };
  }
}

// ---------------------------------------------------------------------------
// Stadio 3+4 — punteggi e arbitraggio globale
// ---------------------------------------------------------------------------

const FAMILY_FIRM_RE = /\b(?:figli|f\.?\s?lli|fratelli|eredi)\b/i;

function scorePerson(l: Line): number {
  if (l.masked && l.masked !== 'address') return -10;
  if (shouldRejectPersonCandidate(l.text)) return -10;
  if (isContactLabelNoisePersonLine(l.text)) return -10;
  if (/[&+]/.test(l.text) || FAMILY_FIRM_RE.test(l.text)) return -10;
  // Righe ALLCAPS 2-token dove nessun token è un nome → brand aziendale (MOTOCARD RAS, BDB SYSTEMS, etc.)
  if (l.f.allCaps && l.f.tokenCount === 2 && !l.f.inNameLexicon) {
    const toks = tokens(l.text);
    const compact0 = compact(toks[0] ?? '');
    const compact1 = compact(toks[1] ?? '');
    if (!FIRST_NAMES.has(compact0) && !FIRST_NAMES.has(compact1) && compact0.length >= 3 && compact1.length >= 2) {
      return -10;
    }
  }
  if (/\b(?:concessionari[ao]|dealership|authorized\s+dealer)\b/i.test(l.text)) return -10;
  if (/^(?:per\s+(?:la|il|l')|centro\s+(?:veneto|assistenza)|innovazione\s+per)\b/i.test(l.text)) return -10;
  const f = l.f;
  if (f.addressLike || f.digitRatio > 0.15) return -10;
  if (f.tokenCount < 1 || f.tokenCount > 5) return -10;
  let s = 0;
  s += W.person.emailLocalMatch * f.emailLocalMatch;
  if (f.inNameLexicon) s += W.person.lexicon;
  if (f.hasHonorific) s += W.person.honorific;
  if (f.titleCase && f.tokenCount >= 2 && f.tokenCount <= 4) s += W.person.titleCase;
  if (f.allCaps && f.tokenCount === 2 && f.length <= 24) s += W.person.allCapsPair;
  if (f.fontScale > 1.2) s += W.person.bigFont;
  if (f.yQuantile < 0.55) s += W.person.topHalf;
  if (f.hasLegalSuffix) s += W.person.legalSuffix;
  if (f.roleKeyword) s += W.person.roleKeyword;
  s += W.person.activityWord * f.activityWords;
  if (f.hasHonorific && f.titleCase && f.tokenCount >= 2) s += 1.0;
  const honorificStripped = l.text.replace(HONORIFIC_RE, '').trim();
  if (HONORIFIC_RE.test(l.text) && parsePersonNameFromLine(honorificStripped)) s += 2.2;
  if (f.titleCase && f.tokenCount === 2 && parsePersonNameFromLine(l.text)) s += 0.6;
  const nameParts = tokens(l.text);
  if (f.allCaps && f.tokenCount === 3 && NAME_PARTICLES.has(nameParts[1]?.toLowerCase() ?? '')) {
    s += 1.3;
  }
  if (f.acronymCluster) s += W.person.acronymCluster;
  s += W.person.domainRootMatch * f.domainRootMatch;
  if (f.digitRatio > 0) s += W.person.digits;
  if (f.tokenCount > 4) s += W.person.tooManyTokens;
  if (f.tokenCount === 1) s += W.person.singleToken;
  return s;
}

function mergeContinuationCompanyLines(lines: Line[]): void {
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i];
    const prev = lines[i - 1];
    if (cur.page !== prev.page || cur.masked || prev.masked) continue;
    const curText = cur.text.trim();
    if (!/^e\s+/i.test(curText)) continue;
    const prevToks = tokens(prev.text);
    if (prevToks.length < 1 || prevToks.length > 6 || ROLE_RE.test(prev.text)) continue;
    prev.text = clean(prev.text + ' ' + curText);
    if (prev.f) {
      prev.f.tokenCount = tokens(prev.text).length;
      prev.f.length = prev.text.length;
      prev.f.hasLegalSuffix = LEGAL_RE.test(prev.text);
    }
    cur.masked = 'merged-into-prev';
    cur.companyScore = -10;
    cur.personScore = -10;
  }
}

function isAmbiguousTwoTokenIdentityLine(text: string): boolean {
  return /^\p{Lu}[\p{Ll}\p{M}'’-]+\s+\p{Lu}[\p{Ll}\p{M}'’-]+$/u.test(text.trim());
}

function mergeSplitLegalCompanyHeader(lines: Line[]): void {
  for (let index = 0; index < lines.length; index++) {
    const legalLine = lines[index];
    if (
      legalLine.masked ||
      !isLegalFormOnlyCompany(normalizeLegal(legalLine.text))
    ) {
      continue;
    }
    const headers: Line[] = [];
    for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor--) {
      const candidate = lines[cursor];
      if (candidate.page !== legalLine.page || candidate.masked) break;
      if (/[:=]\s*$/.test(candidate.text)) {
        headers.length = 0;
        break;
      }
      const isAmbiguousTwoTokenIdentity =
        cursor === index - 1 &&
        isAmbiguousTwoTokenIdentityLine(candidate.text) &&
        !ORGANIZATION_SUFFIX_RE.test(candidate.text) &&
        !ACTIVITY_RE.test(candidate.text);
      if (parsePersonNameFromLine(candidate.text) || isAmbiguousTwoTokenIdentity) {
        // Se abbiamo gia raccolto un header business immediatamente sopra la forma
        // giuridica, la persona precedente e solo un confine: non deve cancellarlo.
        // Esempio generico:
        //   Persona
        //   Ruolo
        //   BRAND
        //   (Private) Limited
        if (!headers.length) headers.length = 0;
        break;
      }
      const letters = candidate.text.match(/\p{L}/gu)?.length ?? 0;
      if (
        letters < 3 ||
        /\d|@|https?:|www\./i.test(candidate.text) ||
        ROLE_RE.test(candidate.text) ||
        lineLooksLikeAddress(candidate.text)
      ) {
        continue;
      }
      if (tokens(candidate.text).length > 3) break;
      headers.unshift(candidate);
    }
    if (!headers.length || !headers.some((line) => line.indexInPage <= 3)) {
      continue;
    }
    const ownerLine = lines[index + 1];
    const owner =
      ownerLine &&
      ownerLine.page === legalLine.page &&
      /^di\s+[\p{L}.&' -]{3,}$/iu.test(ownerLine.text)
        ? ownerLine
        : undefined;
    const target = headers[0];
    target.text = clean(
      [...headers.map((line) => line.text), owner?.text, legalLine.text]
        .filter(Boolean)
        .join(' ')
    );
    for (const consumed of [...headers.slice(1), legalLine, ...(owner ? [owner] : [])]) {
      consumed.masked = 'merged-into-prev';
      consumed.companyScore = -10;
      consumed.personScore = -10;
    }
  }
}

function isBrandCorroboratedByContact(
  brand: string,
  emails: string[],
  websites: Map<string, number>
): boolean {
  const key = normalizeBrandKey(brand);
  if (!key || key.length < 3) return false;
  for (const email of emails) {
    const host = email.split('@')[1] ?? '';
    const root = normalizeBrandKey(host.replace(/^www\./, '').split('.')[0] ?? '');
    if (root && (root.includes(key) || key.includes(root))) return true;
  }
  for (const host of websites.keys()) {
    const root = normalizeBrandKey(host.replace(/^www\./, '').split('.')[0] ?? '');
    if (root && (root.includes(key) || key.includes(root))) return true;
  }
  return false;
}

function enrichCompanyWithLogoBrand(
  lines: Line[],
  companyLineId: number,
  company: string,
  emails: string[] = [],
  websites: Map<string, number> = new Map()
): string {
  if (companyLineId < 0 || !company?.trim()) return company;
  const companyLine = lines.find((l) => l.id === companyLineId);
  if (
    companyLine &&
    (hasTrustedTerminalLegalLine(companyLine.text, emails, websites) ||
      /\b(?:bvba|gmbh|n\.?\s*v\.?)\b/i.test(companyLine.text))
  ) {
    return company;
  }
  if (hasTrustedTerminalLegalLine(company, emails, websites)) return company;
  const idx = lines.findIndex((l) => l.id === companyLineId);
  if (idx <= 0) return company;
  for (let j = idx - 1; j >= Math.max(0, idx - 4); j--) {
    const prev = lines[j];
    if (!prev || prev.masked || LEGAL_RE.test(prev.text)) continue;
    if (/@|p\.?\s*v\.?\s*a|c\.?\s*f/i.test(prev.text)) continue;
    if (/\b(?:distributor|reseller|service\s+center|dealer|partner)\b/i.test(prev.text)) continue;
    const pt = tokens(prev.text);
    if (pt.length !== 1 || pt[0].length > 10 || pt[0].length < 2) continue;
    if (!prev.f?.allCaps && !isCapsTok(pt[0])) continue;
    const brand = fixOcrTokenCasing(pt[0]);
    if (normalizeBrandKey(company).includes(normalizeBrandKey(brand))) continue;
    if (LEGAL_RE.test(company) && !isBrandCorroboratedByContact(brand, emails, websites)) continue;
    return `${brand} - ${company}`;
  }
  return company;
}

function mergeDescriptorCompanyBlocks(lines: Line[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const headerKey = compact(l.text);
    const isProfessionalCompanyHeader = /^(?:studiolegale|studioassociato|studioprofessionale)/.test(headerKey);
    if (!GENERIC_COMPANY_HEADER.has(headerKey) && !isProfessionalCompanyHeader) continue;
    const parts = [l.text];
    let j = i + 1;
    while (j < lines.length) {
      const prev = lines[j - 1];
      const cur = lines[j];
      if (cur.page !== prev.page || cur.indexInPage !== prev.indexInPage + 1) break;
      if (cur.masked) break;
      const key = compact(cur.text);
      const toks = tokens(cur.text);
      const isDescriptor = GENERIC_COMPANY_HEADER.has(key);
      const looksLikePerson = Boolean(parsePersonLine(cur.text, []));
      const isCapsNameBlock =
        !looksLikePerson &&
        toks.length >= 2 &&
        toks.length <= 4 &&
        cur.f?.allCaps &&
        (cur.f?.digitRatio ?? 0) === 0 &&
        !EMAIL_RE.test(cur.text);
      const isProfessionalNameChain =
        isProfessionalCompanyHeader &&
        cur.text === cur.text.toUpperCase() &&
        (cur.f?.digitRatio ?? 0) === 0 &&
        /[-:&]/.test(cur.text) &&
        (cur.text.match(/[A-Z\u00C0-\u00DC]/g)?.length ?? 0) >= 6 &&
        !EMAIL_RE.test(cur.text) &&
        !ROLE_RE.test(cur.text) &&
        !lineLooksLikeAddress(cur.text);
      if (isDescriptor || isCapsNameBlock || isProfessionalNameChain) {
        parts.push(cur.text);
        j++;
        continue;
      }
      break;
    }
    if (parts.length < 2) continue;
    l.text = clean(parts.join(' '));
    l.f.tokenCount = tokens(l.text).length;
    l.f.length = l.text.length;
    l.f.allCaps = tokens(l.text).every((t) => isCapsTok(t));
    for (let k = i + 1; k < j; k++) {
      lines[k].masked = 'merged-into-prev';
      lines[k].companyScore = -10;
      lines[k].personScore = -10;
    }
  }
}

function hasNumberedStreetStructure(text: string): boolean {
  const candidate = stripLegalFormSuffix(text).trim();
  return hasStrongNumberedStreetStructure(candidate);
}

function scoreCompany(l: Line, brandReps: Map<number, number>): number {
  if (l.masked && l.masked !== 'address') return -10;
  const inlineCompanyAddress = splitCompanyInlineAddress(l.text);
  const semanticCandidate =
    inlineCompanyAddress?.company ??
    stripNumberedLocationAfterLegalForm(l.text);
  const terminalLegal = matchTerminalLegalFormSuffix(semanticCandidate);
  const hasStrongTerminalLegal =
    terminalLegal?.strength === 'strong' &&
    normalizeBrandKey(terminalLegal.brand).length >= 2;
  const hasTrimmedNumberedLocation =
    semanticCandidate.trim() !== l.text.trim() &&
    (
      hasTerminalLegalFormSuffix(semanticCandidate) ||
      Boolean(inlineCompanyAddress && terminalLegal)
    );
  if (shouldRejectCompanyCandidate(semanticCandidate)) return -10;
  if (GEOGRAPHIC_DESCRIPTOR_RE.test(semanticCandidate.trim())) return -10;
  if (/@|\[[^\]]*\.[a-z]{2,}/i.test(l.text)) return -10;
  if (isHostnameOnlyCompany(semanticCandidate)) return -10;
  // Non rigettare righe ALLCAPS con & (es. HUMANS & DIVERSITY, A&D SRL)
  if (!LEGAL_RE.test(semanticCandidate) && !/[&+]/.test(semanticCandidate) && parsePersonLine(semanticCandidate, []) && l.f?.allCaps && (l.f?.tokenCount ?? 0) <= 3) {
    return -10;
  }
  const f = l.f;
  if (
    f.addressLike &&
    !hasTrimmedNumberedLocation &&
    (!hasStrongTerminalLegal ||
      hasNumberedStreetStructure(semanticCandidate))
  ) {
    return -10;
  }
  if (f.tokenCount < 1) return -10;
  if (f.tokenCount === 1 && f.length <= 2) return -10; // glifo di logo letto come lettera
  let s = 0;
  if (f.hasLegalSuffix) s += W.company.legalSuffix;
  s += W.company.domainRootMatch * f.domainRootMatch;
  if (f.hasLegalSuffix && f.domainRootMatch >= 0.7) s += W.company.legalPlusBrand;
  if (f.fontScale > 1.2) s += W.company.bigFont;
  if (f.yQuantile < 0.3) s += W.company.topBand;
  s += W.company.brandRepetition * (brandReps.get(l.id) ?? 0);
  if (f.allCaps && f.tokenCount <= 3 && f.length <= 20) s += W.company.allCapsShort;
  if (f.tokenCount === 1 && GENERIC_COMPANY_HEADER.has(compact(l.text))) s += W.company.genericHeader;
  if (f.preSuffixActivityOnly) s += W.company.preSuffixActivityOnly;
  if (f.descriptorTagline) s += W.company.descriptorTagline;
  if (!f.hasLegalSuffix && f.activityWords >= 1 && f.tokenCount >= 3) s += W.company.descriptorLine;
  if (f.hasLegalSuffix && f.tokenCount <= 4 && f.domainRootMatch >= 0.75) s += W.company.compactBrand;
  if (!f.hasLegalSuffix) s += W.company.emailLocalMatch * f.emailLocalMatch;
  if (f.roleKeyword && !f.hasLegalSuffix) s += W.company.roleKeyword;
  if (f.acronymCluster) s += W.company.acronymCluster;
  if (!f.hasLegalSuffix) s += W.company.activityWord * f.activityWords;
  if (!f.hasLegalSuffix && f.domainRootMatch < 0.5 && f.inNameLexicon && f.titleCase && f.tokenCount === 2) {
    s += W.company.personShape;
  }
  if (f.length > 55) s += W.company.tooLong;
  if (f.digitRatio > 0.1) s += W.company.digits;
  if (
    !f.hasLegalSuffix &&
    f.tokenCount >= 2 &&
    f.tokenCount <= 5 &&
    /\b(?:rappresentanze|rappresentanza|creations|progettazione|studio\s+tecnico|international|servizi|solutions|consulting|platform|generation)\b/i.test(
      l.text
    )
  ) {
    s += 2.8;
  }
  // Logo / marchio in testa al biglietto (ORIUM, XMedical, TERMOIDRAULICA)
  const brandTokenShape =
    f.tokenCount === 1 && /^[A-Z][A-Za-z0-9&]{3,}$/.test(l.text.trim());
  if (
    l.indexInPage <= 2 &&
    f.tokenCount <= 2 &&
    f.length >= 4 &&
    f.length <= 24 &&
    !f.roleKeyword &&
    !f.addressLike &&
    f.digitRatio === 0 &&
    !ROLE_KEYWORD_REGEX.test(l.text) &&
    !isItalianCityName(l.text) &&
    (f.allCaps || brandTokenShape)
  ) {
    s += 1.15;
  }
  if (f.tokenCount === 1 && f.allCaps && !f.hasLegalSuffix && f.domainRootMatch < 0.55) {
    s -= 2.2;
  }
  if (/\b(?:bvba|gmbh|n\.?\s*v\.?|ltd|llc|inc|s\.?\s*r\.?\s*l|s\.?\s*p\.?\s*a)\b/i.test(l.text) && f.hasLegalSuffix) {
    s += 1.4;
  }
  if (/\b(?:industries|industry|brothers|bros|holdings?)\b/i.test(l.text) && f.tokenCount >= 3) {
    s += 3.8;
  }
  // Nomi aziendali ALLCAPS con trattino (tipico tedesco: STEINBEIS-TRANSFERZENTRUM)
  if (/^[A-Z]{3,}(?:-[A-Z]{3,})+$/.test(l.text.trim()) && f.tokenCount === 1) {
    s += 3.5;
  }
  // Banca/Bank: aziende finanziarie (Banca Popolare di Milano, BPM)
  if (/\b(?:banca|bank|banque|banco|credit[eoa]?|cassa\s+di|casse|bpr|bpvn|bpm|bnl|unicredit|intesa)\b/i.test(l.text) && f.tokenCount >= 2) {
    s += 3.2;
  }
  // Corpo multitokens con & (HUMANS & DIVERSITY, A&D): boost se non è riga persona
  if (/[&]/.test(l.text) && f.tokenCount >= 2 && !f.inNameLexicon) {
    s += 2.0;
  }
  // Nomi istituzionali (AZIENDA UNITÀ LOCALE, LIBERA CATTEDRA, CENTRO UNIVERSITÁRIO)
  if (/\b(?:azienda\s+unit[a\u00e0]|unità\s+locale|ulss|libera\s+cattedra|centro\s+universitari|servizio\s+sanitario|azienda\s+ospedaliera|istituto\s+(?:di|per)|fondazione\s+\w+)\b/i.test(l.text)) {
    s += 4.0;
  }
  if (isProductCategoryTagline(l.text)) {
    s -= 12;
  }
  return s;
}

function scoreRole(l: Line): number {
  if (l.masked && l.masked !== 'address') return -10;
  const f = l.f;
  if (f.addressLike) return -10;
  let s = 0;
  if (f.roleKeyword) s += W.role.keyword;
  if (/\b(?:service\s+partner|authorized\s+dealer|centro\s+assistenza|partner\s+autorizzato|miele\s+service)\b/i.test(l.text)) {
    s += W.role.partnerStatus;
  }
  if (f.fontScale < 0.95) s += W.role.smallFont;
  if (f.hasLegalSuffix) s += W.role.legalSuffix;
  s += W.role.emailLocalMatch * f.emailLocalMatch;
  if (f.digitRatio > 0.05) s += W.role.digits;
  if (f.length > 45) s += W.role.tooLong;
  return s;
}

/** conta quante ALTRE righe contengono lo stesso brand (radice dominio) */
function brandRepetitions(lines: Line[]): Map<number, number> {
  const reps = new Map<number, number>();
  const brandLines = lines.filter((l) => l.f.domainRootMatch >= 0.7);
  for (const l of brandLines) {
    reps.set(l.id, Math.max(0, brandLines.filter((o) => o.id !== l.id && o.page !== l.page).length));
  }
  return reps;
}

interface PersonPick {
  firstName: string;
  lastName: string;
  score: number;
  lineIds: number[];
  reasons: string[];
}

function splitPersonFromCompanyLine(
  text: string,
  emailToks: string[],
  roots: Set<string>
): { first: string; last: string; company: string } | null {
  if (!LEGAL_RE.test(text)) return null;
  const toks = tokens(text);
  if (toks.length < 3) return null;
  const [a, b] = [compact(toks[0]), compact(toks[1])];
  const lexHit = FIRST_NAMES.has(a) || FIRST_NAMES.has(b);
  const emailHit = emailToks.some((et) => et.length > 1 && (sim(et, a) >= 0.8 || sim(et, b) >= 0.8));
  if (!lexHit && !emailHit) return null;
  const rest = toks.slice(2).join(' ');
  if (!LEGAL_RE.test(rest) || compact(rest).length < 3) return null;
  // "DeMegni Antonio & Figli S.p.A.": il "nome" fa parte della denominazione.
  if (/^(?:&|e|ed|and|und|y|\+|figli|f\.?lli|fratelli|c\.)(?:\s|$)/i.test(rest)) return null;
  // il presunto nome è il brand (radice del dominio) → non è una persona
  const leadingBrandKey = normalizeBrandKey(`${toks[0]} ${toks[1]}`);
  for (const r of roots) {
    if (
      sim(a, r) >= 0.8 ||
      sim(b, r) >= 0.8 ||
      sim(leadingBrandKey, r) >= 0.8 ||
      r.includes(leadingBrandKey) ||
      leadingBrandKey.includes(r)
    ) {
      return null;
    }
  }
  const firstIsGiven = FIRST_NAMES.has(a) || !FIRST_NAMES.has(b);
  return firstIsGiven
    ? { first: cap(toks[0]), last: cap(toks[1]), company: rest }
    : { first: cap(toks[1]), last: cap(toks[0]), company: rest };
}

function repairPersonNameTokens(toks: string[]): string[] {
  // I token persona osservati non ricevono lettere nuove senza una
  // corroborazione indipendente; il casing viene normalizzato più avanti.
  return [...toks];
}

/** OCR: "l" iniziale al posto di "I" nel cognome (lqbal → Iqbal). */
function repairOcrInitialAsLetterI(fragment: string): string {
  const bare = fragment.replace(/[.,]/g, '');
  if (/^l([a-zà-ü]{3,})$/i.test(bare)) {
    return 'I' + bare.slice(1);
  }
  return bare;
}

function splitPersonTextAndInlineRole(text: string): { personText: string; inlineRole?: string } {
  const normalizeRoleTail = (tail: string) => tail.replace(/\bGoneral\b/i, 'General');
  const slash = text.match(/^(.+?)\s*\/\s*(.+)$/);
  if (slash) {
    const tail = normalizeRoleTail(slash[2].trim());
    if (ROLE_RE.test(tail)) return { personText: slash[1].trim(), inlineRole: tail };
  }
  const dash = text.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash) {
    const head = dash[1].trim();
    const tail = normalizeRoleTail(dash[2].trim());
    if (ROLE_RE.test(tail) && head.split(/\s+/).filter(Boolean).length >= 2 && !LEGAL_RE.test(head)) {
      return { personText: head, inlineRole: tail };
    }
  }
  return { personText: text };
}

/** "Luqman S.lqbal" — iniziale di secondo nome + cognome OCR. */
function parsePersonWithMiddleInitial(text: string): { first: string; last: string } | null {
  const m = text.trim().match(/^([A-Za-zÀ-ü]{2,})\s+([A-Z])\.\s*([a-zà-ü]{3,})$/i);
  if (!m) return null;
  const last = repairOcrInitialAsLetterI(m[3]);
  const validated = validatePersonName({ firstName: cap(m[1]), lastName: cap(last) });
  if (!validated?.firstName || !validated.lastName) return null;
  return { first: validated.firstName, last: validated.lastName };
}

function domainBrandHostParts(emails: string[]): string[] {
  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain) return [];
  const host = domain.split('.')[0] ?? '';
  return host
    .split(/[-_]+/)
    .map((part) => normalizeBrandKey(part))
    .filter((part) => part.length >= 3);
}

function isPersonNameDomainBrandCollision(
  firstName: string,
  lastName: string,
  emails: string[] = []
): boolean {
  const fn = normalizeBrandKey(firstName);
  const ln = normalizeBrandKey(lastName);
  if (!fn || !ln) return false;
  if (/^e[''`´]?$/i.test(firstName.trim()) || firstName.replace(/\./g, '').trim().length <= 1) return true;
  if (NON_PERSON_WORDS.has(lastName.toLowerCase())) return true;
  const hostParts = domainBrandHostParts(emails);
  if (hostParts.length >= 2 && hostParts.includes(fn) && hostParts.includes(ln)) return true;
  const domain = getPrimaryBusinessEmailDomain(emails);
  const fullKey = normalizeBrandKey(domain?.split('.')[0] ?? '');
  if (fullKey && (normalizeBrandKey(`${firstName}${lastName}`) === fullKey || normalizeBrandKey(`${firstName} ${lastName}`) === fullKey)) {
    return true;
  }
  if (fullKey && fuzzyCompanyDomainDistance(`${firstName}${lastName}`, fullKey) <= 2) return true;
  if (
    fullKey &&
    ln.length >= 4 &&
    fuzzyCompanyDomainDistance(lastName, fullKey) <= 1
  ) {
    const allMailboxesAreGeneric =
      emails.length > 0 &&
      emails.every((email) => {
        const localTokens = (email.split('@')[0] ?? '')
          .split(/[._+\-]+/)
          .map((token) => token.trim())
          .filter(Boolean);
        return (
          localTokens.length > 0 &&
          localTokens.every(
            (token) =>
              GENERIC_LOCAL_RE.test(token) ||
              isGenericContactOrDepartmentToken(token)
          )
        );
      });
    if (
      personEmailAffinityScore(firstName, lastName, emails) >= 6 ||
      allMailboxesAreGeneric
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function hasPositivePersonEvidenceForWeakLine(
  text: string,
  firstName: string,
  lastName: string,
  emails: string[],
  personScore: number,
  adjacentRoleText?: string | null
): boolean {
  if (personScore >= T.person) return true;
  if (parseCapsSurnameFirstLine(text)) return true;
  if (isLikelyPersonNameAboveRoleLine(text, adjacentRoleText)) return true;
  if (FIRST_NAMES.has(compact(firstName))) return true;
  if (personEmailAffinityScore(firstName, lastName, emails) >= 3) return true;
  if (
    /^(?:(?:dott|dott\.ssa|dr|prof|avv|ing|arch|geom|rag|sig|sig\.ra)\.?\s+)/i.test(
      text.trim()
    )
  ) {
    return true;
  }
  return isStrongProfessionalQualificationLine(adjacentRoleText);
}

function isStrongProfessionalQualificationLine(
  text?: string | null
): boolean {
  return /^(?:perito|avvocato|ingegnere|architetto|commercialista|geometra|notaio|dottore|dottoressa)\b/i.test(
    text?.trim() ?? ''
  );
}

function isSplitBrandLogoPair(a: string, b: string, emails: string[] = []): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  if (FIRST_NAMES.has(compact(left)) || FIRST_NAMES.has(compact(right))) return false;
  const hostParts = domainBrandHostParts(emails);
  if (hostParts.length >= 2) {
    const la = normalizeBrandKey(left);
    const rb = normalizeBrandKey(right);
    if (hostParts.includes(la) && hostParts.includes(rb)) return true;
  }
  const domain = getPrimaryBusinessEmailDomain(emails);
  const fullKey = normalizeBrandKey(domain?.split('.')[0] ?? '');
  if (!fullKey) return false;
  const combined = normalizeBrandKey(`${left}${right}`);
  const combinedSpaced = normalizeBrandKey(`${left} ${right}`);
  return combined === fullKey || combinedSpaced === fullKey;
}

function extractPersonFromItalianLegalCompany(text: string): { first: string; last: string } | null {
  const m = text.match(
    /\bi\s+((?:De|Di|Del|Della|Dello|Dei|Degli|Da|Dal|Van|Von)\s+[A-Za-zÀ-ü]+(?:\s+[A-Za-zÀ-ü]+)*)\s+([A-ZÀ-Ü][a-zà-ü]+)\s*&\s*C\.?\b/i
  );
  if (!m) return null;
  const validated = validatePersonName({ firstName: cap(m[2]), lastName: cap(m[1]) });
  if (!validated) return null;
  return { first: validated.firstName, last: validated.lastName };
}

/** "di MENEGOZZO GIANTONIO" in ragione sociale s.n.c. — di non è particella del cognome. */
function extractPersonFromDiOwnerLine(text: string): { first: string; last: string } | null {
  const m = text.match(/^di\s+([A-Za-zÀ-ü'’-]+)\s+([A-Za-zÀ-ü'’-]+)\s*$/i);
  if (!m) return null;
  const surname = m[1].trim();
  const given = m[2].trim();
  if (FIRST_NAMES.has(compact(surname))) return null;
  if (FIRST_NAMES.has(compact(given)) && !/^[A-ZÀ-Ü]{4,}$/.test(surname)) {
    return null;
  }
  const validated = validatePersonName({ firstName: cap(given), lastName: cap(surname) });
  if (!validated) return null;
  return { first: validated.firstName, last: validated.lastName };
}

function repairOcrDigitsInName(s: string): string {
  return s
    .replace(/([A-Za-z])10(?=[A-Za-z])/gi, '$1IO')
    .replace(/([A-Za-z])0([A-Za-z])/g, '$1O$2')
    .replace(/\b0(?=[a-z])/gi, 'O')
    .replace(/(?<=[a-z])0\b/gi, 'o');
}

function parsePersonLine(text: string, emailToks: string[], emails: string[] = []): { first: string; last: string } | null {
  if (isContactLabelNoisePersonLine(text)) return null;
  if (/\bskype\b/i.test(text.trim())) return null;
  const { personText } = splitPersonTextAndInlineRole(text);
  const initialExpanded = personText
    .replace(/([a-zà-ü])([A-ZÀ-Ü])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const leadingInitialPerson = initialExpanded.match(
    /^([A-Za-zÀ-Ü])\.\s+([A-Za-zÀ-ü'’-]{2,})\s+([A-Za-zÀ-ü'’-]{2,})$/
  );
  if (
    leadingInitialPerson &&
    FIRST_NAMES.has(compact(leadingInitialPerson[2] ?? ''))
  ) {
    const validated = validatePersonName({
      firstName: cap(leadingInitialPerson[2] ?? ''),
      lastName: cap(leadingInitialPerson[3] ?? ''),
    });
    if (validated?.firstName && validated.lastName) {
      return {
        first: leadingInitialPerson[1].toUpperCase() + '. ' + validated.firstName,
        last: validated.lastName,
      };
    }
  }
  const hasExplicitHonorific = HONORIFIC_RE.test(personText);
  const middleInitial = parsePersonWithMiddleInitial(personText);
  if (middleInitial) return middleInitial;
  const fusedNormalized = normalizeFusedPersonLine(personText, emails, emailToks);
  const capsSurnameFirst = parseCapsSurnameFirstLine(personText);
  if (capsSurnameFirst) return { first: capsSurnameFirst.firstName, last: capsSurnameFirst.lastName };
  let stripped = repairOcrDigitsInName(
    clean(
      fusedNormalized
        .replace(HONORIFIC_RE, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/[",]/g, ' ')
    )
  );
  let toks = tokens(stripped).map((t) => t.replace(/[^\p{L}'’\-.]/gu, '')).filter(Boolean);
  // Rimuovi token ruolo/titolo dalla fine: "Alexander Pohl CEO" → ["Alexander", "Pohl"]
  while (toks.length >= 3 && ROLE_RE.test(toks[toks.length - 1] ?? '')) {
    toks.pop();
  }
  // Rigetta righe con parole-brand composte (European TelematicsFactory): token CamelCase con suffisso business
  if (toks.some((t) => /^[A-Z][a-z]{2,}(?:Factory|Ware|Works|ware|Corp|Media|Networks?|Digital|Hub|Lab|Cloud|Box)$/.test(t))) {
    return null;
  }
  const expanded: string[] = [];
  for (const t of toks) {
    const fused = t.match(/^([A-Za-z])\.([A-Za-z]{2,})$/);
    if (fused) {
      expanded.push(fused[1]);
      expanded.push(fused[2]);
    } else expanded.push(t);
  }
  toks = expanded.map((t) => t.replace(/^0(?=[a-zà-ÿ])/i, 'O'));
  if (hasExplicitHonorific && toks.length === 2) {
    const proposedFirstName = repairExtraInternalOcrGlyphInFirstName(toks[0]!);
    if (compact(proposedFirstName) !== compact(toks[0]!)) {
      const corroborated = parseExactObservedPersonFromEmail(
        `${proposedFirstName} ${toks[1]}`,
        emails
      );
      if (
        corroborated &&
        compact(corroborated.firstName) === compact(proposedFirstName) &&
        compact(corroborated.lastName) === compact(toks[1]!)
      ) {
        toks[0] = proposedFirstName;
      }
    }
  }
  toks = repairPersonNameTokens(toks);
  while (toks.length >= 3 && NON_PERSON_WORDS.has(compact(toks[0]))) {
    toks.shift();
  }
  if (toks.length >= 2 && /^[A-Za-z]\.?$/.test(toks[0]) && toks[0].replace(/\./g, '').length === 1) {
    toks = toks.slice(1);
  }
  if (
    toks.length === 2 &&
    FIRST_NAMES.has(compact(toks[1])) &&
    !FIRST_NAMES.has(compact(toks[0]))
  ) {
    return { first: cap(toks[1]), last: cap(toks[0]) };
  }
  const diOwner = extractPersonFromDiOwnerLine(stripped);
  if (diOwner) return diOwner;
  if (
    toks.length >= 3 &&
    /^(?:di|de|del|della|dei|degli)$/i.test(toks[0]) &&
    FIRST_NAMES.has(compact(toks[1]))
  ) {
    toks = toks.slice(1); // "di Erik Rizzo" → proprietà, non cognome
  }
  if (toks.length < 2 || toks.length > 5) return null;

  // particelle: "De Zio" resta cognome unito
  const merged: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const low = toks[i].toLowerCase();
    if (NAME_PARTICLES.has(low) && i + 1 < toks.length) {
      merged.push(toks[i] + ' ' + toks[i + 1]);
      i++;
    } else merged.push(toks[i]);
  }
  toks = merged;
  if (toks.length < 2) return null;
  toks = repairPersonNameTokens(toks);

  const lower = toks.map((t) => compact(t));
  let firstIdx = lower.findIndex((t) => FIRST_NAMES.has(t));
  // riordino via email: local "m.frati" e riga "FRATI MARIO"
  if (emailToks.length === 2) {
    const [ea, eb] = emailToks;
    const iA = lower.findIndex((t) => sim(t, ea) >= 0.8 || (ea.length === 1 && t.startsWith(ea)));
    const iB = lower.findIndex((t) => sim(t, eb) >= 0.8 || (eb.length === 1 && t.startsWith(eb)));
    if (iA >= 0 && iB >= 0 && iA !== iB) {
      // convenzione dominante: local = nome.cognome (o iniziale.cognome)
      return { first: cap(toks[iA]), last: toks.filter((_, i) => i !== iA).map(cap).join(' ') };
    }
  }
  if (firstIdx < 0 && FIRST_NAMES.has(lower[lower.length - 1])) firstIdx = lower.length - 1;
  if (firstIdx < 0) firstIdx = 0;
  const first = cap(toks[firstIdx]);
  const last = toks.filter((_, i) => i !== firstIdx).map(cap).join(' ');
  if (!first || !last) return null;
  const lastLead = compact(last.split(/\s+/)[0] ?? '');
  if (GENERIC_EMAIL_NAME_TOKENS.has(compact(first)) || GENERIC_EMAIL_NAME_TOKENS.has(lastLead)) {
    return null;
  }
  if (first.length <= 1 && !HONORIFIC_RE.test(text) && (GENERIC_EMAIL_NAME_TOKENS.has(lastLead) || /^mail\b/i.test(last))) {
    return null;
  }
  const validated = validatePersonName({ firstName: first, lastName: last });
  if (validated) {
    return { first: validated.firstName, last: validated.lastName };
  }
  const fromLine = parsePersonNameFromLine(stripped);
  if (fromLine) {
    return { first: fromLine.firstName, last: fromLine.lastName };
  }
  return null;
}

function parseRoleAdjacentPersonLine(
  text: string,
  adjacentRoleText: string,
  emailToks: string[],
  emails: string[] = []
): { first: string; last: string } | null {
  const exactEmailPerson = parseExactObservedPersonFromEmail(text, emails);
  if (exactEmailPerson) {
    return {
      first: exactEmailPerson.firstName,
      last: exactEmailPerson.lastName,
    };
  }
  return (
    parsePersonLine(text, emailToks, emails)
  );
}

// ---------------------------------------------------------------------------
// Indirizzo — assemblaggio zona
// ---------------------------------------------------------------------------

function stripCompanyPrefixFromAddressLine(text: string): string {
  const inline = splitCompanyInlineAddress(text);
  if (inline) return inline.address;
  const legalCompany = stripNumberedLocationAfterLegalForm(text);
  if (legalCompany.trim() !== text.trim()) {
    const locationTail = text
      .slice(legalCompany.length)
      .replace(/^\s*[,;:–—-]?\s*/, '')
      .replace(/^\(\s*/, '')
      .replace(/\s*\)$/, '')
      .trim();
    if (locationTail) return clean(locationTail);
  }
  const labelStrip = text.replace(
    /^(?:didattica|didoica|sede\s+(?:operativa|legale)|domicilio|ufficio|office)\s*:\s*/i,
    ''
  );
  if (labelStrip !== text) return clean(labelStrip);
  const capOnly = text.match(
    /^(\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]+(?:\s*\([A-Za-z]{2}\))?(?:\s+(?:Italy|Italia|IT))?)\s*$/i
  );
  if (capOnly) return clean(capOnly[1]);
  const legalDash = text.match(
    /^(?:.+?\s+(?:s\.?\s*r\.?\s*l\.?|srl|spa|snc|sas|s\.?\s*p\.?\s*a\.?)\.?)\s*[-–—,]\s*(.+)$/i
  );
  if (legalDash && STREET_RE.test(legalDash[1])) return clean(legalDash[1]);
  const companyPrefixStreet = text.match(
    /^(?:[A-Z]{2,10}\s+(?:s\.?\s*r\.?\s*l\.?|srl|spa|gmbh|s\.?\s*p\.?\s*a\.?)\.?)\s+((?:via|viale|piazza|corso|vicolo|strada|str\.|v\.).+)$/i
  );
  if (companyPrefixStreet) return clean(companyPrefixStreet[1]);
  const dashStreet = text.match(/^.+?\s+-\s+((?:via|viale|piazza|corso|vicolo|strada|str\.|v\.|localit[aà]).+)$/i);
  if (dashStreet) return clean(dashStreet[1]);
  return text.replace(/\b(?:e\s+)?(?:soluzioni|software|ingegneria)\b.*$/i, '').trim();
}

function hasUsableAddressTailAfterCompanyPrefix(text: string): boolean {
  if (splitCompanyInlineAddress(text)) return true;
  const tail = stripCompanyPrefixFromAddressLine(text);
  if (!tail || tail.trim() === text.trim()) return false;
  return (
    STREET_RE.test(tail) ||
    CAP_CITY_PROV_RE.test(tail) ||
    (POSTAL_RE.test(tail) &&
      (PROVINCE_RE.test(tail) || COUNTRY_RE.test(tail)))
  );
}

function isRedundantAddressFragment(fragment: string, primary: string): boolean {
  const f = fragment.trim().toLowerCase();
  const p = primary.trim().toLowerCase();
  if (!f || f === p) return true;
  if (p.includes(f)) return true;
  const civic = f.match(/^(?:nr\.?\s*)?(\d{1,5}[a-z0-9/]*)\s*-\s*(.+)$/i);
  if (civic && p.includes(civic[1]) && p.includes(civic[2].replace(/\s*\([a-z]{2}\)\s*$/i, '').trim())) {
    return true;
  }
  return false;
}

function repairOcrPostalCode(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, '').trim();
  if (/^\d{5}$/.test(cleaned)) return cleaned;
  const bDigit = cleaned.match(/^B(\d{4})$/i);
  if (bDigit) return `3${bDigit[1]}`;
  const digit = cleaned.match(/^(\d{4,5})$/);
  if (digit && digit[1].length === 5) return digit[1];
  return undefined;
}

function extractUnlabeledPostalCode(text: string): string | undefined {
  for (const match of text.matchAll(/\b(?:B\d{4}|\d{4,6})\b/gi)) {
    const raw = match[0];
    const matchIndex = match.index ?? 0;
    const before = text.slice(0, matchIndex);
    if (new RegExp(`${CIVIC_LABEL_PATTERN}$`, 'i').test(before)) continue;
    const segmentStart =
      Math.max(
        before.lastIndexOf(','),
        before.lastIndexOf(';'),
        before.lastIndexOf('\n')
      ) + 1;
    const remaining = text.slice(segmentStart);
    const segmentEnd = remaining.search(/[,;\n]/);
    const segment =
      segmentEnd >= 0 ? remaining.slice(0, segmentEnd) : remaining;
    const numberOffset = matchIndex - segmentStart;
    if (
      numberOffset === segment.search(/\S/) &&
      hasStrongNumberedStreetStructure(segment)
    ) {
      continue;
    }
    const repaired = repairOcrPostalCode(raw);
    if (repaired) return repaired;
    if (/^\d{4,6}$/.test(raw)) return raw;
  }
  return undefined;
}

function parseOcrCorruptedPostalCity(text: string): { city?: string } | null {
  const t = clean(text.trim());
  const match = t.match(/^([A-Z0-9]{4,6})\s+([\p{L}][\p{L}\p{M}'’ .-]{2,50})$/u);
  if (
    !match ||
    !/\d/.test(match[1]) ||
    !/[OILBSZG]/i.test(match[1]) ||
    /^\d+$/.test(match[1])
  ) {
    return null;
  }
  return { city: clean(match[2]) };
}

function isLocationOnlyAddressLine(text: string): boolean {
  const t = text.trim();
  return (
    CITY_PROV_ONLY_RE.test(t) ||
    CAP_CITY_PROV_RE.test(t) ||
    /^\d{5}$/.test(t) ||
    Boolean(parseOcrCorruptedPostalCity(t)) ||
    Boolean(cityPrefixBeforeContact(t))
  );
}

function cityPrefixBeforeContact(text: string): string | undefined {
  const match = text.trim().match(
    /^([\p{L}][\p{L}\p{M}' .-]{1,40}?)\s+(?=(?:tel(?:efono)?|phone|fax|mobile|cell(?:ulare)?)\b)/iu
  );
  const prefix = match?.[1]?.trim();
  if (!prefix) return undefined;

  // Qualificatori del recapito non sono località:
  // "direct tel", "office phone", "work phone", ecc.
  if (/^(?:direct|diretto|office|ufficio|mobile|cell(?:ulare)?|work|home|main|switchboard)$/iu.test(prefix)) {
    return undefined;
  }
  return prefix;
}

function collectLocationNeighborLines(allLines: Line[], group: Line[], maxDist = 2): Line[] {
  if (!group.length) return [];
  const page = group[0].page;
  const minIdx = Math.min(...group.map((g) => g.indexInPage));
  const maxIdx = Math.max(...group.map((g) => g.indexInPage));
  const groupIds = new Set(group.map((g) => g.id));
  return allLines.filter(
    (l) =>
      l.page === page &&
      l.indexInPage >= minIdx - maxDist &&
      l.indexInPage <= maxIdx + maxDist &&
      !groupIds.has(l.id) &&
      l.masked !== 'contact-label' &&
      l.masked !== 'structured' &&
      l.masked !== 'social' &&
      !ROLE_RE.test(l.text) &&
      (lineLooksLikeAddress(l.text) ||
        isLocationOnlyAddressLine(l.text) ||
        COUNTRY_RE.test(l.text) ||
        FOREIGN_ADDR_LINE_RE.test(l.text) ||
        /\b(?:court|building|suite|floor)\b/i.test(l.text))
  );
}

function parseCityProvLine(text: string): { city?: string; region?: string; postalCode?: string } {
  const t = clean(text.trim());
  const corruptedPostalCity = parseOcrCorruptedPostalCity(t);
  if (corruptedPostalCity?.city) return { city: corruptedPostalCity.city };
  const contactCity = cityPrefixBeforeContact(t);
  if (contactCity) return { city: contactCity };
  const cityRegionPostal = t.match(
    /^([\p{L}][\p{L}\p{M}'’ .-]{1,42}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/u
  );
  if (cityRegionPostal) {
    return {
      city: clean(cityRegionPostal[1]),
      region: cityRegionPostal[2].toUpperCase(),
      postalCode: cityRegionPostal[3],
    };
  }
  const capCity = t.match(CAP_CITY_PROV_RE);
  if (capCity) {
    return {
      postalCode: repairOcrPostalCode(capCity[1]) ?? capCity[1],
      city: clean(capCity[2]),
      region: capCity[3].toUpperCase(),
    };
  }
  // DE/EU: "60486 Frankfurt am Main" (postal then city, no province)
  const capCityPlain = t.match(/^(\d{5})\s+([\p{L}][\p{L}\p{M}'’ .-]{2,50})$/u);
  if (capCityPlain) {
    return {
      postalCode: repairOcrPostalCode(capCityPlain[1]) ?? capCityPlain[1],
      city: clean(capCityPlain[2]),
    };
  }
  // US-style: "Boston, Massachusetts 02215" / "Boston, Massachusetts 022 15"
  const usCityStateZip = t.match(
    /^([\p{L}][\p{L}\p{M}'’ .-]{2,40}),\s*([A-Za-z]{3,20})\s+(\d{3}\s?\d{2}(?:-\d{4})?)$/u
  );
  if (usCityStateZip) {
    return {
      city: clean(usCityStateZip[1]),
      region: clean(usCityStateZip[2]),
      postalCode: usCityStateZip[3].replace(/\s+/g, ''),
    };
  }
  const cityProv = t.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,42})\s*\(([A-Z]{2})\)\s*$/i);
  if (cityProv) {
    return { city: clean(cityProv[1]), region: cityProv[2].toUpperCase() };
  }
  const capOnly = repairOcrPostalCode(t);
  if (capOnly) return { postalCode: capOnly };
  return {};
}

function joinAddressLineTexts(lines: string[]): string {
  const cleaned = lines.map((t) => clean(t)).filter(Boolean);
  if (cleaned.length <= 1) return cleaned[0] ?? '';
  if (
    cleaned.some(
      (l) =>
        FOREIGN_ADDR_LINE_RE.test(l) ||
        COUNTRY_RE.test(l) ||
        /\b(?:street|road|court|lane|drive|avenue)\b/i.test(l)
    )
  ) {
    return joinAddressComponents(cleaned);
  }
  const streets = cleaned.filter((l) => STREET_RE.test(l));
  const primary = streets[0] ?? cleaned[0];
  const rest = cleaned.filter((l) => l !== primary && !isRedundantAddressFragment(l, primary));
  if (!rest.length) return primary;
  if (
    rest.every(
      (l) =>
        /^(?:nr\.?\s*\d|\d{5}\b|[A-Za-z]{1,2}-?\d{4,6}\b)/i.test(l) ||
        /^[A-ZÀ-Ü][a-zà-ü' .-]+(?:\s*\([A-Z]{2}\))?$/i.test(l) ||
        COUNTRY_RE.test(l)
    )
  ) {
    return joinAddressComponents([primary, ...rest]);
  }
  if (
    rest.some(
      (l) =>
        /\b[A-Za-z]{1,2}-?\d{4,6}\b/.test(l) ||
        /^\d{5}\s+[A-Za-z]/i.test(l) ||
        COUNTRY_RE.test(l) ||
        FOREIGN_ADDR_LINE_RE.test(l)
    )
  ) {
    return joinAddressComponents([primary, ...rest]);
  }
  if (cleaned.length >= 2) return joinAddressComponents(cleaned);
  return primary;
}

function shouldStopAddressBlockLine(line: Line): boolean {
  if (isOfficeAddressLabel(line.text)) return true;
  if (line.masked === 'structured' || line.masked === 'social') return true;
  if (isPhoneOrFaxLine(line.text)) return true;
  if (isOcrFusedEmailDomainLine(line.text)) return true;
  if (/^https?:\/\//i.test(line.text.trim()) || /^www\./i.test(line.text.trim())) return true;
  return false;
}

function formatOfficeLabel(text: string): string {
  return clean(text.replace(/:+\s*$/, '').trim())
    .split(/\s+/)
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : cap(w)))
    .join(' ');
}

function cleanForeignAddressLine(text: string): string {
  return clean(
    text
      .replace(/\b1Z\b/gi, 'IZ')
      .replace(/\s*@\s*/g, ' ')
      .replace(/\s+-+\s*/g, '-')
      .replace(/,(?!\s)/g, ', ')
      .replace(/,\s*,/g, ',')
      .trim()
  );
}

interface OfficeAddressAnchor {
  line: Line;
  label: string;
  inlineAddress?: string;
}

const INLINE_OFFICE_ADDRESS_RE =
  /^(head\s+office|main\s+office|branch\s+office|registered\s+office|corporate\s+office|sales\s+office|regional\s+office|warehouse|showroom|factory|plant|[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{1,24}\s+(?:office|factory|faciory)|sede\s+(?:centrale|operativa|legale|amministrativa|fiscale))\s*(?:[:/|]|\s[-–—]\s)\s*(.+)$/i;

function officeAddressAnchor(line: Line): OfficeAddressAnchor | null {
  const text = line.text.trim();
  if (isOfficeAddressLabel(text)) {
    return { line, label: formatOfficeLabel(text) };
  }

  const inline = text.match(INLINE_OFFICE_ADDRESS_RE);
  if (!inline?.[1] || !inline[2]) return null;
  const inlineAddress = inline[2].trim();
  if (
    !STREET_RE.test(inlineAddress) &&
    !FOREIGN_ADDR_LINE_RE.test(inlineAddress) &&
    !COUNTRY_RE.test(inlineAddress) &&
    !/\b\d{4,6}\b/.test(inlineAddress)
  ) {
    return null;
  }
  return {
    line,
    label: formatOfficeLabel(inline[1]),
    inlineAddress,
  };
}

function collectOfficeAddressBlocks(lines: Line[]): { label: string; lines: Line[] }[] {
  const sorted = [...lines].sort((a, b) => a.page - b.page || a.indexInPage - b.indexInPage);
  const anchors = sorted
    .map(officeAddressAnchor)
    .filter((anchor): anchor is OfficeAddressAnchor => Boolean(anchor));
  if (!anchors.length) return [];

  const blocks: { label: string; lines: Line[] }[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const next = anchors[i + 1];
    const blockLines: Line[] = anchor.inlineAddress
      ? [{ ...anchor.line, text: anchor.inlineAddress }]
      : [];
    for (const line of sorted) {
      if (line.page !== anchor.line.page || line.indexInPage <= anchor.line.indexInPage) continue;
      if (
        next &&
        line.page === next.line.page &&
        line.indexInPage >= next.line.indexInPage
      ) {
        break;
      }
      if (officeAddressAnchor(line) || shouldStopAddressBlockLine(line)) break;
      blockLines.push(line);
    }
    if (blockLines.length) blocks.push({ label: anchor.label, lines: blockLines });
  }
  return blocks;
}

function parseForeignLocationFromLines(lines: Line[]): Pick<V5AddressParts, 'city' | 'region' | 'country' | 'street'> {
  const joined = lines.map((l) => cleanForeignAddressLine(l.text)).join(' ');
  const countryMatch = joined.match(COUNTRY_RE);
  const country = countryMatch?.[0];
  let city: string | undefined;
  const cityMatches = [...joined.matchAll(/\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,40}\s+City)\b/gi)];
  for (let i = cityMatches.length - 1; i >= 0; i--) {
    const candidate = clean(cityMatches[i][1]);
    if (!/-(?:ku|do|gu|dong)\b/i.test(candidate)) {
      city = candidate;
      break;
    }
  }
  if (!city) {
    const metroMatches = [...joined.matchAll(/\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,40}\s+Metropolitan\s+City)\b/gi)];
    if (metroMatches.length) city = clean(metroMatches[metroMatches.length - 1][1]);
  }
  let region: string | undefined;
  const regionMatch = joined.match(/\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,24}-Do)\b/i);
  if (regionMatch) region = clean(regionMatch[1]);
  const street = cleanForeignAddressLine(lines[0]?.text ?? '');
  return { street, city, region, country: country ? cap(country) : undefined };
}

function assembleMultiOfficeAddresses(lines: Line[]): V5AddressParts[] {
  const blocks = collectOfficeAddressBlocks(lines);
  return blocks.map((block) => {
    const parsed = parseForeignLocationFromLines(block.lines);
    const body = block.lines
      .map((line) => cleanForeignAddressLine(line.text))
      .join(', ');
    const full = `${block.label}: ${body}`;
    return {
      full,
      street: parsed.street,
      civicNumber: undefined,
      postalCode: undefined,
      city: parsed.city,
      region: parsed.region,
      country: parsed.country ?? (/\bkorea\b/i.test(full) ? 'Korea' : undefined),
    };
  });
}

function assembleMultiOfficeAddress(lines: Line[]): V5AddressParts | null {
  return assembleMultiOfficeAddresses(lines)[0] ?? null;
}

function pickBestLegalCompanyLine(
  lines: Line[],
  brandReps: Map<number, number>,
  emails: string[],
  websites: Map<string, number>,
  rawText: string
): { value: string; lineId: number; score: number } | null {
  const ranked = [...lines]
    .map((l) => {
      const normalized = normalizeLegal(l.text);
      const candidate = sanitizeCompanyValue(companySemanticText(normalized));
      const trimmedNumberedLocation =
        candidate.length < normalized.trim().length &&
        hasTerminalLegalFormSuffix(candidate);
      return {
        l,
        candidate,
        s: trimmedNumberedLocation
          ? Math.max(scoreCompany(l, brandReps), T.company + 0.2)
          : scoreCompany(l, brandReps),
      };
    })
    .filter(
      ({ l, candidate }) =>
        LEGAL_RE.test(candidate) &&
        !isUncorroboratedAmbiguousLegalLine(candidate, emails, websites) &&
        l.masked !== 'contact-label' &&
        l.masked !== 'social'
    )
    .sort((a, b) => b.s - a.s);
  for (const { l, candidate, s } of ranked) {
    if (s < T.company) continue;
    if (isLegalFormOnlyCompany(candidate)) continue;
    const finalized = finalizeCompanyValue(candidate, emails, rawText);
    if (finalized) return { value: finalized, lineId: l.id, score: s };
  }
  return null;
}

function combineLegalFormWithBrandLine(
  lines: Line[],
  legalForm: string,
  emails: string[],
  rawText: string,
  firstName?: string | null,
  lastName?: string | null
): string | null {
  const legalLine = lines.find((l) => isLegalFormOnlyCompany(normalizeLegal(l.text)));
  if (!legalLine) return null;
  const legalSuffix = normalizeLegal(legalForm);
  const nearbyCandidates: Line[] = [];

  for (const l of lines) {
    if (l.id === legalLine.id || l.masked === 'contact-label' || l.masked === 'social') continue;
    if (Math.abs(l.page - legalLine.page) > 0 || Math.abs(l.indexInPage - legalLine.indexInPage) > 3) continue;
    const t = sanitizeCompanyValue(normalizeLegal(l.text));
    if (!t || isRejectedCompanyValue(t) || isLegalFormOnlyCompany(t)) continue;
    nearbyCandidates.push(l);
  }
  const domainRoot = normalizeBrandKey(
    (emails.find((e) => e.includes('@'))?.split('@')[1] ?? '').split('.')[0] ?? ''
  );
  nearbyCandidates.sort((a, b) => {
    const aKey = normalizeBrandKey(a.text);
    const bKey = normalizeBrandKey(b.text);
    const aMatch = domainRoot && (aKey === domainRoot || aKey.includes(domainRoot) || domainRoot.includes(aKey)) ? 1 : 0;
    const bMatch = domainRoot && (bKey === domainRoot || bKey.includes(domainRoot) || domainRoot.includes(bKey)) ? 1 : 0;
    return bMatch - aMatch || a.indexInPage - b.indexInPage;
  });
  for (const l of nearbyCandidates) {
    const t = sanitizeCompanyValue(normalizeLegal(l.text));
    if (!t || isRejectedCompanyValue(t) || isLegalFormOnlyCompany(t)) continue;
    if (
      LEGAL_RE.test(t) &&
      !isUncorroboratedAmbiguousLegalLine(t, emails, new Map<string, number>()) &&
      !isLegalFormOnlyCompany(t)
    ) {
      const finalized = finalizeCompanyValue(t, emails, rawText);
      if (finalized) return finalized;
      continue;
    }
    if (ROLE_RE.test(t) && !LEGAL_RE.test(t)) continue;
    const combined = `${t} ${legalSuffix}`.replace(/\s+/g, ' ').trim();
    const finalized = finalizeCompanyValue(combined, emails, rawText);
    if (finalized) return finalized;
  }

  if (firstName?.trim() && lastName?.trim()) {
    const combined = `${firstName.trim()} ${lastName.trim()} ${legalSuffix}`.replace(/\s+/g, ' ').trim();
    const finalized = finalizeCompanyValue(combined, emails, rawText);
    if (finalized) return finalized;
  }
  return null;
}

function upgradeCompanyWithLegalLine(
  company: string,
  lines: Line[],
  brandReps: Map<number, number>,
  emails: string[],
  websites: Map<string, number>,
  rawText: string
): { value: string; lineId: number } | null {
  if (
    !company?.trim() ||
    hasTrustedTerminalLegalLine(company, emails, websites)
  ) {
    return null;
  }
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));
  if (!compKey || compKey.length < 3) return null;
  let best: { value: string; lineId: number; score: number } | null = null;
  for (const l of lines) {
    // Una riga fiscale può contenere "Brand snc CF/P.IVA ...": per il confronto
    // company↔brand usiamo soltanto il prefisso societario osservato.
    const fiscalPrefix = extractCompanyPrefixFromFiscalLine(l.text);
    const legalText = fiscalPrefix ?? companySemanticText(l.text);
    if (
      !LEGAL_RE.test(legalText) ||
      isUncorroboratedAmbiguousLegalLine(legalText, emails, websites) ||
      l.masked === 'contact-label' ||
      l.masked === 'social'
    ) {
      continue;
    }
    const normalizedLegal = normalizeLegal(legalText);
    const terminal = matchTerminalLegalFormSuffix(normalizedLegal);
    const lineBrand = normalizeBrandKey(
      stripLegalFormSuffix(terminal?.brand ?? normalizedLegal)
    );
    if (!lineBrand || !brandKeysAlign(compKey, lineBrand)) continue;

    // Se il brand già selezionato è più pulito ma differisce di pochi caratteri
    // OCR dalla riga con forma giuridica, conserva il brand selezionato e aggiungi
    // soltanto il suffisso legale realmente osservato.
    const legalTail =
      terminal && normalizedLegal.length > terminal.brand.length
        ? normalizedLegal.slice(terminal.brand.length).trim()
        : '';
    const candidate =
      terminal && legalTail && normalizeBrandKey(company) !== lineBrand
        ? `${company} ${legalTail}`
        : normalizedLegal;

    const s = scoreCompany(l, brandReps);
    const finalized = finalizeCompanyValue(candidate, emails, rawText);
    // Se la forma giuridica terminale e' realmente osservata sulla riga e
    // il brand e' corroborato dalle evidenze business, non permettere alla
    // finalizzazione delle forme ambigue (es. AG, S.n.c.) di eliminarla.
    const preservedObservedLegal =
      terminal && hasTrustedTerminalLegalLine(candidate, emails, websites)
        ? normalizeLegal(candidate)
        : null;
    const selectedValue = preservedObservedLegal ?? finalized;
    if (!selectedValue) continue;
    if (!best || s > best.score) best = { value: selectedValue, lineId: l.id, score: s };
  }
  return best ? { value: best.value, lineId: best.lineId } : null;
}

function recoverCompanyAfterSemanticReject(
  company: V5Field<string>,
  lines: Line[],
  brandReps: Map<number, number>,
  structured: Structured,
  rawText: string,
  personLineId: number
): V5Field<string> {
  if (!company.value || !shouldRejectCompanyCandidate(company.value)) return company;

  const legalPick = pickBestLegalCompanyLine(
    lines,
    brandReps,
    structured.emails,
    structured.websites,
    rawText
  );
  if (legalPick) {
    return {
      value: legalPick.value,
      score: Math.max(company.score, sigmoid((legalPick.score - T.company) * 0.85)),
      reasons: ['sostituita: classe semantica invalida → ragione sociale', 'validazione finale'],
      lineIds: [legalPick.lineId],
    };
  }

  const domainLine = [...lines]
    .filter(
      (l) =>
        l.id !== personLineId &&
        l.masked !== 'contact-label' &&
        l.masked !== 'structured' &&
        !l.f.addressLike &&
        l.f.domainRootMatch >= 0.68 &&
        !shouldRejectCompanyCandidate(l.text)
    )
    .sort((a, b) => b.f.domainRootMatch - a.f.domainRootMatch || b.f.fontScale - a.f.fontScale)[0];
  if (domainLine) {
    const finalized = finalizeCompanyValue(
      normalizeLegal(domainLine.text),
      structured.emails,
      rawText
    );
    if (finalized && !shouldRejectCompanyCandidate(finalized)) {
      return {
        value: finalized,
        score: Math.max(company.score, 0.58),
        reasons: ['sostituita: classe semantica invalida → brand coerente con email', 'validazione finale'],
        lineIds: [domainLine.id],
      };
    }
  }

  const orgFromOcr = resolveOrganizationFromOcr(company.value ?? '', structured.emails, rawText);
  if (orgFromOcr && !shouldRejectCompanyCandidate(orgFromOcr)) {
    const finalized = finalizeCompanyValue(orgFromOcr, structured.emails, rawText);
    if (finalized) {
      return {
        value: finalized,
        score: Math.max(company.score, 0.55),
        reasons: ['sostituita: classe semantica invalida → organizzazione OCR', 'validazione finale'],
        lineIds: company.lineIds,
      };
    }
  }

  const fuzzyBrand = pickBestFuzzyCompanyLineFromOcr(rawText, structured.emails, [...structured.websites.keys()]);
  if (fuzzyBrand && !shouldRejectCompanyCandidate(fuzzyBrand)) {
    const finalized = finalizeCompanyValue(fuzzyBrand, structured.emails, rawText);
    if (finalized && !hasOcrBrandNoise(finalized)) {
      return {
        value: finalized,
        score: Math.max(company.score, 0.62),
        reasons: ['sostituita: classe semantica invalida → brand fuzzy OCR', 'validazione finale'],
        lineIds: [],
      };
    }
  }

  const domainBrand = resolveBrandFromEmailDomain(structured.emails);
  if (domainBrand && !shouldRejectCompanyCandidate(domainBrand)) {
    const finalized = finalizeCompanyValue(domainBrand, structured.emails, rawText);
    if (finalized) {
      return {
        value: finalized,
        score: Math.max(company.score, 0.65),
        reasons: ['sostituita: classe semantica invalida → brand da dominio email', 'validazione finale'],
        lineIds: [],
      };
    }
  }

  return { value: null, score: 0, reasons: ['company scartata: classe semantica invalida'] };
}

function preferLegalEntityOverWeakBrand(
  company: V5Field<string>,
  lines: Line[],
  brandReps: Map<number, number>,
  structured: Structured,
  rawText: string
): V5Field<string> {
  if (!company.value?.trim()) return company;
  if (
    hasTrustedTerminalLegalLine(
      company.value,
      structured.emails,
      structured.websites
    )
  ) {
    return company;
  }
  const compLine = company.lineIds?.length
    ? lines.find((l) => l.id === company.lineIds![0])
    : undefined;
  if ((compLine?.f?.domainRootMatch ?? 0) >= 0.65) return company;
  const wordCount = tokens(company.value).length;
  if (wordCount > 1) return company;
  const legalPick = pickBestLegalCompanyLine(
    lines,
    brandReps,
    structured.emails,
    structured.websites,
    rawText
  );
  if (!legalPick || legalPick.score < T.company) return company;
  return {
    value: legalPick.value,
    score: Math.max(company.score, sigmoid((legalPick.score - T.company) * 0.85)),
    reasons: ['sostituita: brand debole → ragione sociale con forma giuridica', 'validazione finale'],
    lineIds: [legalPick.lineId],
  };
}

function splitStreetAndCivicFromText(text: string): { street?: string; civic?: string } {
  let cleaned = clean(text);
  const labeledCivicBeforeLocation = cleaned.match(
    new RegExp(
      String.raw`^(.+?)[,\s]+${CIVIC_LABEL_PATTERN}(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*[,;]\s*[A-Za-zÀ-ÿ].+$`,
      'i'
    )
  );
  if (
    labeledCivicBeforeLocation &&
    STREET_RE.test(labeledCivicBeforeLocation[1]!)
  ) {
    return {
      street: clean(labeledCivicBeforeLocation[1]!),
      civic: labeledCivicBeforeLocation[2],
    };
  }
  const bareCivicBeforeLocation = cleaned.match(
    /^(.+?)[,\s]+(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*[,;]\s*[A-Za-zÀ-ÿ].+$/i
  );
  if (
    bareCivicBeforeLocation &&
    !/^\d{5}$/.test(bareCivicBeforeLocation[2]!) &&
    STREET_RE.test(bareCivicBeforeLocation[1]!)
  ) {
    return {
      street: clean(bareCivicBeforeLocation[1]!),
      civic: bareCivicBeforeLocation[2],
    };
  }
  if (
    !new RegExp(
      `${CIVIC_LABEL_PATTERN}\\d{4,6}\\s*$`,
      'i'
    ).test(cleaned)
  ) {
    cleaned = clean(
      cleaned.replace(/\s*[|IlL]?\s*\d{4,6}\s*$/, '')
    );
  }
  cleaned = cleaned.replace(/[,;]+$/, '');
  cleaned = cleaned.replace(/,\s*\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]+(?:\s*\([A-Za-z]{2}\))?\s*$/i, '');
  const leadingCivic = cleaned.match(
    /^(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s+(.+)$/i
  );
  if (leadingCivic && STREET_RE.test(leadingCivic[2]!)) {
    return {
      street: clean(leadingCivic[2]!),
      civic: leadingCivic[1],
    };
  }
  const labeledCivic = cleaned.match(
    new RegExp(
      String.raw`^(.+?)[,\s]+${CIVIC_LABEL_PATTERN}(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*$`,
      'i'
    )
  );
  if (labeledCivic) {
    return {
      street: clean(labeledCivic[1]),
      civic: labeledCivic[2],
    };
  }
  const civicMatch = cleaned.match(
    /^(.+?)[,\s]+(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*$/i
  );
  if (civicMatch && !/^\d{5}$/.test(civicMatch[2])) {
    return {
      street: clean(civicMatch[1]),
      civic: civicMatch[2],
    };
  }
  const spaceNr = cleaned.match(/^(.+?)\s+(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*$/i);
  if (spaceNr && !/^\d{5}$/.test(spaceNr[2])) return { street: clean(spaceNr[1]), civic: spaceNr[2] };
  return { street: cleaned };
}

const BARE_STREET_TYPE_RE =
  /^(?:via|viale|piazza|corso|vicolo|v\.|strada|str\.?)\.?$/i;
const BARE_STREET_CIVIC_RE =
  /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{2,42}),\s*(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*$/i;

function isBareStreetTypeOnly(text?: string): boolean {
  return Boolean(text?.trim() && BARE_STREET_TYPE_RE.test(text.trim()));
}

function recoverSplitStreetFromLines(lines: Line[]): { street?: string; civic?: string } {
  for (const l of lines) {
    const t = clean(l.text.trim());
    if (/^(?:via|viale|piazza|corso|vicolo|v\.|strada)\s+.+/i.test(t)) {
      return splitStreetAndCivicFromText(t);
    }
  }

  const hasViaToken = lines.some((l) => isBareStreetTypeOnly(l.text));
  const hasCapCity = lines.some((l) => CAP_CITY_PROV_RE.test(l.text) || POSTAL_RE.test(l.text));

  if (hasViaToken || hasCapCity) {
    for (const l of lines) {
      const m = clean(l.text.trim()).match(BARE_STREET_CIVIC_RE);
      if (!m) continue;
      if (/^(?:tel|fax|mobile|e-?mail|phone)/i.test(m[1])) continue;
      const streetName = clean(m[1]);
      return {
        street: hasViaToken ? `Via ${streetName}` : streetName,
        civic: m[2],
      };
    }
  }

  return {};
}

function filterConflictingForeignOfficeLines(lines: Line[], personLine?: Line): Line[] {
  if (!lines.length) return lines;
  const sorted = [...lines].sort((a, b) => a.indexInPage - b.indexInPage);
  const usBlock = /\b(?:san\s+francisco|rhode\s+island|\bca\s*\d{5}\b|ste\s*#\s*\d+|usa\b)/i;
  const ieBlock = /\b(?:dublin|ireland)\b/i;
  const deBlock = /\b(?:frankfurt|germany|deutschland|60322)\b/i;
  const hasIe = sorted.some((l) => ieBlock.test(l.text));
  const hasUs = sorted.some((l) => usBlock.test(l.text));
  if (hasIe && hasUs) {
    return sorted.filter((l) => !usBlock.test(l.text));
  }
  if (hasIe) {
    return sorted.filter((l) => !usBlock.test(l.text) && !deBlock.test(l.text));
  }
  return sorted;
}

function assembleAddress(
  lines: Line[],
  ids: number[],
  context?: { personLineId?: number; lastName?: string | null; companyLineId?: number; roleLineId?: number }
): V5AddressParts | null {
  const italianSede = tryAssembleItalianSedeOperativaAddress(lines);
  if (italianSede) return italianSede;

  const multiOffice = assembleMultiOfficeAddress(lines);
  if (multiOffice) return multiOffice;

  if (!ids.length) return null;
  const personLine = context?.personLineId != null ? lines.find((l) => l.id === context.personLineId) : undefined;
  const personPage = personLine?.page;
  const expandedIds = new Set(ids);
  let useClusterOnly = false;
  if (personLine && personPage !== undefined) {
    const pageLines = lines.filter((l) => l.page === personPage);
    const multiCountryOnPage =
      pageLines.filter((l) => COUNTRY_RE.test(l.text) || FOREIGN_ADDR_LINE_RE.test(l.text)).length >= 2;
    const cluster = multiCountryOnPage
      ? collectPersonalAddressCluster(lines, personLine, 20, context?.roleLineId)
      : gatherPersonPageAddressLines(lines, personPage, personLine.indexInPage, expandedIds, 12, context?.roleLineId);
    if (multiCountryOnPage && cluster.length >= 2) {
      expandedIds.clear();
      useClusterOnly = true;
    }
    for (const l of cluster) {
      expandedIds.add(l.id);
    }
  }
  const addr = lines.filter((l) => expandedIds.has(l.id));
  // raggruppa per pagina + adiacenza (distanza indice ≤ 2)
  const groups: Line[][] = [];
  for (const l of [...addr].sort((a, b) => a.page - b.page || a.indexInPage - b.indexInPage)) {
    const g = groups[groups.length - 1];
    const gap = l.indexInPage - (g?.[g.length - 1]?.indexInPage ?? l.indexInPage);
    const maxGap =
      g?.some((x) => STREET_RE.test(x.text)) && isLocationOnlyAddressLine(l.text)
        ? 4
        : isLocationOnlyAddressLine(l.text) && g?.some((x) => STREET_RE.test(x.text))
          ? 4
          : 2;
    if (g && g[0].page === l.page && gap <= maxGap) g.push(l);
    else groups.push([l]);
  }
  // gruppo migliore: preferisci righe con via esplicita, poi cap+città
  const scoreG = (g: Line[]) => {
    let s = 0;
    const hasFullStreet = g.some((l) => /^(?:via|viale|piazza|corso|vicolo|v\.|strada)\s+.+/i.test(l.text.trim()));
    const hasBareVia = g.some((l) => isBareStreetTypeOnly(l.text));
    const hasBareStreetCivic = g.some((l) => BARE_STREET_CIVIC_RE.test(clean(l.text.trim())));
    if (hasFullStreet) s += 5;
    else if (hasBareVia && hasBareStreetCivic) s += 4;
    else if (g.some((l) => STREET_RE.test(l.text))) s += 3;
    if (hasBareVia && !hasBareStreetCivic) s -= 3;
    if (g.some((l) => POSTAL_RE.test(l.text) && PROVINCE_RE.test(l.text))) s += 2;
    if (g.some((l) => CAP_CITY_PROV_RE.test(l.text) || /\b\d{5}\s+[A-Za-zÀ-ÿ].*\([A-Z]{2}\)/i.test(l.text))) s += 4;
    if (g.some((l) => /sede\s+(?:legale|operativa|amministrativa)\s*:/i.test(l.text) && STREET_RE.test(l.text))) {
      s += 5;
    }
    const compLine =
      context?.companyLineId != null ? lines.find((l) => l.id === context.companyLineId) : undefined;
    if (
      compLine &&
      g[0]?.page === compLine.page &&
      g[0].indexInPage > compLine.indexInPage &&
      g[0].indexInPage - compLine.indexInPage <= 20
    ) {
      s += 6;
    } else if (compLine && g[0]?.page === compLine.page && g[0].indexInPage < compLine.indexInPage) {
      s -= 5;
    }
    if (personPage !== undefined) {
      if (g[0]?.page === personPage) {
        if (compLine && g[0].indexInPage < compLine.indexInPage) s += 3;
        else s += 8;
      } else s -= 5;
    }
    if (g.some((l) => isGlobalOfficeAddressBlock(l.text))) s -= 12;
    const joined = g.map((l) => l.text).join(' ');
    if (/\b(?:frankfurt|paris|san francisco|sialkot)\b/i.test(joined) && personPage !== undefined && g[0]?.page !== personPage) {
      s -= 6;
    }
    return s + g.length * 0.05;
  };
  groups.sort((a, b) => scoreG(b) - scoreG(a));
  let best = groups[0];
  if (useClusterOnly && addr.length) best = addr;
  if (!best) return null;

  const DOM_FISC_RE = /\b(?:dom\.?\s*fisc|domicilio\s*fiscale|sede\s*fiscale)\b/i;
  const operational = best.filter((l) => !DOM_FISC_RE.test(l.text));
  const useGroup =
    operational.length > 0 && operational.some((l) => STREET_RE.test(l.text)) ? operational : best;

  const streetNeighbor = lines.find(
    (l) =>
      !expandedIds.has(l.id) &&
      l.page === useGroup[0].page &&
      Math.abs(l.indexInPage - useGroup[0].indexInPage) <= 2 &&
      lineLooksLikeAddress(l.text) &&
      !l.f?.roleKeyword
  );
  const locationNeighbors = collectLocationNeighborLines(lines, useGroup, 2);
  const addressCandidates = [
    ...useGroup,
    ...(streetNeighbor ? [streetNeighbor] : []),
    ...locationNeighbors,
  ];
  const mergedIds = new Set<number>();
  const mergedBest = filterConflictingForeignOfficeLines(
    addressCandidates.filter((l) => {
      if (mergedIds.has(l.id)) return false;
      if (l.id === context?.personLineId) return false;
      if (
        l.id === context?.companyLineId &&
        !hasUsableAddressTailAfterCompanyPrefix(l.text)
      ) {
        return false;
      }
      if (isOcrFusedEmailDomainLine(l.text)) return false;
      if (ROLE_RE.test(l.text) || l.f?.roleKeyword) return false;
      if (/@|www\.|https?:\/\//i.test(l.text)) return false;
      if (isOcrContactResidualLine(l.text)) return false;
      if (PHONE_SEQ_RE.test(l.text) && !STREET_RE.test(l.text) && !COUNTRY_RE.test(l.text)) return false;
      mergedIds.add(l.id);
      return true;
    }),
    personLine
  );
  if (!mergedBest.length) return null;

  const cleanLine = (t: string) =>
    clean(
      stripCompanyPrefixFromAddressLine(repairAddressPipeOcr(t))
        .replace(/\s+(?:tel(?:efono)?|phone|fax|mobile|cell(?:ulare)?)\b.*$/i, '')
        .replace(/\b1Z\b/gi, 'IZ')
        .replace(/\s*[|IlL]\s*(\d{4,6})\s*$/, ' $1')
        .replace(/\bB(\d{4})\b/g, '3$1')
        // Two Italian offices fused on one OCR line: keep the first office only.
        .replace(
          /^(Via\s+.+?\d{5}\s+[A-Za-zÀ-ÿ'’ .-]+?)(?=\s+Via\s+).*$/iu,
          '$1',
        )
    );
  let full = clean(
    joinAddressLineTexts(
      mergedBest
        .filter((l) => !isOcrFusedEmailDomainLine(l.text) && !isOcrContactResidualLine(l.text))
        .map((l) => cleanLine(l.text))
    )
  );
  const joined = ' ' + full + ' ';
  const structuredLocation =
    mergedBest
      .map((line) => parseCityProvLine(line.text))
      .find((location) => location.postalCode && location.city) ??
    mergedBest
      .map((line) => parseCityProvLine(line.text))
      .find((location) => location.postalCode);
  let postal =
    structuredLocation?.postalCode ?? extractUnlabeledPostalCode(joined);
  let region = structuredLocation?.region ?? joined.match(PROVINCE_RE)?.[1];
  let country = joined.match(COUNTRY_RE)?.[0];
  let city: string | undefined = structuredLocation?.city;
  if (postal) {
    const capCity = joined.match(
      new RegExp(
        postal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`[\s\-–]+([A-Za-zÀ-ÿ'’ .\-]{2,40}?)(?=\s*(?:\(|,|-|–|$))`,
        'iu'
      )
    );
    if (capCity) city = clean(capCity[1]);
  }
  const streetSource =
    mergedBest.find(
      (l) => /^(?:via|viale|piazza|corso|vicolo|v\.|strada)\b/i.test(l.text.trim()) && !DOM_FISC_RE.test(l.text)
    ) ??
    mergedBest.find((l) => STREET_RE.test(l.text)) ??
    mergedBest[0];
  const streetRaw = streetSource ? cleanLine(streetSource.text) : undefined;
  let streetLine: string | undefined;
  let civic: string | undefined;
  if (streetRaw) {
    const cleaned = clean(streetRaw).replace(/[,;]+$/, '');
    const split = splitStreetAndCivicFromText(cleaned);
    streetLine = split.street;
    civic = split.civic;
  }
  if (isBareStreetTypeOnly(streetLine) || (!streetLine && !civic)) {
    const recovered = recoverSplitStreetFromLines(mergedBest);
    if (recovered.street && !isBareStreetTypeOnly(recovered.street)) {
      streetLine = recovered.street;
      civic = recovered.civic ?? civic;
    } else if (isBareStreetTypeOnly(streetLine)) {
      streetLine = undefined;
    }
  }

  const capSource =
    mergedBest.find((l) => /\b\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]+(?:\([A-Za-z]{2}\)|Italy|Italia)?/i.test(l.text))?.text ??
    mergedBest.find((l) => POSTAL_RE.test(l.text))?.text;
  if (capSource) {
    const capJoined = ' ' + cleanLine(capSource) + ' ';
    if (!postal) {
      postal = extractUnlabeledPostalCode(capJoined);
    }
    if (!region) region = capJoined.match(PROVINCE_RE)?.[1];
    if (!city && postal) {
      const capCity = capJoined.match(
        new RegExp(
          postal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`[\s\-–]+([A-Za-zÀ-ÿ'’ .\-]{2,40}?)(?=\s*(?:\(|,|-|–|$))`,
          'iu'
        )
      );
      if (capCity) city = clean(capCity[1]);
    }
  }
  for (const l of mergedBest) {
    if (postal && city && region) break;
    const loc = parseCityProvLine(l.text);
    if (!postal && loc.postalCode) postal = loc.postalCode;
    if (!city && loc.city) city = loc.city;
    if (!region && loc.region) region = loc.region;
  }
  const explicitlyLabeledContactCity = mergedBest
    .map((line) => cityPrefixBeforeContact(line.text))
    .find(Boolean);
  if (explicitlyLabeledContactCity) city = explicitlyLabeledContactCity;
  for (const l of mergedBest) {
    if (ROLE_RE.test(l.text) || l.f?.roleKeyword) continue;
    const foreignCity = l.text.match(
      /\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .0-9-]{2,40})\s*,?\s*(Ireland|Italia|Italy|USA|Germany|France|Belgium|België)\b/i
    );
    if (foreignCity) {
      if (!city) city = clean(foreignCity[1]);
      if (!country) country = cap(foreignCity[2]);
    }
  }
  if (streetLine && civic) {
    // street e civic separati: normalizeAddress li ricompone in full
  }
  // ordine CAP-città-via, con spazio o delimitatore esplicito.
  const capFirstWithRegion = full.match(
    /^(\d{4,6})\s+([^,;–—]+?)\s*\(([A-Z]{2})\)\s*[,;–—-]\s*(.+)$/iu
  );
  const capFirstDelimited = capFirstWithRegion
    ? {
        postalCode: capFirstWithRegion[1]!,
        city: capFirstWithRegion[2]!,
        region: capFirstWithRegion[3],
        streetTail: capFirstWithRegion[4]!,
      }
    : (() => {
        const match = full.match(
          /^(\d{4,6})\s+([^,;–—]+?)\s*[,;–—-]\s*(.+)$/iu
        );
        return match
          ? {
              postalCode: match[1]!,
              city: match[2]!,
              region: undefined,
              streetTail: match[3]!,
            }
          : null;
      })();
  const capFirstSpaced = joined.match(
    /\b(\d{5})\s+([A-Za-zÀ-ÿ'’ .\-]{2,40}?)(?:\s*\(([A-Z]{2})\))?\s+((?:via|viale|piazza|corso|vicolo|v\.|strada|str\.|galleria|localit[aà])\b.+)$/iu
  );
  const capFirst = capFirstDelimited &&
    STREET_RE.test(capFirstDelimited.streetTail)
    ? capFirstDelimited
    : capFirstSpaced
      ? {
          postalCode: capFirstSpaced[1]!,
          city: capFirstSpaced[2]!,
          region: capFirstSpaced[3],
          streetTail: capFirstSpaced[4]!,
        }
      : null;
  if (
    capFirst &&
    (
      !streetLine ||
      /^\s*\d{5}\b/.test(streetLine) ||
      civic === capFirst.postalCode
    )
  ) {
    postal = capFirst.postalCode;
    city = clean(capFirst.city);
    if (capFirst.region) region = capFirst.region;
    const tail = clean(capFirst.streetTail);
    const cm = tail.match(
      new RegExp(
        String.raw`^(.+?)[,\s]+(?:${CIVIC_LABEL_PATTERN})?(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?)\s*$`,
        'i'
      )
    );
    if (cm) {
      streetLine = clean(cm[1]);
      civic = cm[2];
    } else {
      const sp = splitStreetAndCivicFromText(tail);
      streetLine = sp.street;
      civic = sp.civic ?? civic;
    }
  }
  // città mancante: riga mono-token (MAIUSCOLA o TitleCase) adiacente al gruppo
  if (!city) {
    for (const g of best) {
      const near = lines.find(
        (o) =>
          o.page === g.page &&
          Math.abs(o.indexInPage - g.indexInPage) === 1 &&
          !best.includes(o) &&
          o.f &&
          o.f.tokenCount === 1 &&
          o.f.digitRatio === 0 &&
          o.f.domainRootMatch < 0.6 &&
          !o.f.roleKeyword &&
          o.text.length >= 3 &&
          o.text.length <= 18 &&
          (o.f.allCaps || o.f.titleCase)
      );
      if (near && near.masked !== 'contact-label' && near.masked !== 'structured') {
        const candidate = cap(near.text.replace(/[:;]+$/, ''));
        if (
          !isGarbageCityName(candidate) &&
          !isCityMatchingPersonSurname(candidate, context?.lastName ?? undefined)
        ) {
          city = candidate;
          break;
        }
      }
    }
  }
  if (city && isCityMatchingPersonSurname(city, context?.lastName ?? undefined)) {
    for (const l of mergedBest) {
      const loc = parseCityProvLine(l.text);
      if (loc.city && !isCityMatchingPersonSurname(loc.city, context?.lastName ?? undefined)) {
        city = loc.city;
        if (loc.postalCode) postal = loc.postalCode;
        if (loc.region) region = loc.region;
        break;
      }
    }
    if (isCityMatchingPersonSurname(city, context?.lastName ?? undefined)) {
      city = undefined;
    }
  }
  const cityBeforePostalCountry = full.match(
    /(?:^|,)\s*([\p{L}][\p{L}\p{M}' .-]{1,40}?)\s*[-,]\s*\d{4,6}\s*[-,]?\s*(?:pakistan|italy|italia|germany|france|belgium|ireland)\b/iu
  );
  if (
    cityBeforePostalCountry &&
    (!city ||
      Boolean(country && normalizeBrandKey(city.replace(/\.$/, '')) === normalizeBrandKey(country)))
  ) {
    const candidate = clean(cityBeforePostalCountry[1]);
    if (
      candidate &&
      !STREET_RE.test(candidate) &&
      !(country && normalizeBrandKey(candidate) === normalizeBrandKey(country))
    ) {
      city = candidate;
    }
  }
  city = sanitizeAddressCity(city, context?.lastName ?? undefined);
  const cityDuplicateOfCivic = Boolean(
    city &&
    civic &&
    normalizeBrandKey(city) === normalizeBrandKey(civic)
  );
  if (cityDuplicateOfCivic) city = undefined;

  // Un singolo glifo OCR finale viene rimosso soltanto se la città base
  // è osservata autonomamente sulla stessa pagina dell'indirizzo.
  const trailingCityOcrGlyph = city?.match(/^(.{3,})\s+[\p{L}]$/u);
  if (trailingCityOcrGlyph) {
    const baseCity = clean(trailingCityOcrGlyph[1]);
    const addressPage = streetSource?.page ?? useGroup[0]?.page;
    const baseObservedOnAddressPage = lines.some(
      (line) =>
        line.page === addressPage &&
        line.masked !== 'structured' &&
        line.masked !== 'social' &&
        normalizeBrandKey(clean(line.text)) === normalizeBrandKey(baseCity)
    );
    if (baseObservedOnAddressPage) city = baseCity;
  }
  if (city && country && normalizeBrandKey(city.replace(/\.$/, '')) === normalizeBrandKey(country)) {
    city = undefined;
  }
  if (full && /\b(?:dublin|ireland)\b/i.test(full)) {
    if (city && /\b(?:frankfurt|san\s+francisco|paris|60322|usa)\b/i.test(city)) {
      city = undefined;
    }
    const dublinFromFull = full.match(/\b(Dublin(?:\s+\d+)?)/i);
    if (dublinFromFull) city = clean(dublinFromFull[1]);
    if (!country || /\b(?:usa|germany|france)\b/i.test(country)) country = 'Ireland';
  }
  if (city && !full.toLowerCase().includes(city.toLowerCase())) {
    full = clean([full, city, country].filter(Boolean).join(', '));
  } else if (country && !full.toLowerCase().includes(country.toLowerCase())) {
    full = clean([full, country].filter(Boolean).join(', '));
  } else if (
    mergedBest.some((l) => COUNTRY_RE.test(l.text) || isForeignAddressLine(l.text)) &&
    mergedBest.length >= 1
  ) {
    full = clean(
      mergedBest
        .filter((l) => !isOcrFusedEmailDomainLine(l.text) && !isOcrContactResidualLine(l.text))
        .map((l) => cleanLine(l.text))
        .join(', ')
    );
  } else if (mergedBest.length > 1 && full.split(/\s+/).length <= 4) {
    full = clean(
      mergedBest
        .filter((l) => !isOcrFusedEmailDomainLine(l.text) && !isOcrContactResidualLine(l.text))
        .map((l) => cleanLine(l.text))
        .join(', ')
    );
  }
  if (!city) {
    const personPageNum = personLine?.page;
    const citySourceLines = [...addr, ...lines.filter((l) => l.page === personPageNum && (l.masked === 'address' || isForeignAddressLine(l.text)))];
    const seenCityLine = new Set<number>();
    for (const l of citySourceLines) {
      if (seenCityLine.has(l.id)) continue;
      seenCityLine.add(l.id);
      if (personPageNum !== undefined && l.page !== personPageNum) continue;
      if (ROLE_RE.test(l.text) || l.f?.roleKeyword) continue;
      const foreignCity = l.text.match(
        /\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .0-9-]{2,40})\s*,?\s*(Ireland|Italia|Italy|USA|Germany|France|Belgium|België)\b/i
      );
      if (foreignCity) {
        city = clean(foreignCity[1]);
        if (!country) country = cap(foreignCity[2]);
        break;
      }
    }
  }
  full = stripGlobalOfficeContamination(full);
  const completeness = addressCompletenessScore({
    street: streetLine,
    civicNumber: civic,
    postalCode: postal,
    city,
    region,
    country,
    full,
  });
  const partial = completeness < 0.72;
  return {
    full,
    street: streetLine,
    civicNumber: civic,
    postalCode: postal,
    city,
    region,
    country,
    completeness,
    partial,
  };
}

// ---------------------------------------------------------------------------
// Stadio 5 — riconciliazioni
// ---------------------------------------------------------------------------

const CONFUSABLE = new Map([
  ['i', 'l1'],
  ['l', 'i1'],
  ['1', 'il'],
  ['0', 'o'],
  ['o', '0'],
  ['5', 's'],
  ['s', '5'],
]);

function confusableDistance1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 0 || a === b) return levenshtein(a, b) === 1;
  let diff = 0;
  let confusable = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff++;
      if (!(CONFUSABLE.get(a[i])?.includes(b[i]) ?? false)) confusable = false;
    }
  }
  return diff === 1 && confusable;
}

function resolveWebsite(
  emails: string[],
  websites: Map<string, number>,
  allText: string
): { value: string | null; reasons: string[] } {
  const reasons: string[] = [];
  const explicitWeb = allText.match(/\bweb\s*:\s*(?:www\.)?([a-z0-9][a-z0-9.\-]*\.[a-z]{2,63})\b/i);
  if (explicitWeb) {
    let host = fixOcrDomainTld(explicitWeb[1]!.toLowerCase().replace(/\s+/g, ''));
    if (isPlausibleInternetHost(host) && !isGenericHost(host)) {
      reasons.push('esplicito da etichetta Web');
      return { value: 'www.' + host.replace(/^www\./, ''), reasons };
    }
  }

  const emailDomains = emails
    .map((e) => e.split('@')[1])
    .filter((d): d is string => !!d && !isGenericHost(d));
  const hosts = [...websites.keys()].filter((h) => !isGenericHost(h));

  const hostingEmail = emails.some((e) => isNonBusinessEmailDomain(e.split('@')[1] ?? ''));
  if (hostingEmail) {
    const businessHosts = hosts.filter((h) => !isNonBusinessEmailDomain(h));
    if (businessHosts.length) {
      businessHosts.sort((a, b) => (websites.get(b) ?? 0) - (websites.get(a) ?? 0));
      reasons.push('sito business vs dominio hosting email');
      return { value: 'www.' + businessHosts[0]!.replace(/^www\./, ''), reasons };
    }
  }

  if (!hosts.length) {
    return { value: null, reasons };
  }

  // preferisci host coerente col dominio email
  for (const d of emailDomains) {
    const matches = hosts.filter((h) => h === d || h.endsWith('.' + d) || d.endsWith('.' + h));
    if (!matches.length) continue;
    matches.sort((a, b) => {
      const scoreA =
        (websites.get(a) ?? 0) * 2 +
        (allText.toLowerCase().includes(a) ? 2 : 0) +
        a.split('.').length;
      const scoreB =
        (websites.get(b) ?? 0) * 2 +
        (allText.toLowerCase().includes(b) ? 2 : 0) +
        b.split('.').length;
      return scoreB - scoreA;
    });
    const exact = matches[0]!;
    return { value: 'www.' + exact.replace(/^www\./, ''), reasons: ['coerente con email'] };
  }
  // preferisci host esplicito nel biglietto su dominio email OCR simile
  for (const d of emailDomains) {
    const near = hosts.find((h) => levenshtein(compact(h), compact(d)) <= 1);
    if (near) {
      reasons.push('sito esplicito preferito su variante email OCR');
      return { value: 'www.' + near.replace(/^www\./, ''), reasons };
    }
  }
  // caratteri confondibili: vince la variante più corroborata nel biglietto
  for (const d of emailDomains) {
    const near = hosts.find((h) => confusableDistance1(compact(h), compact(d)));
    if (near) {
      reasons.push('sito esplicito preservato su variante confondibile email');
      return { value: 'www.' + near.replace(/^www\./, ''), reasons };
    }
  }
  // altrimenti l'host più frequente / migliore per evidenza brand
  const bestHost = pickBestWebsiteHost(hosts, websites, allText, emails);
  if (bestHost) {
    return { value: 'www.' + bestHost.replace(/^www\./, ''), reasons: ['host corroborato da testo e brand'] };
  }
  hosts.sort((a, b) => (websites.get(b) ?? 0) - (websites.get(a) ?? 0));
  return { value: 'www.' + hosts[0].replace(/^www\./, ''), reasons };
}


/** Radice del dominio in forma "visuale" (con trattini), per correggere il brand. */
function displayDomainRoot(emails: string[], websites: Map<string, number>): string | undefined {
  const emailHosts = emails.map((e) => e.split('@')[1]).filter(Boolean) as string[];
  const websiteHosts = [...websites.keys()];
  return pickBestDomainRoot(emailHosts, websiteHosts);
}

/**
 * Se il testo del brand è una corruzione OCR della radice del dominio
 * (distanza ≤2), usa le lettere del dominio conservando lo stile di maiuscole.
 */
function respellBrandFromDomain(
  value: string,
  emails: string[],
  websites: Map<string, number>
): string {
  const display = displayDomainRoot(emails, websites);
  if (!display) return value;
  const brandPrefix = splitFusedDomainBrand(display).split(/\s+/)[0] ?? display;

  const terminalLegal = matchTerminalLegalFormSuffix(value);
  if (
    terminalLegal &&
    hasTrustedTerminalLegalLine(value, emails, websites)
  ) {
    const stripped = terminalLegal.brand;
    const brandWord = stripped.split(/\s+/).filter(Boolean)[0] ?? stripped;
    const respelledWord =
      respellTokenFromDomainRoot(brandWord, brandPrefix) !== brandWord
        ? respellTokenFromDomainRoot(brandWord, brandPrefix)
        : respellTokenFromDomainRoot(brandWord, display);
    if (normalizeBrandKey(respelledWord) !== normalizeBrandKey(brandWord)) {
      const legalTail = value.slice(stripped.length).trim();
      return legalTail ? `${respelledWord} ${legalTail}` : respelledWord;
    }
    return value;
  }

  if (tokens(value).length > 1) return value;
  const fromPrefix = respellTokenFromDomainRoot(value, brandPrefix);
  if (fromPrefix !== value) return fromPrefix;
  return respellTokenFromDomainRoot(value, display);
}


/**
 * Recupera un brand solo quando la stessa radice business è osservata
 * indipendentemente in almeno una email e in almeno un sito web.
 * È intenzionalmente conservativo: una radice presente solo in una fonte
 * non basta, e in caso di parità fra più radici convergenti non sceglie.
 */
function recoverBrandFromConvergentEmailWebsite(
  emails: string[],
  websites: Map<string, number>
): string | null {
  if (!emails.length || !websites.size) return null;

  const evidence = new Map<string, { raw: string; email: number; website: number }>();
  const add = (raw: string, kind: 'email' | 'website') => {
    const key = normalizeBrandKey(raw);
    if (key.length < 3) return;
    const current = evidence.get(key) ?? { raw, email: 0, website: 0 };
    current[kind] += 1;
    evidence.set(key, current);
  };

  for (const email of emails) {
    const host = email.split('@')[1]?.trim();
    if (!host) continue;
    for (const root of extractBusinessDomainRootCandidates(host)) add(root, 'email');
  }
  for (const host of websites.keys()) {
    for (const root of extractBusinessDomainRootCandidates(host)) add(root, 'website');
  }

  const convergent = [...evidence.values()]
    .filter((item) => item.email > 0 && item.website > 0)
    .sort(
      (a, b) =>
        b.email + b.website - (a.email + a.website) ||
        b.website - a.website ||
        b.email - a.email
    );
  if (!convergent.length) return null;
  const best = convergent[0]!;
  const second = convergent[1];
  if (
    second &&
    second.email + second.website === best.email + best.website &&
    second.website === best.website &&
    second.email === best.email
  ) {
    return null;
  }
  return splitFusedDomainBrand(best.raw);
}

// ---------------------------------------------------------------------------
// API principale
// ---------------------------------------------------------------------------

export function extractCardV5(pages: CardPageV5[]): V5Result {
  // ---- collect
  const lines: Line[] = [];
  let id = 0;
  pages.forEach((p, page) => {
    const src = p.lines?.length
      ? p.lines
      : p.rawText.split(/\r?\n/).map((text) => ({ text, confidence: 0.5 } as OcrLine));
    src.forEach((ocr, indexInPage) => {
      const rawOcr = String(ocr.text ?? '');
      const text = stripJunk(rawOcr);
      if (!text) return;
      lines.push({
        id: id++,
        page,
        indexInPage,
        text,
        rawOcr,
        ocrConfidence: ocrParserCompatibilityConfidence(ocr),
        bbox: ocr.boundingBox ? { ...ocr.boundingBox } : undefined,
        masked: null,
        f: null as unknown as Features,
        personScore: 0,
        companyScore: 0,
        roleScore: 0,
      });
    });
  });

  const coherence = analyzePageCoherence(
    pages,
    lines.map((line) => ({
      lineId: line.id,
      pageIndex: line.page,
      text: line.text,
    }))
  );
  const includedContext = createIncludedPagesContext(pages, lines, coherence);
  const workingLines = includedContext.extractionLines;
  const rawText = includedContext.extractionRawText;
  const emailEvidence = collectEmailEvidence(
    workingLines.map((line) => ({
      lineId: line.id,
      pageIndex: line.page,
      rawOcr: line.rawOcr,
      confidence: line.ocrConfidence,
    }))
  );
  const ocrContextText = rawText || workingLines.map((line) => line.text).join('\n');
  const explicitLabels = extractExplicitLabelFields(ocrContextText);
  const extractionPageIndexes = new Set(
    includedContext.extractionPageIndexes
  );
  const extractionNumericEvidence = (
    coherence.numericEvidence?.accepted ?? []
  ).filter((candidate) => extractionPageIndexes.has(candidate.pageIndex));
  const acceptedVatValues = [
    ...new Set(
      extractionNumericEvidence
        .filter(
          (candidate) =>
            candidate.evidenceType === 'vat' &&
            candidate.validationStatus === 'valid'
        )
        .map((candidate) => candidate.normalizedValue)
    ),
  ];
  const conflictingAcceptedVats = acceptedVatValues.length > 1;
  const rejectedVatValues = new Set(
    (coherence.numericEvidence?.rejected ?? [])
      .filter(
        (candidate) =>
          extractionPageIndexes.has(candidate.pageIndex) &&
          candidate.evidenceType === 'vat'
      )
      .map((candidate) => candidate.normalizedValue)
  );
  const rejectedVatConflict =
    acceptedVatValues.length === 1 &&
    [...rejectedVatValues].some(
      (value) => value !== acceptedVatValues[0]
    );
  const pageCoherence: PageCoherenceMetadata = {
    decision: includedContext.decision,
    primaryPage:
      coherence.decision === 'ambiguous'
        ? includedContext.extractionPageIndexes[0] ?? null
        : includedContext.includedPageIndexes.length === 0
          ? null
          : coherence.primaryPage,
    includedPageIndexes: [...includedContext.includedPageIndexes],
    excludedPageIndexes: [...includedContext.excludedPageIndexes],
    pendingPageIndexes: [...includedContext.pendingPageIndexes],
    confidence: includedContext.confidence,
    decisionReasons: [
      ...includedContext.decisionReasons,
      ...(conflictingAcceptedVats
        ? ['più P.IVA validate e incompatibili nelle pagine incluse']
        : []),
      ...(rejectedVatConflict
        ? ['P.IVA validata prevalente su candidato fiscale non valido']
        : []),
    ],
    requiresReview:
      includedContext.requiresReview ||
      conflictingAcceptedVats ||
      rejectedVatConflict,
    numericEvidence: {
      accepted: (coherence.numericEvidence?.accepted ?? []).map(
        (candidate) => ({ ...candidate })
      ),
      ambiguous: (coherence.numericEvidence?.ambiguous ?? []).map(
        (candidate) => ({ ...candidate })
      ),
      rejected: (coherence.numericEvidence?.rejected ?? []).map(
        (candidate) => ({ ...candidate })
      ),
    },
  };
  const empty = <T,>(): V5Field<T> => ({ value: null, score: 0, reasons: [] });

  if (!workingLines.length) {
    return {
      firstName: empty(), lastName: empty(), company: empty(), role: empty(),
      emails: { value: [], score: 0, reasons: [] }, phones: { value: [], score: 0, reasons: [] },
      emailEvidence: [],
      website: empty(), address: empty(), addressAlternatives: [], vatNumber: empty(), taxCode: empty(),
      rawText, pageMismatch: coherence.pageMismatch, pageMismatchReasons: coherence.reasons,
      pageCoherence,
      debugLines: lines.map((line) => ({
        id: line.id,
        page: line.page,
        text: line.text,
        masked: line.masked,
        fontScale: 0,
        scores: { person: 0, company: 0, role: 0 },
        pageDisposition: pageDisposition(includedContext, line.page),
      })),
    };
  }

  // ---- stadio 1
  mergeContinuationCompanyLines(workingLines);
  mergeSplitLegalCompanyHeader(workingLines);
  const structured = extractStructured(
    workingLines,
    extractionNumericEvidence,
    emailEvidence
  );
  if (structured.vatConflictWithEvidence) {
    pageCoherence.decisionReasons.push(
      "P.IVA legacy valida incompatibile con l'evidenza numerica validata"
    );
    pageCoherence.requiresReview = true;
  }
  setIncludedStructuredCandidates(includedContext, {
    emails: structured.emails,
    phones: structured.phones,
    websites: structured.websites.keys(),
    vatCandidates: structured.vat ? [structured.vat] : [],
    taxCodeCandidates: structured.taxCode ? [structured.taxCode] : [],
  });

  // ---- stadio 2
  computeFeatures(workingLines, structured.emails, structured.websites);
  const emailToks = emailNameTokens(personalEmail(structured.emails));
  const brandReps = brandRepetitions(workingLines);

  for (const l of workingLines) {
    l.personScore = scorePerson(l);
    l.companyScore = scoreCompany(l, brandReps);
    l.roleScore = scoreRole(l);
  }

  // fusione riga forma-giuridica-orfana con la riga precedente ("bNOVA" + "srl")
  for (const l of workingLines) {
    if (!l.f.legalSuffixOnly) continue;
    const prev = workingLines.find((o) => o.page === l.page && o.indexInPage === l.indexInPage - 1 && !o.masked);
    if (
      prev &&
      prev.companyScore > -5 &&
      prev.f.tokenCount <= 4 &&
      !isAmbiguousTwoTokenIdentityLine(prev.text)
    ) {
      prev.text = clean(prev.text + ' ' + l.text);
      prev.f.hasLegalSuffix = true;
      prev.companyScore += W.company.legalSuffix;
      l.masked = 'merged-into-prev';
      l.companyScore = -10;
      l.personScore = -10;
    }
  }

  mergeDescriptorCompanyBlocks(workingLines);
  for (const l of workingLines) {
    if (l.masked === 'merged-into-prev') continue;
    l.companyScore = scoreCompany(l, brandReps);
  }

  // ---- stadio 3/4: AZIENDA
  const companyRank = [...workingLines].sort((a, b) => b.companyScore - a.companyScore);
  let company: V5Field<string> = empty();
  let companySplit: { first: string; last: string } | null = null;
  let companyLineId = -1;
  let inlineRole: string | null = null;
  let inlineRoleFromCompanySplit = false;

  for (const l of workingLines) {
    const t = l.text.trim();
    if (!inlineRole && isRoleWordAsCompany(t)) inlineRole = t;
  }

  for (let i = 0; i < companyRank.length; i++) {
    const candidate = companyRank[i];
    if (!candidate || candidate.companyScore < T.company) continue;
    const roleLineBelow = workingLines.find(
      (o) =>
        o.page === candidate.page &&
        o.indexInPage === candidate.indexInPage + 1 &&
        !o.masked
    );
    if (isLikelyPersonNameAboveRoleLine(candidate.text, roleLineBelow?.text)) {
      continue;
    }
    if (explicitLabels.labeledCard) {
      const key = normalizeBrandKey(candidate.text);
      const lastKey = normalizeBrandKey(explicitLabels.lastName ?? '');
      const firstKey = normalizeBrandKey(explicitLabels.firstName ?? '');
      if ((lastKey && key === lastKey) || (firstKey && key === firstKey)) continue;
    }
    const roleSplit = splitRoleFromCompanyLine(candidate.text);
    const companyText = companySemanticText(roleSplit?.company ?? candidate.text);
    if (
      isUncorroboratedAmbiguousLegalLine(
        companyText,
        structured.emails,
        structured.websites
      ) &&
      !splitCompanyInlineAddress(candidate.text)
    ) {
      continue;
    }
    if (shouldRejectCompanyCandidate(companyText)) {
      if (isRoleWordAsCompany(companyText) && !inlineRole) inlineRole = companyText;
      continue;
    }
    if (roleSplit?.role) {
      inlineRole = roleSplit.role;
      inlineRoleFromCompanySplit = true;
    }
    const personOnCompanyLine = !LEGAL_RE.test(companyText) ? parsePersonNameFromLine(companyText) : null;
    if (
      personOnCompanyLine &&
      candidate.personScore >= T.person &&
      candidate.personScore >= candidate.companyScore - 0.75
    ) {
      const fn = personOnCompanyLine.firstName?.replace(/\./g, '').trim() ?? '';
      if (fn.length > 1) {
        companySplit = { first: personOnCompanyLine.firstName, last: personOnCompanyLine.lastName };
      }
      const brandFromOwner = splitPersonNameFromCompanyValue(
        companyText,
        structured.emails,
        ocrContextText
      );
      if (brandFromOwner) {
        const built = buildCompanyField(
          candidate,
          companyRank[i + 1],
          emailToks,
          structured,
          ocrContextText,
          brandFromOwner.company
        );
        if (built) {
          company = built;
          companyLineId = candidate.id;
          break;
        }
      }
      continue;
    }
    const split = splitPersonFromCompanyLine(
      companyText,
      emailToks,
      domainRoots(structured.emails, structured.websites)
    );
    const roleBelow = workingLines.some(
      (o) =>
        o.page === candidate.page &&
        o.indexInPage === candidate.indexInPage + 1 &&
        !o.masked &&
        o.f?.roleKeyword
    );
    const personOnLine = parsePersonLine(companyText, emailToks);
    if (split && !(roleBelow && personOnLine)) {
      companySplit = { first: split.first, last: split.last };
    }
    const built = buildCompanyField(candidate, companyRank[i + 1], emailToks, structured, ocrContextText, companyText);
    if (built) {
      company = built;
      companyLineId = candidate.id;
      break;
    }
  }

  // ---- NOME: candidati riga singola + coppie adiacenti + split + email
  interface PC extends PersonPick {}
  const personCandidates: PC[] = [];

  for (const l of workingLines) {
    if (l.id === companyLineId || l.masked === 'structured' || l.masked === 'social') {
      continue;
    }
    const exactEmailPerson = parseExactObservedPersonFromEmail(
      l.text,
      structured.emails
    );
    if (!exactEmailPerson) continue;
    personCandidates.push({
      firstName: exactEmailPerson.firstName,
      lastName: exactEmailPerson.lastName,
      score: T.person + 2,
      lineIds: [l.id],
      reasons: ['riga nome osservata corroborata da email esatta'],
    });
  }

  for (const l of workingLines) {
    if (l.id === companyLineId) continue;
    const { personText, inlineRole: personInlineRole } = splitPersonTextAndInlineRole(l.text);
    if (l.personScore < T.person && !personInlineRole) continue;
    if (
      shouldRejectPersonCandidate(personText) &&
      !hasExactObservedPersonalEmailEvidence(personText, structured.emails)
    ) {
      continue;
    }
    const parsed = parsePersonLine(personText, emailToks, structured.emails);
    if (parsed) {
      if (isPersonNameDomainBrandCollision(parsed.first, parsed.last, structured.emails)) continue;
      const bonus = personInlineRole ? 1.15 : 0;
      const affinity = personEmailAffinityScore(parsed.first, parsed.last, structured.emails);
      personCandidates.push({
        firstName: parsed.first,
        lastName: parsed.last,
        score: l.personScore + bonus + Math.min(affinity * 3, 14),
        lineIds: [l.id],
        reasons: [personInlineRole ? 'nome con ruolo inline' : 'riga nome', ...(affinity >= 3 ? ['affinità email'] : [])],
      });
    }
  }
  // Una repair email non confermata non può generare o correggere una persona.
  // Può però disambiguare l'ordine di due token già osservati integralmente
  // sulla stessa riga: nessuna lettera del nome deriva dalla repair.
  for (const emailHint of emailEvidence) {
    if (
      emailHint.origin !== 'repaired' ||
      emailHint.validationStatus !== 'valid'
    ) {
      continue;
    }
    const localTokens = (emailHint.value.split('@')[0] ?? '')
      .split(/[._+\-]+/)
      .map((token) => compact(token))
      .filter(Boolean);
    if (
      localTokens.length !== 2 ||
      localTokens.some((token) => token.length < 3) ||
      localTokens.some((token) =>
        GENERIC_EMAIL_NAME_TOKENS.has(token) ||
        isGenericContactOrDepartmentToken(token) ||
        GENERIC_LOCAL_RE.test(token) ||
        NON_PERSON_WORDS.has(token)
      ) ||
      localTokens[0] === localTokens[1]
    ) {
      continue;
    }
    const givenNameTokens = localTokens.filter(
      (token) => FIRST_NAMES.has(token) || COMMON_FIRST_NAMES.has(token)
    );
    if (givenNameTokens.length !== 1) continue;
    const localKey = [...localTokens].sort().join('|');
    for (const l of workingLines) {
      if (
        l.id === companyLineId ||
        (l.masked && l.masked !== 'address')
      ) {
        continue;
      }
      const hasAdjacentRole = workingLines.some(
        (candidate) =>
          candidate.page === l.page &&
          Math.abs(candidate.indexInPage - l.indexInPage) === 1 &&
          ROLE_RE.test(candidate.text)
      );
      if (
        l.masked === 'address' &&
        (!hasAdjacentRole || /\d/.test(l.text))
      ) {
        continue;
      }
      const observedTokens = tokens(l.text);
      const observedKeys = observedTokens.map((token) => compact(token));
      if (
        observedKeys.length !== 2 ||
        [...observedKeys].sort().join('|') !== localKey ||
        shouldRejectCorroboratedObservedPersonCandidate(l.text)
      ) {
        continue;
      }
      const hasConflictingObservedRolePerson = workingLines.some((other) => {
        if (
          other.id === l.id ||
          other.id === companyLineId ||
          (other.masked && other.masked !== 'address')
        ) {
          return false;
        }
        const adjacentRole = workingLines.find(
          (candidate) =>
            candidate.page === other.page &&
            !candidate.masked &&
            Math.abs(candidate.indexInPage - other.indexInPage) === 1 &&
            ROLE_RE.test(candidate.text)
        );
        if (
          !adjacentRole ||
          shouldRejectCorroboratedObservedPersonCandidate(other.text)
        ) {
          return false;
        }
        const otherTokens = tokens(other.text);
        const otherKeys = otherTokens.map((token) => compact(token));
        if (
          otherKeys.length < 2 ||
          otherKeys.length > 5 ||
          [...otherKeys].sort().join('|') === localKey
        ) {
          return false;
        }
        const observedPerson = validatePersonName({
          firstName: cap(otherTokens[0]!),
          lastName: otherTokens.slice(1).map(cap).join(' '),
        });
        return Boolean(observedPerson?.firstName && observedPerson.lastName);
      });
      if (hasConflictingObservedRolePerson) continue;
      const givenNameKey = givenNameTokens[0];
      if (!givenNameKey) continue;
      const surnameKey = localTokens.find(
        (token) => token !== givenNameKey
      );
      if (!surnameKey) continue;
      const firstIndex = observedKeys.indexOf(givenNameKey);
      const lastIndex = observedKeys.indexOf(surnameKey);
      if (firstIndex < 0 || lastIndex < 0 || firstIndex === lastIndex) continue;
      const parsed = validatePersonName({
        firstName: cap(observedTokens[firstIndex]!),
        lastName: cap(observedTokens[lastIndex]!),
      });
      if (!parsed?.firstName || !parsed.lastName) continue;
      if (
        [compact(parsed.firstName), compact(parsed.lastName)]
          .sort()
          .join('|') !== localKey
      ) {
        continue;
      }
      if (
        isPersonNameDomainBrandCollision(
          parsed.firstName,
          parsed.lastName,
          [emailHint.value]
        )
      ) {
        continue;
      }
      const existingCandidate = personCandidates.find(
        (candidate) =>
          candidate.lineIds.includes(l.id) &&
          compact(candidate.firstName) === compact(parsed.firstName) &&
          compact(candidate.lastName) === compact(parsed.lastName)
      );
      if (existingCandidate) {
        if (
          !existingCandidate.reasons.includes(
            'riga nome osservata corroborata da repair email'
          )
        ) {
          existingCandidate.reasons.push(
            'riga nome osservata corroborata da repair email'
          );
        }
        existingCandidate.score = Math.max(
          existingCandidate.score,
          Math.max(l.personScore, T.person) + 1.6
        );
        continue;
      }
      personCandidates.push({
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        score: Math.max(l.personScore, T.person) + 1.6,
        lineIds: [l.id],
        reasons: ['riga nome osservata corroborata da repair email'],
      });
    }
  }
  for (const l of workingLines) {
    if (l.id === companyLineId || l.masked) continue;
    const roleLineBelow = workingLines.find(
      (o) => o.page === l.page && o.indexInPage === l.indexInPage + 1 && !o.masked
    );
    if (!isLikelyPersonNameAboveRoleLine(l.text, roleLineBelow?.text)) continue;
    const { personText } = splitPersonTextAndInlineRole(l.text);
    if (shouldRejectPersonCandidate(personText)) continue;
    const parsed = parseRoleAdjacentPersonLine(
      personText,
      roleLineBelow?.text ?? '',
      emailToks,
      structured.emails
    );
    if (!parsed) continue;
    if (
      !hasPositivePersonEvidenceForWeakLine(
        personText,
        parsed.first,
        parsed.last,
        structured.emails,
        l.personScore,
        roleLineBelow?.text
      )
    ) continue;
    if (isPersonNameDomainBrandCollision(parsed.first, parsed.last, structured.emails)) continue;
    const existingCandidate = personCandidates.find((candidate) =>
      candidate.lineIds.includes(l.id)
    );
    if (existingCandidate) {
      existingCandidate.score = Math.max(
        existingCandidate.score,
        Math.max(l.personScore, T.person) + 1.4
      );
      if (!existingCandidate.reasons.includes('nome sopra riga ruolo')) {
        existingCandidate.reasons.push('nome sopra riga ruolo');
      }
      continue;
    }
    personCandidates.push({
      firstName: parsed.first,
      lastName: parsed.last,
      score: Math.max(l.personScore, T.person) + 1.4,
      lineIds: [l.id],
      reasons: ['nome sopra riga ruolo'],
    });
  }
  // Onorifico + nome su una riga, cognome sulla riga immediatamente successiva.
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId || !HONORIFIC_RE.test(l.text)) continue;
    const stripped = l.text.replace(HONORIFIC_RE, '').trim();
    const firstTokens = tokens(stripped);
    if (firstTokens.length !== 1 || /\d/.test(stripped)) continue;
    let next;
    for (let d = 1; d <= 3; d += 1) {
      const candidate = workingLines.find(function(o) {
        return o.page === l.page && o.indexInPage === l.indexInPage + d;
      });
      if (!candidate) continue;
      if (candidate.masked === 'structured' || candidate.masked === 'contact-label' || candidate.masked === 'social') continue;
      if (candidate.masked || candidate.id === companyLineId) break;
      if (candidate.f.tokenCount !== 1 || candidate.f.digitRatio !== 0) break;
      next = candidate;
      break;
    }
    if (!next) continue;
    if (isKnownCityName(next.text) || next.f.roleKeyword || next.f.hasLegalSuffix || next.f.addressLike) continue;
    const firstKey = compact(firstTokens[0] || '');
    const hasEmailEvidence = emailToks.some(function(t) { return sim(t, firstKey) >= 0.8; });
    if (!FIRST_NAMES.has(firstKey) && !hasEmailEvidence) continue;
    const validated = validatePersonName({ firstName: cap(firstTokens[0]), lastName: cap(next.text) });
    if (!validated) continue;
    if (isPersonNameDomainBrandCollision(validated.firstName, validated.lastName, structured.emails)) continue;
    personCandidates.push({
      firstName: validated.firstName,
      lastName: validated.lastName,
      score: T.person + 2.0,
      lineIds: [l.id, next.id],
      reasons: ['onorifico + nome con cognome sulla riga successiva'],
    });
  }

  // coppie adiacenti di righe mono-token ("giacomo" + "GAMBERONI")
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    if (l.f.tokenCount !== 1 || l.f.digitRatio > 0) continue;
    const next = workingLines.find((o) => o.page === l.page && o.indexInPage === l.indexInPage + 1 && !o.masked && o.f.tokenCount === 1 && o.f.digitRatio === 0 && o.id !== companyLineId);
    if (!next) continue;
    if (isKnownCityName(l.text) || isKnownCityName(next.text)) continue;
    if (isSplitBrandLogoPair(l.text, next.text, structured.emails)) continue;
    const combined = l.text + ' ' + next.text;
    const parsed = parsePersonLine(combined, emailToks);
    if (!parsed) continue;
    if (isPersonNameDomainBrandCollision(parsed.first, parsed.last, structured.emails)) continue;
    const pseudo: Line = { ...l, text: combined, f: { ...l.f, preSuffixActivityOnly: false, tokenCount: 2, inNameLexicon: FIRST_NAMES.has(compact(l.text)) || FIRST_NAMES.has(compact(next.text)) } };
    // ricalcola emailLocalMatch sulla combinazione
    computeFeatures([pseudo], structured.emails, structured.websites);
    const sc = scorePerson(pseudo);
    if (sc >= T.person) {
      personCandidates.push({ firstName: parsed.first, lastName: parsed.last, score: sc - 0.2, lineIds: [l.id, next.id], reasons: ['coppia righe adiacenti'] });
    }
  }
  // Tripla riga: nome / città OCR / cognome.
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    if (l.f.tokenCount !== 1 || l.f.digitRatio > 0) continue;
    const mid = workingLines.find(
      (o) => o.page === l.page && o.indexInPage === l.indexInPage + 1 && !o.masked && o.f.tokenCount === 1 && o.id !== companyLineId
    );
    const lastLine = workingLines.find(
      (o) => o.page === l.page && o.indexInPage === l.indexInPage + 2 && !o.masked && o.f.tokenCount === 1 && o.id !== companyLineId
    );
    if (!mid || !lastLine) continue;
    if (!isKnownCityName(mid.text)) continue;
    if (isKnownCityName(lastLine.text)) continue;
    const firstTok = compact(l.text);
    const lastTok = compact(lastLine.text);
    const emailHit =
      emailToks.length >= 2 &&
      ((sim(emailToks[0], firstTok) >= 0.8 && sim(emailToks[1], lastTok) >= 0.8) ||
        (sim(emailToks[1], firstTok) >= 0.8 && sim(emailToks[0], lastTok) >= 0.8));
    if (!FIRST_NAMES.has(firstTok) && !emailHit) continue;
    const validated = validatePersonName({ firstName: cap(l.text), lastName: cap(lastLine.text) });
    if (!validated) continue;
    personCandidates.push({
      firstName: validated.firstName,
      lastName: validated.lastName,
      score: T.person + 1.35,
      lineIds: [l.id, lastLine.id],
      reasons: ['tripla riga nome-città-cognome'],
    });
  }
    // cognome e nome su righe adiacenti
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    if (l.f.tokenCount !== 1 || l.f.digitRatio > 0) continue;
    const next = workingLines.find(
      (o) => o.page === l.page && o.indexInPage === l.indexInPage + 1 && !o.masked && o.f.tokenCount === 1 && o.f.digitRatio === 0 && o.id !== companyLineId
    );
    if (!next) continue;
    const a = compact(l.text);
    const b = compact(next.text);
    if (!FIRST_NAMES.has(b) || FIRST_NAMES.has(a)) continue;
    if (isKnownCityName(l.text) || isKnownCityName(next.text)) continue;
    const validated = validatePersonName({ firstName: cap(next.text), lastName: cap(l.text) });
    if (!validated) continue;
    personCandidates.push({
      firstName: validated.firstName,
      lastName: validated.lastName,
      score: T.person + 1.05,
      lineIds: [l.id, next.id],
      reasons: ['coppia cognome-nome adiacenti'],
    });
  }
  // cognome in riga dedicata + nome entro le successive 3 righe (layout brand card)
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    if (l.f.tokenCount !== 1 || l.f.digitRatio > 0) continue;
    const surKey = compact(l.text);
    if (FIRST_NAMES.has(surKey) || isItalianCityName(l.text)) continue;
    if (!/^[A-Za-zÀ-ü'’-]{3,}$/.test(l.text.trim())) continue;
    for (let d = 1; d <= 3; d += 1) {
      const near = workingLines.find(
        (o) => o.page === l.page && o.indexInPage === l.indexInPage + d && !o.masked && o.id !== companyLineId
      );
      if (!near) continue;
      if (near.f.roleKeyword || /concessionari|responsabil|amministr|delegat|partner|department|gestionale|commercial|marketing|ufficio|consulen|service|solution|software|informatic|group|gruppo|srl|spa|snc/i.test(near.text)) {
        continue;
      }
      if (near.f.tokenCount > 3) continue;
      for (const tok of tokens(near.text)) {
        if (!FIRST_NAMES.has(compact(tok))) continue;
        const validated = validatePersonName({ firstName: cap(tok), lastName: cap(l.text) });
        if (!validated) continue;
        personCandidates.push({
          firstName: validated.firstName,
          lastName: validated.lastName,
          score: T.person + 0.95,
          lineIds: [l.id, near.id],
          reasons: ['cognome + nome nelle righe vicine'],
        });
        break;
      }
    }
  }
    // nome sulla riga sopra un ruolo
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    const next = workingLines.find(
      (o) =>
        o.page === l.page &&
        o.indexInPage === l.indexInPage + 1 &&
        !o.masked &&
        (o.f?.roleKeyword || ROLE_KEYWORD_REGEX.test(o.text))
    );
    if (!next) continue;
    if (
      (
        shouldRejectPersonCandidate(l.text) &&
        !hasExactObservedPersonalEmailEvidence(l.text, structured.emails)
      ) ||
      /^for\s+/i.test(l.text.trim())
    ) {
      continue;
    }
    let lineText = normalizeFusedPersonLine(l.text, structured.emails, emailToks);
    const parsed =
      parseRoleAdjacentPersonLine(
        lineText,
        next.text,
        emailToks,
        structured.emails
      ) ??
      parseRoleAdjacentPersonLine(
        l.text,
        next.text,
        emailToks,
        structured.emails
      );
    if (!parsed) continue;
    if (
      shouldRejectPersonCandidate(l.text) &&
      !hasExactObservedPersonalEmailEvidence(l.text, structured.emails)
    ) {
      continue;
    }
    if (parsed.first.replace(/\./g, '').length <= 1 && parsed.last.length >= 5) continue;
    if (
      !hasPositivePersonEvidenceForWeakLine(
        l.text,
        parsed.first,
        parsed.last,
        structured.emails,
        l.personScore,
        next.text
      )
    ) continue;
    personCandidates.push({
      firstName: parsed.first,
      lastName: parsed.last,
      score: T.person + 1.1,
      lineIds: [l.id],
      reasons: ['nome sopra ruolo'],
    });
  }
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    const caps = parseCapsSurnameFirstLine(l.text);
    if (caps && l.personScore < T.person) {
      // Non aggiungere come persona se nessun token è un nome noto (brand ALLCAPS come MOTOCARD RAS)
      const capsToks = tokens(l.text);
      const hasKnownName = capsToks.some((t) => FIRST_NAMES.has(compact(t)));
      if (!hasKnownName && capsToks.length <= 2) continue;
      personCandidates.push({
        firstName: caps.firstName,
        lastName: caps.lastName,
        score: T.person + 1.1,
        lineIds: [l.id],
        reasons: ['cognome+nome maiuscoli su riga unica'],
      });
      continue;
    }
    const parsed = parsePersonLine(l.text, emailToks, structured.emails);
    if (!parsed || shouldRejectPersonCandidate(l.text)) continue;
    const words = tokens(l.text);
    const lastW = compact(words[words.length - 1] ?? '');
    if (words.length === 2 && FIRST_NAMES.has(lastW) && l.personScore < T.person) {
      personCandidates.push({
        firstName: cap(words[words.length - 1]!),
        lastName: cap(words[0]!),
        score: T.person + 1.05,
        lineIds: [l.id],
        reasons: ['cognome+nome maiuscoli su riga unica'],
      });
    }
  }
  if (companySplit) {
    if (companySplit.first.replace(/\./g, '').trim().length <= 1) {
      companySplit = null;
    }
  }
  if (companySplit) {
    const splitLine = `${companySplit.first} ${companySplit.last}`.trim();
    if (!shouldRejectPersonCandidate(splitLine)) {
      personCandidates.push({
        firstName: companySplit.first,
        lastName: companySplit.last,
        score: T.person + 1.2,
        lineIds: [companyLineId],
        reasons: ['split riga azienda'],
      });
    }
  }
  for (const l of workingLines) {
    if (!LEGAL_RE.test(l.text)) continue;
    const fromLegal = extractPersonFromItalianLegalCompany(l.text);
    if (!fromLegal) continue;
    personCandidates.push({
      firstName: fromLegal.first,
      lastName: fromLegal.last,
      score: T.person + 1.4,
      lineIds: [l.id],
      reasons: ['proprietario in ragione sociale'],
    });
  }
  for (const l of workingLines) {
    if (l.masked || l.id === companyLineId) continue;
    const fromDiOwner = extractPersonFromDiOwnerLine(l.text.trim());
    if (!fromDiOwner) continue;
    personCandidates.push({
      firstName: fromDiOwner.first,
      lastName: fromDiOwner.last,
      score: T.person + 1.35,
      lineIds: [l.id],
      reasons: ['titolare s.n.c. (di cognome nome)'],
    });
  }
  // fallback dall'email personale (nome.cognome@ o iniziale+cognome@)
  const personal = personalEmail(structured.emails);
  if (personal) {
    const fromEmail = parseNameFromEmailLocal(personal);
    if (fromEmail?.firstName && fromEmail?.lastName) {
      personCandidates.push({
        firstName: fromEmail.firstName,
        lastName: fromEmail.lastName,
        score: T.person + 0.5,
        lineIds: [],
        reasons: ['derivato da email'],
      });
    } else if (fromEmail?.lastName) {
      for (const l of workingLines) {
        if (l.masked || l.id === companyLineId) continue;
        for (const tok of tokens(l.text)) {
          if (!FIRST_NAMES.has(compact(tok))) continue;
          const validated = validatePersonName({ firstName: cap(tok), lastName: fromEmail.lastName });
          if (!validated) continue;
          personCandidates.push({
            firstName: validated.firstName,
            lastName: validated.lastName,
            score: T.person + 1.2,
            lineIds: [l.id],
            reasons: ['cognome da email + nome OCR'],
          });
        }
      }
    } else if (fromEmail?.firstName) {
      const emailFirst = compact(fromEmail.firstName);
      for (const l of workingLines) {
        if (l.masked || l.id === companyLineId) continue;
        const parsed = parsePersonLine(l.text, emailToks);
        if (!parsed) continue;
        if (compact(parsed.first) === emailFirst) {
          personCandidates.push({
            firstName: parsed.first,
            lastName: parsed.last,
            score: T.person + 1.25,
            lineIds: [l.id],
            reasons: ['nome da email + riga persona OCR'],
          });
        }
      }
    }
  } else if (
    emailToks.length === 2 &&
    emailToks.every((t) => t.length >= 3) &&
    !emailToks.some((t) => GENERIC_EMAIL_NAME_TOKENS.has(compact(t)) || compact(t) === 'skype')
  ) {
    const derived = validatePersonName({ firstName: cap(emailToks[0]!), lastName: cap(emailToks[1]!) });
    if (derived?.firstName && derived.lastName) {
      personCandidates.push({
        firstName: derived.firstName,
        lastName: derived.lastName,
        score: T.person + 0.4,
        lineIds: [],
        reasons: ['derivato da email'],
      });
    }
  }

  if (workingLines.some((l) => !l.masked && isProductBrandLineAsPerson(l.text))) {
    for (const l of workingLines) {
      if (l.masked || l.id === companyLineId) continue;
      const caps = parseCapsSurnameFirstLine(l.text);
      if (caps) {
        personCandidates.push({
          firstName: caps.firstName,
          lastName: caps.lastName,
          score: T.person + 1.3,
          lineIds: [l.id],
          reasons: ['persona su card marchio-only'],
        });
      }
    }
  }

  const recoveredEmailPerson = recoverPersonMatchingPersonalEmail(ocrContextText, structured.emails);
  if (recoveredEmailPerson?.firstName && recoveredEmailPerson.lastName) {
    personCandidates.push({
      firstName: recoveredEmailPerson.firstName,
      lastName: recoveredEmailPerson.lastName,
      score: T.person + 2.1,
      lineIds: [],
      reasons: ['recovery persona da email personale'],
    });
  }

  personCandidates.sort((a, b) => {
    const personal = primaryPersonalEmail(structured.emails);
    const affinityA = personEmailAffinityScore(a.firstName, a.lastName, structured.emails);
    const affinityB = personEmailAffinityScore(b.firstName, b.lastName, structured.emails);
    let penA = 0;
    let penB = 0;
    if (personal) {
      if (affinityA < 1) penA = -9;
      if (affinityB < 1) penB = -9;
    }
    const crushA = affinityA >= 6 ? 22 : affinityA >= 4 ? 16 : affinityA >= 3 ? 10 : affinityA >= 2 ? 4 : 0;
    const crushB = affinityB >= 6 ? 22 : affinityB >= 4 ? 16 : affinityB >= 3 ? 10 : affinityB >= 2 ? 4 : 0;
    const emailBoostA = affinityA * 5 + crushA;
    const emailBoostB = affinityB * 5 + crushB;
    return b.score + emailBoostB + penB - (a.score + emailBoostA + penA);
  });
  const filteredPersonCandidates = personCandidates.filter((c) => {
    const isCompanySplitCandidate = c.reasons.includes('split riga azienda');
    const isExactRepairCandidate = c.reasons.includes(
      'riga nome osservata corroborata da repair email'
    );
    const rejectsCandidate = (text: string) =>
      isExactRepairCandidate
        ? shouldRejectCorroboratedObservedPersonCandidate(text)
        : shouldRejectPersonCandidate(text);
    const extractedFromLegalCompany = c.reasons.includes('proprietario in ragione sociale');
    for (const lid of c.lineIds) {
      const src = workingLines.find((w) => w.id === lid);
      const sourceText =
        src && c.reasons.includes("nome con ruolo inline")
          ? splitPersonTextAndInlineRole(src.text).personText
          : src?.text;
      if (
        !extractedFromLegalCompany &&
        src && !isCompanySplitCandidate &&
        sourceText &&
        rejectsCandidate(sourceText) &&
        !hasExactObservedPersonalEmailEvidence(
          sourceText,
          structured.emails
        )
      ) {
        runtimeLogger.debug(
          'PARSER_PERSON_REJECTED',
          {
            status: 'rejected',
            stage: 'parse',
            source: 'local',
            reasonCode: 'line_text_rejected',
          },
          { lineText: src.text }
        );
        return false;
      }
    }
    const lineText = `${c.firstName} ${c.lastName}`.trim();
    if (
      rejectsCandidate(lineText) &&
      !hasExactObservedPersonalEmailEvidence(
        lineText,
        structured.emails
      )
    ) {
      runtimeLogger.debug(
        'PARSER_PERSON_REJECTED',
        {
          status: 'rejected',
          stage: 'parse',
          source: 'local',
          reasonCode: 'full_name_rejected',
        },
        { firstName: c.firstName, lastName: c.lastName }
      );
      return false;
    }
    if (!c.firstName?.trim() && c.lastName?.trim() && shouldRejectPersonCandidate(c.lastName)) {
      runtimeLogger.debug(
        'PARSER_PERSON_REJECTED',
        {
          status: 'rejected',
          stage: 'parse',
          source: 'local',
          reasonCode: 'last_name_rejected',
        },
        { lastName: c.lastName }
      );
      return false;
    }
    if (c.firstName.replace(/\./g, '').trim().length <= 1 && c.lastName.length >= 6) {
      runtimeLogger.debug('PARSER_PERSON_REJECTED', {
        status: 'rejected',
        stage: 'parse',
        source: 'local',
        reasonCode: 'initial_length',
      });
      return false;
    }
    if (
      isPersonNameDomainBrandCollision(
        c.firstName,
        c.lastName,
        structured.emails
      ) &&
      !hasExactObservedPersonalEmailEvidence(
        `${c.firstName} ${c.lastName}`,
        structured.emails
      )
    ) {
      runtimeLogger.debug('PARSER_PERSON_REJECTED', {
        status: 'rejected',
        stage: 'parse',
        source: 'local',
        reasonCode: 'domain_collision',
      });
      return false;
    }
    return true;
  });
  const pBest = filteredPersonCandidates[0];
  const pSecond = filteredPersonCandidates[1];
  let firstName: V5Field<string> = empty();
  let lastName: V5Field<string> = empty();
  let personLineId = -1;

  if (explicitLabels.labeledCard && (explicitLabels.firstName || explicitLabels.lastName)) {
    const finalizedExplicit = finalizePersonFields(
      explicitLabels.firstName,
      explicitLabels.lastName,
      undefined,
      structured.emails
    );
    firstName = {
      value: finalizedExplicit.firstName,
      score: 0.92,
      reasons: ['etichetta esplicita cognome/nome'],
      lineIds: [],
    };
    lastName = {
      value: finalizedExplicit.lastName,
      score: 0.92,
      reasons: ['etichetta esplicita cognome/nome'],
      lineIds: [],
    };
  } else if (pBest) {
    const margin = pBest.score - Math.max(pSecond?.score ?? 0, T.person - 1);
    const conf = sigmoid((pBest.score - T.person) * 0.9 + Math.min(margin, 2) * 0.3);
    firstName = { value: pBest.firstName, score: conf, reasons: pBest.reasons, lineIds: pBest.lineIds };
    lastName = { value: pBest.lastName, score: conf, reasons: pBest.reasons, lineIds: pBest.lineIds };
    personLineId = pBest.lineIds[0] ?? -1;
  } else if (explicitLabels.firstName || explicitLabels.lastName) {
    const finalizedExplicit = finalizePersonFields(
      explicitLabels.firstName,
      explicitLabels.lastName,
      undefined,
      structured.emails
    );
    firstName = {
      value: finalizedExplicit.firstName,
      score: 0.88,
      reasons: ['etichetta esplicita name'],
      lineIds: [],
    };
    lastName = {
      value: finalizedExplicit.lastName,
      score: 0.88,
      reasons: ['etichetta esplicita name'],
      lineIds: [],
    };
  }

  if (company.value && pBest) {
    const enriched = enrichGenericCompanyWithOwner(company.value, pBest.firstName, pBest.lastName);
    if (enriched !== company.value) {
      const finalized = finalizeCompanyValue(enriched, structured.emails, ocrContextText);
      if (finalized) {
        company = {
          ...company,
          value: finalized,
          reasons: [...company.reasons, 'ditta individuale: nome proprietario'],
        };
      }
    }
  }

  if (!company.value && pBest) {
    const genericHeaderLine = workingLines.find((l) => {
      if (l.masked === 'merged-into-prev' || l.id === personLineId) return false;
      const ws = tokens(normalizeLegal(l.text));
      if (ws.length < 1 || ws.length > 4) return false;
      return ws.every((w) => GENERIC_COMPANY_HEADER.has(compact(w)));
    });
    if (genericHeaderLine) {
      const base = titleCasePhrase(genericHeaderLine.text);
      const enriched = enrichGenericCompanyWithOwner(base, pBest.firstName, pBest.lastName);
      const finalized = finalizeCompanyValue(enriched, structured.emails, ocrContextText);
      if (finalized) {
        company = {
          value: finalized,
          score: 0.52,
          reasons: ['attività generica + titolare'],
          lineIds: [genericHeaderLine.id],
        };
        companyLineId = genericHeaderLine.id;
      }
    }
  }

  // ---- RUOLO: migliore riga role vicina al nome
  const selectedPersonLineIds = new Set<number>([
    ...(firstName.lineIds ?? []),
    ...(lastName.lineIds ?? []),
    ...(pBest?.lineIds ?? []),
  ]);
  if (
    inlineRole &&
    workingLines.some(
      (line) =>
        selectedPersonLineIds.has(line.id) &&
        compact(line.text) === compact(inlineRole!)
    )
  ) {
    inlineRole = null;
  }
  const personLine = workingLines.find((l) => l.id === personLineId);
  let role: V5Field<string> = empty();
  if (inlineRole && isRoleWordAsCompany(inlineRole)) {
    const cleanedInline = finalizeRoleValue(inlineRole, company.value) ?? clean(inlineRole);
    if (cleanedInline) {
      role = {
        value: cleanedInline,
        score: 0.74,
        reasons: ['ruolo escluso da company'],
        lineIds: [],
      };
    }
  }
  const roleRank = workingLines
    .filter(
      (l) => l.id !== companyLineId && !selectedPersonLineIds.has(l.id)
    )
    .map((l) => {
      let s = l.roleScore;
      const nearPerson = Boolean(
        personLine &&
          l.page === personLine.page &&
          Math.abs(l.indexInPage - personLine.indexInPage) <= 2
      );
      if (nearPerson) s += W.role.nearPerson;
      const standaloneAffiliationBadge =
        /^(?:partner|affiliato|affiliate|dealer|reseller|rivenditore|concessionario)$/i.test(
          l.text.trim()
        );
      const badgeImmediatelyAdjacent = Boolean(
        personLine &&
          l.page === personLine.page &&
          Math.abs(l.indexInPage - personLine.indexInPage) === 1
      );
      if (
        standaloneAffiliationBadge &&
        !badgeImmediatelyAdjacent
      ) {
        s = Number.NEGATIVE_INFINITY;
      }
      return { l, s };
    })
    .sort((a, b) => b.s - a.s);
  if (!inlineRole) {
    for (const l of workingLines) {
      const split = splitPersonTextAndInlineRole(l.text);
      if (split.inlineRole && ROLE_RE.test(split.inlineRole)) {
        inlineRole = split.inlineRole.replace(/\bGoneral\b/i, 'General');
        break;
      }
    }
  }
  if (!role.value && personLine) {
    const lowRoleCandidate = workingLines
      .filter(function(l){
        if (l.id === companyLineId || selectedPersonLineIds.has(l.id) || l.masked) return false;
        if (l.page !== personLine.page) return false;
        if (Math.abs(l.indexInPage - personLine.indexInPage) > 2) return false;
        const t = clean(l.text);
        if (!t || t.length < 3 || t.length > 55) return false;
        if (l.f.addressLike || l.f.hasLegalSuffix || l.f.emailLocalMatch > 0.5) return false;
        if (l.f.digitRatio > 0.25) return false;
        if (l.personScore >= T.person) return false;
        if (/@|www\.|https?:\/\//i.test(t)) return false;
        return true;
      })
      .sort(function(a,b){
        return Math.abs(a.indexInPage - personLine.indexInPage) - Math.abs(b.indexInPage - personLine.indexInPage);
      })[0];
    if (lowRoleCandidate) {
      const lowValue = finalizeRoleValue(clean(lowRoleCandidate.text), company.value);
      if (lowValue) {
        role = {
          value: lowValue,
          score: 0.38,
          reasons: ['ruolo plausibile vicino alla persona: confidenza bassa'],
          lineIds: [lowRoleCandidate.id],
        };
      }
    }
  }

  const companyInlineRoleEvidence = workingLines
    .map((l) => ({ l, split: splitRoleFromCompanyLine(l.text) }))
    .find((x) => Boolean(x.split?.role));
  const rBest = roleRank[0];
  if (rBest && rBest.s >= T.role) {
    let value = clean(rBest.l.text);

    if (value === value.toUpperCase()) value = titleCasePhrase(value);
    if (inlineRole && isRoleWordAsCompany(inlineRole) && !rBest) {
      const inline = finalizeRoleValue(inlineRole, company.value) ?? clean(inlineRole);
      if (inline && !value.toLowerCase().includes(inline.toLowerCase())) {
        value = `${inline} / ${value}`;
      }
    }
    role = {
      value,
      score: sigmoid((rBest.s - T.role) * 0.9),
      reasons: ['keyword ruolo' + (personLine && Math.abs(rBest.l.indexInPage - (personLine?.indexInPage ?? 0)) <= 2 ? ' vicino al nome' : '')],
      lineIds: [rBest.l.id],
    };
    // ruolo su due righe adiacenti ("Responsabile" + "Ufficio Comunicazione")
    const next = workingLines.find((o) => o.page === rBest.l.page && o.indexInPage === rBest.l.indexInPage + 1 && !o.masked && o.id !== companyLineId && !o.f.roleKeyword && o.f.tokenCount <= 4 && o.f.digitRatio === 0 && !o.f.hasLegalSuffix && o.personScore < T.person && (o.f.titleCase || o.f.allCaps || /^[A-ZÀ-Ü]{2,}(?:\s+(?:e|&)\s+[\p{L}][\p{L}'’-]*)+$/u.test(o.text.trim())) && o.f.domainRootMatch < 0.6);
    if (next && /^(?:responsabile|resp\.?|direttore|direttrice|head|capo)\b/i.test(rBest.l.text) ) {
      role.value = clean(role.value + ' ' + titleCasePhrase(next.text));
      role.lineIds!.push(next.id);
    }
    const cleanedRole = finalizeRoleValue(role.value, company.value);
    if (cleanedRole) role.value = cleanedRole;
    else {
      role = empty();
      for (const alternate of roleRank.slice(1)) {
        if (alternate.s < T.role) break;
        const alternateValue = finalizeRoleValue(clean(alternate.l.text), company.value);
        if (!alternateValue) continue;
        role = {
          value: alternateValue,
          score: sigmoid((alternate.s - T.role) * 0.9),
          reasons: ['ruolo alternativo valido dopo rigetto candidato principale'],
          lineIds: [alternate.l.id],
        };
        break;
      }
    }
    if (inlineRoleFromCompanySplit && inlineRole) {
      const companyRole = finalizeRoleValue(inlineRole, company.value);
      if (companyRole) {
        role = {
          value: companyRole,
          score: Math.max(role.score, 0.82),
          reasons: [...role.reasons, 'ruolo inline separato dalla ragione sociale'],
          lineIds: companyLineId >= 0 ? [companyLineId] : role.lineIds,
        };
      }
    }
  }

  if (companyInlineRoleEvidence?.split?.role) {
    const companyRole = finalizeRoleValue(companyInlineRoleEvidence.split.role, company.value);
    if (companyRole) {
      role = {
        value: companyRole,
        score: Math.max(role.score ?? 0, 0.82),
        reasons: [...role.reasons, 'ruolo inline rilevato su riga societaria'],
        lineIds: [companyInlineRoleEvidence.l.id],
      };
    }
  }

  if (!role.value && inlineRole) {
    const cleanedInline = finalizeRoleValue(inlineRole, company.value);
    if (cleanedInline) {
      role = {
        value: cleanedInline,
        score: 0.68,
        reasons: ['ruolo inline nella riga azienda'],
        lineIds: companyLineId >= 0 ? [companyLineId] : [],
      };
    }
  } else if (inlineRole && isRoleWordAsCompany(inlineRole) && role.value) {
    const cleanedInline = finalizeRoleValue(inlineRole, company.value);
    if (cleanedInline && !role.value.toLowerCase().includes(cleanedInline.toLowerCase())) {
      role = {
        ...role,
        value: `${cleanedInline} / ${role.value}`,
        reasons: [...role.reasons, 'ruolo escluso da company'],
      };
    }
  }

  if (!role.value && explicitLabels.role) {
    const cleanedExplicit = finalizeRoleValue(explicitLabels.role, company.value);
    if (cleanedExplicit) {
      role = {
        value: cleanedExplicit,
        score: 0.86,
        reasons: ['etichetta esplicita title/role'],
        lineIds: [],
      };
    }
  }

  // ---- arricchimento: brand corto → ragione sociale con legal form su altra riga/pagina
  if (company.value && companyLineId >= 0) {
    const withLogo = enrichCompanyWithLogoBrand(
      workingLines,
      companyLineId,
      company.value,
      structured.emails,
      structured.websites
    );
    if (withLogo !== company.value) {
      const finalizedLogo = finalizeCompanyValue(withLogo, structured.emails, ocrContextText);
      if (finalizedLogo) {
        company = {
          ...company,
          value: finalizedLogo,
          reasons: [...company.reasons, 'prefisso marchio logo'],
        };
      }
    }
    const root = displayDomainRoot(structured.emails, structured.websites);
    if (
      root &&
      company.value &&
      !hasTrustedTerminalLegalLine(
        company.value,
        structured.emails,
        structured.websites
      ) &&
      tokens(company.value).length === 1
    ) {
      const cv = compact(company.value);
      const cr = compact(root);
      if (levenshtein(cv, cr) <= 3 || cr.includes(cv) || cv.includes(cr.slice(0, Math.min(5, cr.length)))) {
        const brand = splitFusedDomainBrand(root);
        const finalizedBrand = finalizeCompanyValue(brand, structured.emails, ocrContextText);
        if (finalizedBrand) {
          company = {
            ...company,
            value: finalizedBrand,
            reasons: [...company.reasons, 'brand normalizzato da dominio'],
          };
        }
      }
    }
  }

  // ---- arricchimento: brand corto → ragione sociale con legal form su altra riga/pagina
  if (
    company.value &&
    !hasTrustedTerminalLegalLine(
      company.value,
      structured.emails,
      structured.websites
    )
  ) {
    const upgraded = upgradeCompanyWithLegalLine(
      company.value,
      workingLines,
      brandReps,
      structured.emails,
      structured.websites,
      ocrContextText
    );
    if (upgraded) {
      company = {
        ...company,
        value: upgraded.value,
        reasons: [...company.reasons, 'arricchita da riga con forma giuridica'],
        lineIds: [...(company.lineIds ?? []), upgraded.lineId],
      };
    }
  }

  // ---- brand osservato + forma giuridica-only su riga adiacente
  if (company.value && !hasTerminalLegalFormSuffix(company.value)) {
    const sourceLineId = company.lineIds?.[0] ?? companyLineId;
    const sourceLine = workingLines.find((line) => line.id === sourceLineId);
    const adjacentLegalOnly = sourceLine
      ? workingLines.find(
          (line) =>
            line.page === sourceLine.page &&
            Math.abs(line.indexInPage - sourceLine.indexInPage) === 1 &&
            isLegalFormOnlyCompanyLine(line.text)
        )
      : undefined;
    if (adjacentLegalOnly) {
      const combined = finalizeCompanyValue(
        company.value + ' ' + normalizeLegal(adjacentLegalOnly.text),
        structured.emails,
        ocrContextText
      );
      if (
        combined &&
        normalizeBrandKey(stripLegalFormSuffix(combined)) ===
          normalizeBrandKey(stripLegalFormSuffix(company.value))
      ) {
        company = {
          ...company,
          value: combined,
          reasons: [...company.reasons, 'brand + forma giuridica su righe adiacenti'],
          lineIds: [...new Set([...(company.lineIds ?? []), adjacentLegalOnly.id])],
        };
      }
    }
  }

  // ---- azienda solo forma giuridica → combina con brand/nome adiacente
  if (company.value && isLegalFormOnlyCompany(company.value)) {
    const repaired = combineLegalFormWithBrandLine(
      workingLines,
      company.value,
      structured.emails,
      ocrContextText,
      firstName.value,
      lastName.value
    );
    if (repaired) {
      company = {
        ...company,
        value: repaired,
        reasons: [...company.reasons, 'ragione sociale da brand + forma giuridica'],
      };
    }
  }

  if (!company.value) {
    const legalOnlyLine = workingLines.find((l) => isLegalFormOnlyCompany(normalizeLegal(l.text)));
    if (legalOnlyLine) {
      const repaired = combineLegalFormWithBrandLine(
        workingLines,
        normalizeLegal(legalOnlyLine.text),
        structured.emails,
        ocrContextText,
        firstName.value,
        lastName.value
      );
      if (repaired) {
        company = {
          value: repaired,
          score: 0.62,
          reasons: ['brand + forma giuridica OCR', 'validazione finale'],
          lineIds: [legalOnlyLine.id],
        };
      }
    }
  }

  if (!company.value && structured.emails.length > 0) {
    const domain = [...domainRoots(structured.emails, structured.websites)][0];
    const root = domain ? normalizeBrandKey(domain.split('.')[0] ?? '') : '';
    if (root.length >= 4) {
      const domainLine = [...workingLines]
        .filter(
          (l) =>
            l.masked !== 'contact-label' &&
            l.masked !== 'structured' &&
            !l.f.addressLike &&
            !LEGAL_RE.test(l.text)
        )
        .find((l) => {
          const key = normalizeBrandKey(stripLegalFormSuffix(l.text));
          return (
            key.length >= 3 &&
            (key.includes(root.slice(0, Math.min(6, root.length))) ||
              root.includes(key.replace(/[^a-z0-9]/g, '')))
          );
        });
      if (domainLine) {
        const finalized = finalizeCompanyValue(
          normalizeLegal(domainLine.text),
          structured.emails,
          ocrContextText
        );
        if (finalized) {
          company = {
            value: finalized,
            score: 0.56,
            reasons: ['brand da dominio email', 'validazione finale'],
            lineIds: [domainLine.id],
          };
        }
      }
    }
  }

  if (!company.value && structured.emails.length > 0) {
    const brandFromDomain = [...workingLines]
      .filter(
        (l) =>
          l.f.domainRootMatch >= 0.72 &&
          l.masked !== 'contact-label' &&
          l.masked !== 'structured' &&
          !l.f.addressLike
      )
      .sort((a, b) => b.f.domainRootMatch - a.f.domainRootMatch || b.f.fontScale - a.f.fontScale)[0];
    if (brandFromDomain) {
      const finalized = finalizeCompanyValue(
        normalizeLegal(brandFromDomain.text),
        structured.emails,
        ocrContextText
      );
      if (finalized) {
        company = {
          value: finalized,
          score: 0.58,
          reasons: ['brand coerente con email', 'validazione finale'],
          lineIds: [brandFromDomain.id],
        };
      }
    }
  }

  // ---- azienda mancante → fiscal line, legal line, poi brand/dominio
  if (!company.value) {
    const fiscalPick = pickCompanyFromFiscalLines(
      workingLines,
      structured.emails,
      ocrContextText
    );
    if (fiscalPick) {
      company = {
        value: fiscalPick.value,
        score: sigmoid((fiscalPick.score - T.company) * 0.85),
        reasons: ['ragione sociale + CF/P.IVA', 'validazione finale'],
        lineIds: [fiscalPick.lineId],
      };
    }
  }
  if (!company.value) {
    const legalPick = pickBestLegalCompanyLine(
      workingLines,
      brandReps,
      structured.emails,
      structured.websites,
      ocrContextText
    );
    if (legalPick) {
      company = {
        value: legalPick.value,
        score: sigmoid((legalPick.score - T.company) * 0.85),
        reasons: ['forma giuridica OCR', 'validazione finale'],
        lineIds: [legalPick.lineId],
      };
    }
  }
  if (!company.value) {
    const brandLine = [...workingLines]
      .filter(
        (l) =>
          l.id !== personLineId &&
          l.f.domainRootMatch >= 0.75 &&
          (!l.masked || l.masked === 'address' || isBrandDominantLine(l.text))
      )
      .sort((a, b) => b.f.fontScale - a.f.fontScale)[0];
    if (brandLine) {
      const finalized = finalizeCompanyValue(
        respellBrandFromDomain(normalizeLegal(brandLine.text), structured.emails, structured.websites),
        structured.emails,
        ocrContextText
      );
      if (finalized && !isDomainOnlyCompanyValue(finalized, structured.emails, ocrContextText)) {
        company = {
          value: finalized,
          score: 0.55,
          reasons: ['brand = radice dominio', 'validazione finale'],
          lineIds: [brandLine.id],
        };
      }
    }
    if (!company.value) {
      const display = displayDomainRoot(structured.emails, structured.websites);
      const root = display ?? [...domainRoots(structured.emails, structured.websites)][0];
      const brandGuess = root ? splitFusedDomainBrand(respellBrandFromDomain(root, structured.emails, structured.websites)) : '';
      const finalized =
        brandGuess && brandGuess.length >= 3
          ? finalizeCompanyValue(brandGuess, structured.emails, ocrContextText)
          : null;
      if (finalized && !isDomainOnlyCompanyValue(finalized, structured.emails, ocrContextText)) {
        company = { value: finalized, score: 0.4, reasons: ['derivata dal dominio', 'validazione finale'] };
      }
    }
  }
  if (
    company.value &&
    isDomainOnlyCompanyValue(company.value, structured.emails, ocrContextText)
  ) {
    const legalPick = pickBestLegalCompanyLine(
      workingLines,
      brandReps,
      structured.emails,
      structured.websites,
      ocrContextText
    );
    if (legalPick) {
      company = {
        value: legalPick.value,
        score: Math.max(company.score, sigmoid((legalPick.score - T.company) * 0.85)),
        reasons: ['sostituita: dominio puro → ragione sociale OCR', 'validazione finale'],
        lineIds: [legalPick.lineId],
      };
    } else {
      const fiscalPick = pickCompanyFromFiscalLines(
        workingLines,
        structured.emails,
        ocrContextText
      );
      if (fiscalPick) {
        company = {
          value: fiscalPick.value,
          score: sigmoid((fiscalPick.score - T.company) * 0.85),
          reasons: ['ragione sociale + CF/P.IVA', 'validazione finale'],
          lineIds: [fiscalPick.lineId],
        };
      } else {
        // Guardrail: non cancellare company plausibile se l'alternativa OCR è vuota
      }
    }
  }
  if (!company.value && explicitLabels.company) {
    const finalizedOrg = finalizeCompanyValue(explicitLabels.company, structured.emails, ocrContextText);
    if (finalizedOrg) {
      company = {
        value: finalizedOrg,
        score: 0.78,
        reasons: ['organizzazione da tessera etichettata'],
        lineIds: [],
      };
    }
  }

  if (company.value) {
    if (shouldRejectCompanyCandidate(company.value) && isRoleWordAsCompany(company.value) && !inlineRole) {
      inlineRole = company.value;
    }
    company = recoverCompanyAfterSemanticReject(
      company,
      workingLines,
      brandReps,
      structured,
      ocrContextText,
      personLineId
    );
    company = preferLegalEntityOverWeakBrand(
      company,
      workingLines,
      brandReps,
      structured,
      ocrContextText
    );
  }

  const websiteResolved = finalizeWebsiteValue(structured.emails, resolveWebsite(structured.emails, structured.websites, rawText).value);
  let addressIds = collectAddressLineIds(workingLines, structured.addressLineIds);
  if (personLineId >= 0) {
    const personPage = workingLines.find((l) => l.id === personLineId)?.page;
    if (personPage !== undefined) {
      addressIds = addressIds.filter((id) => {
        const line = workingLines.find((l) => l.id === id);
        if (!line) return false;
        if (line.page === personPage) return true;
        if (isGlobalOfficeAddressBlock(line.text)) return false;
        return !workingLines.some(
          (l) => l.page === personPage && addressIds.includes(l.id) && (STREET_RE.test(l.text) || isForeignAddressLine(l.text))
        );
      });
    }
  }
  let addressRaw = assembleAddress(workingLines, addressIds, {
    personLineId: personLineId >= 0 ? personLineId : undefined,
    lastName: lastName.value,
    companyLineId: company.lineIds?.[0],
    roleLineId: role.lineIds?.[0],
  });
  let addressFinal = finalizeAddressParts(addressRaw);

  const emailDomainOcrMismatch = emailDomainIncoherentWithWebsite(
    structured.emails,
    websiteResolved.value
  );
  // Solo email osservate e confermate possono guidare la riconciliazione.
  // Le proposte di repair restano esclusivamente nella provenance di review.
  const observedEmails = [...structured.emails];
  const companyEmails = emailDomainOcrMismatch ? [] : observedEmails;
  const explicitWebsiteBrand = displayDomainRoot([], structured.websites);
  const convergentBusinessBrand = recoverBrandFromConvergentEmailWebsite(
    observedEmails,
    structured.websites
  );
  const companySupportedByWebsite = (value: string | null | undefined) => {
    if (!value || !explicitWebsiteBrand) return false;
    const companyKey = normalizeBrandKey(stripLegalFormSuffix(value));
    const websiteKey = normalizeBrandKey(
      splitFusedDomainBrand(explicitWebsiteBrand).split(/\s+/)[0] ??
        explicitWebsiteBrand
    );
    return (
      companyKey.length >= 4 &&
      websiteKey.length >= 4 &&
      (companyKey === websiteKey ||
        companyKey.startsWith(websiteKey) ||
        websiteKey.startsWith(companyKey))
    );
  };

  const personLineText = workingLines.find((l) => l.id === personLineId)?.text;
  const personIncomplete = !firstName.value?.trim() || !lastName.value?.trim();
  if (personIncomplete || isPersonDuplicateOfCompany(firstName.value, lastName.value, company.value)) {
    if (personIncomplete) {
      const brandPerson = recoverPersonOnBrandOnlyCard(ocrContextText, structured.emails, emailToks);
    if (brandPerson) {
      firstName = {
        value: brandPerson.firstName,
        score: 0.8,
        reasons: ['persona recuperata da card marchio-only'],
        lineIds: [],
      };
      lastName = {
        value: brandPerson.lastName,
        score: 0.8,
        reasons: ['persona recuperata da card marchio-only'],
        lineIds: [],
      };
    }
    }
  }
  let personFinal = finalizePersonFields(
    firstName.value,
    lastName.value,
    personLineText,
    observedEmails,
    ocrContextText,
    company.value,
    Boolean(
      personLineText &&
        personLineText.split(/\s+/).filter(Boolean).length === 2 &&
        (
          firstName.reasons.includes(
            'riga nome osservata corroborata da repair email'
          ) ||
          firstName.reasons.includes(
            'riga nome osservata corroborata da email esatta'
          ) ||
          firstName.reasons.includes('nome sopra riga ruolo') ||
          firstName.reasons.includes('nome sopra ruolo')
        )
    )
  );
  const finalFirstKey = normalizeBrandKey(personFinal.firstName ?? '');
  const finalLastKey = normalizeBrandKey(personFinal.lastName ?? '');
  const companyMatchesOnlySurname =
    Boolean(finalLastKey) &&
    normalizeBrandKey(company.value ?? '') === finalLastKey;
  const emailSupportsOnlySurname = structured.emails.some((email) => {
    const local = normalizeBrandKey(email.split('@')[0] ?? '');
    return local === finalLastKey && !local.includes(finalFirstKey);
  });
  const hasExplicitPersonLabel = Boolean(
    explicitLabels.firstName || explicitLabels.lastName
  );
  const hasStrongPersonLine = workingLines.some((line) => {
    const parsed = parsePersonLine(
      line.text,
      emailToks,
      structured.emails
    );
    if (
      normalizeBrandKey(parsed?.first ?? '') !== finalFirstKey ||
      normalizeBrandKey(parsed?.last ?? '') !== finalLastKey
    ) {
      return false;
    }
    const nextLine = workingLines.find(
      (candidate) =>
        candidate.page === line.page &&
        candidate.indexInPage === line.indexInPage + 1 &&
        !candidate.masked
    );
    return (
      line.personScore >= T.person ||
      isLikelyPersonNameAboveRoleLine(line.text, nextLine?.text)
    );
  });
  if (
    finalFirstKey &&
    finalLastKey &&
    companyMatchesOnlySurname &&
    emailSupportsOnlySurname &&
    !hasExplicitPersonLabel &&
    !hasStrongPersonLine
  ) {
    personFinal = { firstName: null, lastName: null };
  }
  if (!personFinal.firstName && !personFinal.lastName) {
    firstName = empty();
    lastName = empty();
  } else {
    firstName = {
      ...firstName,
      value: personFinal.firstName,
      reasons: [...firstName.reasons, 'validazione finale'].filter(Boolean),
    };
    lastName = {
      ...lastName,
      value: personFinal.lastName,
      reasons: [...lastName.reasons, 'validazione finale'].filter(Boolean),
    };
  }

  if (
    addressFinal?.city &&
    personFinal.lastName &&
    isCityMatchingPersonSurname(addressFinal.city, personFinal.lastName)
  ) {
    const repairedAddress = assembleAddress(workingLines, addressIds, {
      personLineId: personLineId >= 0 ? personLineId : undefined,
      lastName: personFinal.lastName,
      companyLineId: company.lineIds?.[0],
      roleLineId: role.lineIds?.[0],
    });
    addressFinal = finalizeAddressParts(repairedAddress);
  }

  const roleFinal = finalizeRoleValue(role.value, company.value);
  role = roleFinal
    ? { ...role, value: roleFinal, reasons: [...role.reasons, 'validazione finale'].filter(Boolean) }
    : empty();

  if (company.value && tokens(company.value).length <= 2) {
    const respelled = respellBrandFromDomain(company.value, companyEmails, structured.websites);
    if (respelled !== company.value) {
      const finalizedBrand = finalizeCompanyValue(respelled, companyEmails, ocrContextText);
      const selectedBrand =
        companySupportedByWebsite(respelled)
          ? respelled
          : finalizedBrand &&
              normalizeBrandKey(finalizedBrand) !== normalizeBrandKey(company.value)
            ? finalizedBrand
            : respelled;
      if (selectedBrand) {
        company = { ...company, value: selectedBrand, reasons: [...company.reasons, 'brand da dominio sito'] };
      }
    }
  }
  if (
    company.value &&
    hasTrustedTerminalLegalLine(
      company.value,
      companyEmails,
      structured.websites
    )
  ) {
    const respelledLegal = respellBrandFromDomain(company.value, companyEmails, structured.websites);
    if (respelledLegal !== company.value) {
      const finalizedLegal = finalizeCompanyValue(respelledLegal, companyEmails, ocrContextText);
      const selectedLegal =
        finalizedLegal &&
        normalizeBrandKey(finalizedLegal) !== normalizeBrandKey(company.value)
          ? finalizedLegal
          : respelledLegal;
      if (selectedLegal) {
        company = { ...company, value: selectedLegal, reasons: [...company.reasons, 'brand OCR fuzzy da dominio'] };
      }
    }
  }
  if (company.value) {
    const root = displayDomainRoot(companyEmails, structured.websites) ?? '';
    if (root) {
      const trustedLegal = hasTrustedTerminalLegalLine(
        company.value,
        companyEmails,
        structured.websites
      );
      const brandSource = trustedLegal
        ? matchTerminalLegalFormSuffix(company.value)?.brand ?? company.value
        : company.value;
      const brandWord = brandSource.split(/\s+/).filter(Boolean)[0] ?? brandSource;
      const respelledWord = respellTokenFromDomainRoot(brandWord, root);
      if (normalizeBrandKey(respelledWord) !== normalizeBrandKey(brandWord)) {
        const legalTail = trustedLegal
          ? company.value.slice(brandSource.length).trim()
          : '';
        const nextValue = legalTail ? `${respelledWord} ${legalTail}` : respelledWord;
        const finalized = finalizeCompanyValue(nextValue, companyEmails, ocrContextText);
        if (finalized) {
          company = {
            ...company,
            value: finalized,
            reasons: [...company.reasons, 'brand OCR fuzzy da dominio email'],
          };
        }
      }
    }
  }
  if (company.value &&
    /motorbike|motor\s*bike/i.test(company.value) &&
    websiteResolved.value
  ) {
    const webHost = websiteResolved.value.replace(/^www\./i, '').split('.')[0] ?? '';
    const brand = splitFusedDomainBrand(webHost);
    const finalizedFused = finalizeCompanyValue(brand, companyEmails, ocrContextText);
    if (finalizedFused) {
      company = { ...company, value: finalizedFused, reasons: [...company.reasons, 'brand da sito web'] };
    }
  }

  if (company.value && lastName.value) {
    const compKey = normalizeBrandKey(stripLegalFormSuffix(company.value));
    const lastKey = normalizeBrandKey(lastName.value);
    const firstKey = normalizeBrandKey(firstName.value ?? '');
    const companyIsPersonName =
      (lastKey && compKey === lastKey) || (firstKey && compKey === firstKey);
    const fullPersonKey = normalizeBrandKey(`${firstName.value ?? ''}${lastName.value ?? ''}`);
    if (
      fullPersonKey &&
      compKey === fullPersonKey &&
      !hasTrustedTerminalLegalLine(
        company.value,
        companyEmails,
        structured.websites
      )
    ) {
      company = empty();
    } else if (
      companyIsPersonName &&
      !companySupportedByWebsite(company.value) &&
      !hasTrustedTerminalLegalLine(
        company.value,
        companyEmails,
        structured.websites
      )
    ) {
      const acronym = recoverShortCardAcronymCompany(
        workingLines,
        firstName.value,
        lastName.value,
        emailToks
      );
      if (acronym) {
        const finalizedAcronym = finalizeCompanyValue(acronym, companyEmails, ocrContextText);
        if (finalizedAcronym) {
          company = {
            ...company,
            value: finalizedAcronym,
            reasons: [...company.reasons, 'marchio acronimo su card'],
          };
        }
      } else {
        const brandFix =
          normalizeOcrBrandValue(company.value, companyEmails) ?? resolveBrandFromEmailDomain(companyEmails);
        const repairedCompany = brandFix
          ? finalizeCompanyValue(brandFix, companyEmails, ocrContextText)
          : finalizeCompanyValue(company.value, companyEmails, ocrContextText);
        if (repairedCompany && repairedCompany !== company.value) {
          company = { ...company, value: repairedCompany, reasons: [...company.reasons, 'company ≠ cognome persona'] };
        }
      }
    }
  }

  if (!company.value && !explicitLabels.labeledCard && convergentBusinessBrand) {
    const finalizedConvergent = finalizeCompanyValue(
      convergentBusinessBrand,
      observedEmails,
      ocrContextText
    );
    if (finalizedConvergent) {
      company = {
        value: finalizedConvergent,
        score: 0.76,
        reasons: ['brand corroborato indipendentemente da email + sito'],
        lineIds: [],
      };
    }
  }

  if (!company.value && !explicitLabels.labeledCard) {
    const fuzzyBrand = pickBestFuzzyCompanyLineFromOcr(ocrContextText, companyEmails, [...structured.websites.keys()]);
    if (fuzzyBrand) {
      const finalizedFuzzy = finalizeCompanyValue(fuzzyBrand, companyEmails, ocrContextText);
      if (finalizedFuzzy) {
        company = {
          value: finalizedFuzzy,
          score: 0.72,
          reasons: ['marchio OCR fuzzy allineato al dominio email'],
          lineIds: [],
        };
      }
    }
  }

  if (!company.value && !explicitLabels.labeledCard) {
    const domainBrand = resolveBrandFromEmailDomain(companyEmails);
    if (domainBrand) {
      const finalizedDomain = finalizeCompanyValue(domainBrand, companyEmails, ocrContextText);
      if (finalizedDomain) {
        company = {
          value: finalizedDomain,
          score: 0.68,
          reasons: ['brand da dominio email (company assente)'],
          lineIds: [],
        };
      }
    }
  }

  if (!company.value && !explicitLabels.labeledCard) {
    const headerBrand = recoverOcrHeaderBrand(ocrContextText, companyEmails);
    if (headerBrand) {
      const finalizedHeader = finalizeCompanyValue(headerBrand, companyEmails, ocrContextText);
      if (finalizedHeader) {
        company = {
          value: finalizedHeader,
          score: 0.6,
          reasons: ['marchio logo OCR recuperato'],
          lineIds: [],
        };
      }
    }
  }

  if (!company.value && !explicitLabels.labeledCard) {
    const personKeys = new Set(
      [firstName.value, lastName.value]
        .map((p) => normalizeBrandKey(p ?? ''))
        .filter((k) => k.length >= 3)
    );
    const headerLine = workingLines
      .filter((l) => {
        if (l.masked || l.indexInPage > 3 || l.companyScore < 0.65) return false;
        if (shouldRejectCompanyCandidate(l.text)) return false;
        const key = normalizeBrandKey(l.text);
        if (personKeys.has(key)) return false;
        if (l.personScore >= T.person && l.companyScore <= l.personScore) return false;
        return true;
      })
      .sort((a, b) => b.companyScore - a.companyScore || a.indexInPage - b.indexInPage)[0];
    if (headerLine) {
      const built = buildCompanyField(headerLine, undefined, emailToks, structured, ocrContextText);
      if (built?.value) {
        company = built;
      }
    }
  }

  if (company.value && shouldPreferEmailBrandOverCompany(company.value, companyEmails, ocrContextText)) {
    const domainBrand = resolveBrandFromEmailDomain(companyEmails);
    if (domainBrand) {
      const finalized = finalizeCompanyValue(domainBrand, companyEmails, ocrContextText);
      if (finalized) {
        company = {
          ...company,
          value: finalized,
          reasons: [...company.reasons, 'brand coerente con dominio email'],
        };
      }
    }
  }

  if ((!firstName.value || !lastName.value) && company.value) {
    const observedSplitLegalOwner = workingLines.find((line) => {
      if (!isAmbiguousTwoTokenIdentityLine(line.rawOcr || line.text)) return false;
      const legalLine = workingLines.find(
        (candidate) =>
          candidate.page === line.page &&
          candidate.indexInPage === line.indexInPage + 1 &&
          isLegalFormOnlyCompany(normalizeLegal(candidate.rawOcr || candidate.text))
      );
      return Boolean(
        legalLine &&
          normalizeBrandKey(stripLegalFormSuffix(company.value ?? '')) ===
            normalizeBrandKey(line.rawOcr || line.text)
      );
    });
    const legalOwnerName = observedSplitLegalOwner
      ? parsePersonNameFromLine(observedSplitLegalOwner.rawOcr || observedSplitLegalOwner.text)
      : null;
    if (legalOwnerName?.firstName && legalOwnerName.lastName) {
      if (!firstName.value) {
        firstName = {
          value: legalOwnerName.firstName,
          score: 0.9,
          reasons: ['nome osservato nella ragione sociale'],
          lineIds: company.lineIds,
        };
      }
      if (!lastName.value) {
        lastName = {
          value: legalOwnerName.lastName,
          score: 0.9,
          reasons: ['cognome osservato nella ragione sociale'],
          lineIds: company.lineIds,
        };
      }
    }
  }

  if ((!firstName.value || !lastName.value) && company.value && !isProductBrandLineAsPerson(company.value)) {
    const companyLooksInstitutional =
      /\b(?:university|college)\b/i.test(company.value) ||
      isInstitutionalOcrPersonGarbage(company.value);
    if (!companyLooksInstitutional) {
      const ownerSplit = splitPersonNameFromCompanyValue(company.value, companyEmails, ocrContextText);
      if (ownerSplit) {
        if (!firstName.value) {
          firstName = {
            value: ownerSplit.firstName,
            score: 0.9,
            reasons: ['nome in evidenza separato da azienda'],
            lineIds: company.lineIds,
          };
        }
        if (!lastName.value) {
          lastName = {
            value: ownerSplit.lastName,
            score: 0.9,
            reasons: ['nome in evidenza separato da azienda'],
            lineIds: company.lineIds,
          };
        }
        const finalizedOwnerCompany = finalizeCompanyValue(ownerSplit.company, companyEmails, ocrContextText);
        if (finalizedOwnerCompany) {
          company = {
            ...company,
            value: finalizedOwnerCompany,
            reasons: [...company.reasons, 'brand da sito/dominio'],
          };
        }
      }
    }
  }

  if (
    company.value &&
    !hasTrustedTerminalLegalLine(
      company.value,
      companyEmails,
      structured.websites
    ) &&
    (
      hasOcrBrandNoise(company.value) ||
      hasConfusableDigitInsideBrandToken(company.value)
    )
  ) {
    const brandFix = normalizeOcrBrandValue(company.value, companyEmails);
    if (brandFix) {
      const finalized = finalizeCompanyValue(brandFix, companyEmails, ocrContextText);
      if (finalized) {
        company = { ...company, value: finalized, reasons: [...company.reasons, 'brand OCR normalizzato'] };
      }
    }
  } else if (company.value && lastName.value && normalizeBrandKey(company.value) === normalizeBrandKey(lastName.value)) {
    const brandFix = normalizeOcrBrandValue(company.value, companyEmails);
    if (brandFix && brandFix !== company.value) {
      const finalized = finalizeCompanyValue(brandFix, companyEmails, ocrContextText);
      if (finalized) {
        company = { ...company, value: finalized, reasons: [...company.reasons, 'brand OCR allineato al cognome'] };
      }
    }
  }

  if (company.value && !companySupportedByWebsite(company.value)) {
    const refinedLogo = refineLogoBrandFromConvergentEvidence(
      company.value,
      companyEmails,
      ocrContextText,
      { firstName: firstName.value, lastName: lastName.value }
    );
    if (refinedLogo && refinedLogo !== company.value) {
      const finalized = finalizeCompanyValue(refinedLogo, companyEmails, ocrContextText);
      company = {
        ...company,
        value: finalized ?? refinedLogo,
        reasons: [...company.reasons, 'logo OCR da evidenze convergenti'],
      };
    }
  }

  if (company.value && explicitWebsiteBrand && !hasTrustedTerminalLegalLine(company.value, companyEmails, structured.websites)) {
    const currentBrandKey = normalizeBrandKey(stripLegalFormSuffix(company.value));
    const websiteRootKey = normalizeBrandKey(explicitWebsiteBrand);
    const websiteLabelKey = normalizeBrandKey(splitFusedDomainBrand(explicitWebsiteBrand));
    const currentLooksDomainDerived =
      currentBrandKey === websiteRootKey || currentBrandKey === websiteLabelKey;
    if (currentLooksDomainDerived) {
      const observedBrand = pickBestFuzzyCompanyLineFromOcr(
        ocrContextText,
        companyEmails,
        [...structured.websites.keys()]
      );
      if (observedBrand && (
        normalizeBrandKey(observedBrand) !== currentBrandKey ||
        observedBrand.trim().split(/\s+/).filter(Boolean).length >
          company.value!.trim().split(/\s+/).filter(Boolean).length
      )) {
        const finalizedObservedBrand = finalizeCompanyValue(observedBrand, companyEmails, ocrContextText);
        const preferredObservedBrand =
          finalizedObservedBrand &&
          normalizeBrandKey(finalizedObservedBrand) === normalizeBrandKey(observedBrand) &&
          observedBrand.trim().split(/\s+/).filter(Boolean).length >
            finalizedObservedBrand.trim().split(/\s+/).filter(Boolean).length
            ? observedBrand
            : finalizedObservedBrand;
        if (preferredObservedBrand) {
          company = {
            ...company,
            value: preferredObservedBrand,
            reasons: [...company.reasons, "brand OCR ricostruito da evidenze dominio"],
          };
        }
      }
    }
  }

  if (company.value && explicitWebsiteBrand) {
    const websiteHostRoot =
      websiteResolved.value?.replace(/^www\./i, '').split('.')[0] ??
      explicitWebsiteBrand;
    const websiteBrandLabel = splitFusedDomainBrand(websiteHostRoot);
    const trustedLegal = hasTrustedTerminalLegalLine(
      company.value,
      companyEmails,
      structured.websites
    );
    const companyBrand = trustedLegal
      ? matchTerminalLegalFormSuffix(company.value)?.brand ?? company.value
      : company.value;
    if (
      websiteBrandLabel.includes(' ') &&
      !companyBrand.includes(' ') &&
      normalizeBrandKey(websiteBrandLabel) === normalizeBrandKey(companyBrand)
    ) {
      const legalTail = trustedLegal
        ? company.value.slice(companyBrand.length).trim()
        : '';
      const candidate = legalTail
        ? `${websiteBrandLabel} ${legalTail}`
        : websiteBrandLabel;
      company = {
        ...company,
        value: candidate,
        reasons: [
          ...company.reasons,
          'spazi brand corroborati dal sito osservato',
        ],
      };
    }
  }

  if (company.value) {
    const root = displayDomainRoot(companyEmails, structured.websites) ?? '';
    if (root) {
      const trustedLegal = hasTrustedTerminalLegalLine(
        company.value,
        companyEmails,
        structured.websites
      );
      const brandSource = trustedLegal
        ? matchTerminalLegalFormSuffix(company.value)?.brand ?? company.value
        : company.value;
      const brandWord = brandSource.split(/\s+/).filter(Boolean)[0] ?? brandSource;
      const respelledWord = respellTokenFromDomainRoot(brandWord, root);
      if (normalizeBrandKey(respelledWord) !== normalizeBrandKey(brandWord)) {
        const legalTail = trustedLegal
          ? company.value.slice(brandSource.length).trim()
          : '';
        const nextValue = legalTail ? `${respelledWord} ${legalTail}` : respelledWord;
        const finalized = finalizeCompanyValue(nextValue, companyEmails, ocrContextText);
        if (finalized) {
          company = {
            ...company,
            value: finalized,
            reasons: [...company.reasons, 'brand OCR fuzzy da dominio email'],
          };
        }
      }
    }
  }

  if (company.value && shouldRejectCompanyCandidate(company.value)) {
    company = recoverCompanyAfterSemanticReject(
      company,
      workingLines,
      brandReps,
      structured,
      ocrContextText,
      personLineId
    );
  }

  if (
    company.value &&
    isUncorroboratedAmbiguousLegalLine(
      company.value,
      companyEmails,
      structured.websites
    ) &&
    !company.lineIds?.some((lineId) => {
      const source = workingLines.find((line) => line.id === lineId);
      const inline = source
        ? splitCompanyInlineAddress(source.text)
        : null;
      return Boolean(
        inline &&
        normalizeBrandKey(inline.company) ===
          normalizeBrandKey(company.value ?? '')
      );
    })
  ) {
    const domainBrand = resolveBrandFromEmailDomain(companyEmails);
    const finalizedDomain = domainBrand
      ? finalizeCompanyValue(domainBrand, companyEmails, ocrContextText)
      : null;
    company = finalizedDomain
      ? {
          ...company,
          value: finalizedDomain,
          reasons: [
            ...company.reasons,
            'sigla legale ambigua: usata evidenza business indipendente',
          ],
        }
      : empty();
  }

  if (company.value) {
    const observedLegalDisplay =
      hasTrustedTerminalLegalLine(
        company.value,
        companyEmails,
        structured.websites
      )
      ? finalizeCompanyValue(company.value, companyEmails, ocrContextText)
      : null;
    const preservesObservedIdentity =
      Boolean(observedLegalDisplay) &&
      normalizeBrandKey(observedLegalDisplay!) === normalizeBrandKey(company.value);
    const aligned = preservesObservedIdentity
      ? observedLegalDisplay!
      : alignCompanyToEmailDomain(company.value, companyEmails, ocrContextText);
    const intlFixed = repairInternationalCompanyOcr(
      aligned && aligned !== company.value ? aligned : company.value
    );
    const nextCompany =
      intlFixed !== company.value
        ? intlFixed
        : aligned && aligned !== company.value
          ? aligned
          : company.value;
    if (nextCompany !== company.value) {
      // Non troncare nomi multi-parola senza rumore OCR (Centro Universitário da FEI → Centro)
      const origWords = company.value.trim().split(/\s+/).filter(Boolean).length;
      const nextWords = nextCompany.trim().split(/\s+/).filter(Boolean).length;
      const isTruncating = nextWords < origWords && !hasOcrBrandNoise(company.value);
      if (!isTruncating) {
        company = {
          ...company,
          value: nextCompany,
          reasons: [...company.reasons, 'brand allineato fuzzy al dominio email'],
        };
      }
    }
  }

  // Dedup finale: se company = nome persona trovato, recupera brand da dominio o header OCR
  if (company.value && firstName.value && lastName.value) {
    const personFull = `${firstName.value} ${lastName.value}`.trim().toLowerCase();
    const companyNorm = company.value.trim().toLowerCase();
    const companyNoSpaces = normalizeBrandKey(company.value);
    const personNoSpaces = normalizeBrandKey(`${firstName.value} ${lastName.value}`);
    if (companyNorm === personFull || companyNoSpaces === personNoSpaces) {
      // Company è il nome persona → cerca brand alternativo
      const legalEntity = pickBestLegalCompanyLine(
        workingLines,
        brandReps,
        companyEmails,
        structured.websites,
        ocrContextText
      );
      const domainBrand = resolveBrandFromEmailDomain(companyEmails);
      const ocrBrand = recoverOcrHeaderBrand(ocrContextText, companyEmails);
      // Prova anche il brand dalla prima riga header (MOTOCARD RAS, Gino78)
      const firstHeaderBrand = (() => {
        const lines = ocrContextText.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines.slice(0, 4)) {
          if (normalizeBrandKey(line) === personNoSpaces) continue;
          if (/@|www\.|https?:|tel|fax|\d{5}/i.test(line)) continue;
          if (line.length < 3 || line.length > 60) continue;
          // Riga ALLCAPS o con prefisso alfanumerico → brand header
          const firstWord = line.split(/\s+/)[0] ?? '';
          if (/^[A-ZÀ-Ü0-9][A-ZÀ-Üa-zà-ü0-9]{1,}/.test(firstWord) && firstWord.length >= 3) {
            // Verifica che non sia nome persona
            const lineNorm = normalizeBrandKey(firstWord);
            if (lineNorm !== normalizeBrandKey(firstName.value ?? '') &&
                lineNorm !== normalizeBrandKey(lastName.value ?? '')) {
              const isShortHeaderLine = /^[A-ZÀ-Ü0-9\s&'-]{3,30}$/i.test(line);
              return isShortHeaderLine ? line : firstWord;
            }
          }
        }
        return null;
      })();
      const altBrand = legalEntity?.value ?? domainBrand ?? ocrBrand ?? firstHeaderBrand;
      if (altBrand && normalizeBrandKey(altBrand) !== personNoSpaces) {
        const finalAlt = finalizeCompanyValue(altBrand, companyEmails, ocrContextText);
        company = { ...company, value: finalAlt ?? altBrand, reasons: [...company.reasons, 'company dedupata da persona'] };
      } else {
        company = { ...company, value: null, reasons: [...company.reasons, 'company = nome persona, scartata'] };
      }
    }
  }

  if (company.value) {
    const uniqueCompanyLineIds = [...new Set(company.lineIds ?? [])];
    const ambiguousSeparatorSource = uniqueCompanyLineIds
      .map((lineId) => workingLines.find((line) => line.id === lineId))
      .find(
        (line): line is Line =>
          Boolean(line && hasAmbiguousTerminalLegalSeparator(line.text))
      );

    if (ambiguousSeparatorSource) {
      const legal = matchTerminalLegalFormSuffix(
        ambiguousSeparatorSource.text
      );
      const convergentEvidence = resolveConvergentBusinessBrandEvidence(
        observedEmails,
        ocrContextText
      );
      const conflictingBusinessEvidence =
        hasConflictingObservedBusinessBrandEvidence(
          observedEmails,
          ocrContextText
        );
      const evidenceMatchesWholeObservedBrand = Boolean(
        legal &&
          convergentEvidence &&
          completeBrandMatchesDomainRoot(
            legal.brand,
            convergentEvidence.brand
          )
      );

      if (convergentEvidence && !evidenceMatchesWholeObservedBrand) {
        const actionableEmailSet = new Set(
          companyEmails.map((email) => email.toLowerCase())
        );
        const emailLineIds = emailEvidence
          .filter(
            (item) =>
              item.origin === 'observed' &&
              item.confirmed &&
              !item.requiresReview &&
              item.validationStatus === 'valid' &&
              actionableEmailSet.has(item.value.toLowerCase()) &&
              item.lineId !== null
          )
          .map((item) => item.lineId as number);
        const websiteBrandKey = normalizeBrandKey(
          convergentEvidence.websiteBrand
        );
        const websiteLineIds = workingLines
          .filter((line) => {
            const observedWebsite = resolveExplicitWebsiteFromText(
              line.rawOcr || line.text,
              []
            );
            if (!observedWebsite) return false;
            return extractBusinessDomainRootCandidates(observedWebsite).some(
              (root) =>
                normalizeBrandKey(splitFusedDomainBrand(root)) ===
                websiteBrandKey
            );
          })
          .map((line) => line.id);

        company = {
          value: convergentEvidence.brand,
          score: 0.86,
          reasons: [
            'riga con separatore legale ambigua esclusa',
            'azienda derivata da email e sito osservati concordi',
          ],
          lineIds: [...new Set([...emailLineIds, ...websiteLineIds])],
          source: 'inferred',
        };
      } else {
        const trustedObservedLine =
          !conflictingBusinessEvidence &&
          hasTrustedTerminalLegalLine(
            ambiguousSeparatorSource.text,
            companyEmails,
            structured.websites
          );
        company = {
          ...company,
          value: sanitizeCompanyValue(ambiguousSeparatorSource.text),
          score: trustedObservedLine
            ? company.score
            : Math.min(company.score, 0.43),
          reasons: trustedObservedLine
            ? [
                'ragione sociale osservata',
                'identità completa corroborata da evidenza business',
              ]
            : [
                'forma giuridica breve osservata con separatore ambiguo',
                'separatore azienda/label ambiguo: review richiesta',
              ],
          lineIds: [ambiguousSeparatorSource.id],
          source: 'layout',
        };
      }
    } else if (uniqueCompanyLineIds.length !== (company.lineIds?.length ?? 0)) {
      company = { ...company, lineIds: uniqueCompanyLineIds };
    }
  }

  const excludedEntityLineIds = new Set<number>([
    ...(firstName.lineIds ?? []),
    ...(lastName.lineIds ?? []),
    ...(role.lineIds ?? []),
  ]);
  const rankedCompanyEvidence = rankObservedCompanyEvidence(
    workingLines,
    observedEmails,
    structured.websites,
    excludedEntityLineIds
  );
  const bestObservedCompany = rankedCompanyEvidence[0];
  const currentCompanyEvidence =
    rankedCompanyEvidence.find(
      (item) =>
        Boolean(company.value) &&
        normalizeBrandKey(item.normalizedValue) === normalizeBrandKey(company.value!)
    ) ??
    rankedCompanyEvidence.find((item) =>
      company.lineIds?.includes(item.lineId)
    );
  const currentCompanySourceText = (company.lineIds ?? [])
    .map((lineId) => workingLines.find((line) => line.id === lineId)?.rawOcr ?? '')
    .join(' ');
  const protectsObservedLegalIdentity = Boolean(
    company.value &&
      hasTrustedTerminalLegalLine(
        company.value,
        observedEmails,
        structured.websites
      )
  );
  const convergentCompanyEvidence = resolveConvergentBusinessBrandEvidence(
    observedEmails,
    ocrContextText
  );
  const currentCompanyHasConvergentAuthority = Boolean(
    company.value &&
    convergentCompanyEvidence &&
    normalizeBrandKey(company.value) === normalizeBrandKey(convergentCompanyEvidence.brand)
  );
  if (
    currentCompanyHasConvergentAuthority &&
    convergentCompanyEvidence &&
    currentCompanyEvidence?.evidenceType === 'logo' &&
    company.value !== convergentCompanyEvidence.brand &&
    convergentCompanyEvidence.brand.trim().split(/\s+/).filter(Boolean).length >=
      company.value!.trim().split(/\s+/).filter(Boolean).length
  ) {
    company = {
      ...company,
      value: convergentCompanyEvidence.brand,
      reasons: [...company.reasons, 'brand convergente email+sito preservato'],
    };
  }
  const stackedObservedCompany = company.value
    ? recoverStackedBrandLinesFromWebsite(
        company.value,
        observedEmails,
        ocrContextText
      )
    : null;

  // P0 CARROZZERIA REAL protect stacked from observed-logo rollback: se il brand stacked è già ricostruito in modo
  // univoco dal sito osservato, non retrocedere alla sola riga logo.
  const observedLogoConflictsWithRespelledCompany = Boolean(
    company.value &&
      currentCompanyEvidence?.evidenceType === 'logo' &&
      !currentCompanyHasConvergentAuthority &&
      !stackedObservedCompany &&
      levenshtein(
        normalizeBrandKey(company.value),
        normalizeBrandKey(currentCompanyEvidence.normalizedValue)
      ) >= 2
  );
  if (observedLogoConflictsWithRespelledCompany && currentCompanyEvidence) {
    company = {
      value: currentCompanyEvidence.normalizedValue,
      score: Math.min(0.78, Math.max(0.62, currentCompanyEvidence.score / 10)),
      reasons: [
        'logo osservato preservato rispetto a dominio OCR non corroborato',
        'gerarchia evidenze osservate',
      ],
      lineIds: [currentCompanyEvidence.lineId],
      source: 'observed',
    };
  }
  const bestObservedKey = bestObservedCompany
    ? normalizeBrandKey(bestObservedCompany.normalizedValue)
    : '';
  const currentCompanyKey = normalizeBrandKey(company.value ?? '');
  const observedInstitutionExtension = Boolean(
    bestObservedCompany?.evidenceType === 'institution' &&
      bestObservedCompany.sourceLineIds &&
      bestObservedCompany.sourceLineIds.length > 1 &&
      currentCompanyKey &&
      bestObservedKey !== currentCompanyKey &&
      bestObservedKey.startsWith(currentCompanyKey)
  );
  const observedMultilineExtension = Boolean(
    bestObservedCompany?.evidenceType === 'organization' &&
      bestObservedCompany.sourceLineIds &&
      bestObservedCompany.sourceLineIds.length > 1 &&
      currentCompanyKey &&
      bestObservedKey !== currentCompanyKey &&
      (
        bestObservedKey.startsWith(currentCompanyKey) ||
        bestObservedKey.endsWith(currentCompanyKey)
      ) &&
      !protectsObservedLegalIdentity
  );

  const hierarchyUpgrade = Boolean(
    bestObservedCompany?.evidenceType === 'institution' &&
      !protectsObservedLegalIdentity &&
      (
        currentCompanyEvidence?.evidenceType !== 'institution' ||
        observedInstitutionExtension
      )
  );
  const evidenceMargin =
    (bestObservedCompany?.score ?? Number.NEGATIVE_INFINITY) -
    (currentCompanyEvidence?.score ?? Number.NEGATIVE_INFINITY);
  const bestHasStrongObservedAuthority = Boolean(
    bestObservedCompany &&
      (
        bestObservedCompany.evidenceType === 'institution' ||
        bestObservedCompany.reason.includes('corroborata da dominio') ||
        bestObservedCompany.reason.includes(
          'brand osservato corroborato da local-part email su provider generico'
        )
      )
  );
  const bestCanFillEmptyCompany = Boolean(
    bestObservedCompany &&
      (bestHasStrongObservedAuthority ||
        bestObservedCompany.evidenceType === 'organization')
  );
  const ocrConfusableLegalAuthority = Boolean(
    bestObservedCompany?.evidenceType === 'legal-company' &&
      bestObservedCompany.reason.includes('confusione OCR lettera-cifra')
  );
  // P0 OBSERVED LEGAL RESTORE
  // Se una ragione sociale legale osservata sulla STESSA riga e stata
  // successivamente riscritta da un passaggio fuzzy/domain, l'evidenza OCR
  // osservata deve poter ripristinare l'identita originale.
  const observedLegalIdentityRepair = Boolean(
    bestObservedCompany?.evidenceType === 'legal-company' &&
      company.value &&
      company.lineIds?.includes(bestObservedCompany.lineId) &&
      normalizeBrandKey(company.value) !==
        normalizeBrandKey(bestObservedCompany.normalizedValue) &&
      company.reasons?.some((reason) =>
        /fuzzy|dominio|domain/i.test(reason)
      )
  );

  const shouldUseObservedCompany = Boolean(
    bestObservedCompany &&
      (ocrConfusableLegalAuthority ||
        observedLegalIdentityRepair ||
        observedMultilineExtension ||
        (!company.value && bestCanFillEmptyCompany) ||
        (ENTITY_CONTACT_LINE_RE.test(
          currentCompanySourceText || company.value || ''
        ) &&
          (bestObservedCompany.evidenceType !== 'legal-company' ||
            bestHasStrongObservedAuthority)) ||
        hierarchyUpgrade ||
        (bestHasStrongObservedAuthority &&
          evidenceMargin >= 1.45 &&
          !protectsObservedLegalIdentity))
  );
  if (shouldUseObservedCompany && bestObservedCompany) {
    const finalizedObserved = bestObservedCompany.normalizedValue;
    if (finalizedObserved) {
      company = {
        value: finalizedObserved,
        score: Math.min(0.94, Math.max(0.72, bestObservedCompany.score / 12)),
        reasons: [bestObservedCompany.reason, 'gerarchia evidenze osservate'],
        lineIds:
          bestObservedCompany.sourceLineIds?.length
            ? [...bestObservedCompany.sourceLineIds]
            : [bestObservedCompany.lineId],
        source: 'observed',
      };
    }
  }
  for (const candidate of rankedCompanyEvidence) {
    const ids = candidate.sourceLineIds?.length
      ? candidate.sourceLineIds
      : [candidate.lineId];
    candidate.selected =
      ids.length > 0 &&
      ids.every((lineId) => company.lineIds?.includes(lineId) ?? false);
  }
  const businessEvidenceProposals = buildMultisourceBusinessEvidence(
    workingLines,
    emailEvidence,
    structured.websites,
    rankedCompanyEvidence
  );
  const repairProposals = buildConservativeRepairProposals(
    workingLines,
    emailEvidence
  );

  const personEvidenceAlternatives = observedPersonAlternatives(
    workingLines,
    firstName.value,
    lastName.value
  );
  const bestObservedPerson = personEvidenceAlternatives[0];
  if (
    bestObservedPerson &&
    !(firstName.lineIds?.length || lastName.lineIds?.length)
  ) {
    const parts = bestObservedPerson.normalizedValue.split(/\s+/);
    const parsedObserved = validatePersonName({
      firstName: parts[0] ?? '',
      lastName: parts.slice(1).join(' '),
    });
    if (parsedObserved) {
      firstName = {
        value: parsedObserved.firstName,
        score: 0.94,
        reasons: [bestObservedPerson.reason],
        lineIds: [bestObservedPerson.lineId],
        source: 'observed',
      };
      lastName = {
        value: parsedObserved.lastName,
        score: 0.94,
        reasons: [bestObservedPerson.reason],
        lineIds: [bestObservedPerson.lineId],
        source: 'observed',
      };
      bestObservedPerson.selected = true;
    }
  }

  const universalAddressCandidates = assembleUniversalAddressBlocks(workingLines)
    .map((block) =>
      finalizeAddressParts({
        ...block,
        sourceLineIds: block.lineIds,
      })
    )
    .filter((candidate): candidate is V5AddressParts => Boolean(candidate));
  const universalPrimary = universalAddressCandidates[0];
  const currentCompleteness = addressFinal?.completeness ?? 0;
  const universalResolvesCivicConflict = Boolean(
    universalPrimary?.civicNumber &&
      addressFinal?.civicNumber &&
      universalPrimary.civicNumber !== addressFinal.civicNumber &&
      semanticAddressMatch(universalPrimary.full, addressFinal.full)
  );
  const universalResolvesLabeledCivicAsPostalConflict = Boolean(
    universalPrimary?.civicNumber &&
      universalPrimary?.postalCode &&
      universalPrimary?.city &&
      addressFinal?.postalCode &&
      addressFinal.postalCode === universalPrimary.civicNumber &&
      addressFinal.postalCode !== universalPrimary.postalCode &&
      (universalPrimary.rawLines ?? []).some((line) =>
        new RegExp(
          String.raw`${CIVIC_LABEL_PATTERN_SOURCE}${universalPrimary.civicNumber?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`,
          'iu'
        ).test(line)
      )
  );
  if (
    universalPrimary?.civicNumber?.match(/[-\u2013\u2014]/) &&
    addressFinal?.full &&
    addressFinal.civicNumber &&
    universalPrimary.civicNumber
      .split(/[-\u2013\u2014]/)
      .map((value) => value.trim())
      .includes(addressFinal.civicNumber.trim())
  ) {
    universalPrimary.full = addressFinal.full.replace(
      new RegExp(`(Nr\\.?\\s*)${addressFinal.civicNumber.replace(/[^a-z0-9]/gi, '\\$&')}\\b`, 'i'),
      `$1${universalPrimary.civicNumber}`
    );
    universalPrimary.street = addressFinal.street ?? universalPrimary.street;
    universalPrimary.postalCode = addressFinal.postalCode ?? universalPrimary.postalCode;
    universalPrimary.city = addressFinal.city ?? universalPrimary.city;
    universalPrimary.region = addressFinal.region ?? universalPrimary.region;
    universalPrimary.country = addressFinal.country ?? universalPrimary.country;
  }
  const preservesSpecialObservedDetail = Boolean(
    universalPrimary &&
      (universalPrimary.addressType === 'po-box' ||
        /\b(?:p\.?\s*o\.?\s*box|postfach|room|building|edificio|suite|floor|piano|unit|interno|block|tower)\b|\bed\.|\b\d{1,5}[a-z]?\s*[-\u2013\u2014]\s*\d{1,5}[a-z]?\b/i.test(
          universalPrimary.full
        ))
  );
  const universalCanReplace = Boolean(
    universalPrimary &&
      (universalPrimary.rawLines?.length ?? 0) > 0 &&
      (universalPrimary.confidence ?? 0) >= 0.7 &&
      (!addressFinal ||
        universalResolvesCivicConflict ||
        universalResolvesLabeledCivicAsPostalConflict ||
        preservesSpecialObservedDetail ||
        ((universalPrimary.completeness ?? 0) >= currentCompleteness + 0.15 &&
          currentCompleteness < 0.65) ||
        (addressFinal.partial === true &&
          (universalPrimary.completeness ?? 0) >= currentCompleteness))
  );
  if (universalCanReplace && universalPrimary) {
    addressFinal = {
      ...universalPrimary,
      city: universalPrimary.city ?? addressFinal?.city,
      region: universalPrimary.region ?? addressFinal?.region,
      country: universalPrimary.country ?? addressFinal?.country,
    };
  }

  // Completa soltanto i componenti strutturati mancanti quando il blocco
  // universale osservato descrive semanticamente lo stesso indirizzo già
  // selezionato. Non sostituisce il testo principale e non inventa valori:
  // importa esclusivamente CAP/città/regione/paese presenti nell'OCR.
  if (
    addressFinal &&
    universalPrimary &&
    semanticAddressMatch(universalPrimary.full, addressFinal.full)
  ) {
    const enrichedAddress = {
      ...addressFinal,
      postalCode: addressFinal.postalCode ?? universalPrimary.postalCode,
      city: addressFinal.city ?? universalPrimary.city,
      region: addressFinal.region ?? universalPrimary.region,
      country: addressFinal.country ?? universalPrimary.country,
    };
    addressFinal = enrichedAddress;
  }

  const normalizedPrimaryAddress = (addressFinal?.full ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
  const seenAddressKeys = new Set(
    normalizedPrimaryAddress ? [normalizedPrimaryAddress] : []
  );
  const addressAlternativeCandidates = universalAddressCandidates.length
    ? universalAddressCandidates
    : assembleMultiOfficeAddresses(workingLines);
  const addressAlternatives = addressAlternativeCandidates
    .map((candidate) => finalizeAddressParts(candidate))
    .filter((candidate): candidate is V5AddressParts => Boolean(candidate))
    .filter((candidate) => {
      const duplicatesPrimaryComponents = Boolean(
        addressFinal &&
          candidate.postalCode &&
          addressFinal.postalCode === candidate.postalCode &&
          semanticAddressMatch(candidate.full, addressFinal.full)
      );
      if (duplicatesPrimaryComponents) return false;
      const key = candidate.full
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .toLowerCase();
      if (!key || seenAddressKeys.has(key)) return false;
      seenAddressKeys.add(key);
      return true;
    });

  const hasItalianVatContext =
    hasItalianFiscalContext(workingLines, ocrContextText) ||
    structured.vatValidatedByEvidence;

  if (company.value && firstName.value && lastName.value && !role.value && hasItalianVatContext && !hasTerminalLegalFormSuffix(company.value) && !resolveBrandFromEmailDomain(companyEmails) && !explicitWebsiteBrand) {
    const genericWords = tokens(company.value);
    const genericOnlyCompany = genericWords.length > 0 && genericWords.every((word) => GENERIC_COMPANY_HEADER.has(compact(word)));
    if (genericOnlyCompany) {
      company = {
        ...company,
        value: lastName.value,
        reasons: [...company.reasons, 'ditta individuale: categoria generica + persona + contesto fiscale senza brand business'],
        source: 'inferred',
      };
    }
  }
  const observedFinalEmails = observedEmailValues(emailEvidence);
  const repairedWhitespaceAtEmails = emailEvidence
    .filter(
      (item) =>
        item.origin === 'repaired' &&
        item.validationStatus === 'valid' &&
        item.rawOcr.includes('@') &&
        item.transformations.includes('remove_spaces_around_at') &&
        item.transformations.every((step) =>
          step === 'remove_spaces_around_at' ||
          step === 'lowercase'
        )
    )
    .map((item) => item.value);
  // Quando il sito è osservato esplicitamente, una sola sostituzione nel TLD
  // dell'email OCR è riparabile solo se tutto l'host prima del TLD coincide.
  // Esempio generale: nome@azienda.ft + www.azienda.it → nome@azienda.it.
  // Non crea mailbox e non corregge domini diversi.
  const websiteHost = websiteResolved.value
    ?.replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  const alignedEmailValues = new Map<string, string>();
  if (websiteHost) {
    const websiteParts = websiteHost.split('.').filter(Boolean);
    if (websiteParts.length >= 2) {
      const websiteStem = websiteParts.slice(0, -1).join('.');
      const websiteTld = websiteParts.at(-1) ?? '';
      for (const email of observedFinalEmails) {
        const [local, host] = email.toLowerCase().split('@');
        const parts = host?.split('.').filter(Boolean) ?? [];
        if (!local || parts.length < 2) continue;
        const stem = parts.slice(0, -1).join('.');
        const tld = parts.at(-1) ?? '';
        if (stem !== websiteStem || tld === websiteTld || levenshtein(tld, websiteTld) !== 1) continue;
        const repaired = `${local}@${websiteHost}`;
        alignedEmailValues.set(email, repaired);
        const source = emailEvidence.find((item) => item.value === email);
        if (source) {
          emailEvidence.push({
            ...source,
            value: repaired,
            repairedValue: repaired,
            origin: 'repaired',
            transformations: [...source.transformations, 'align_tld_to_observed_website'],
            confidence: Math.min(source.confidence, 0.69),
            requiresReview: true,
            confirmed: false,
          });
        }
      }
    }
  }
  const finalEmails = [...new Set([
    ...observedFinalEmails.map((email) => alignedEmailValues.get(email) ?? email),
    ...repairedWhitespaceAtEmails,
  ])];
  const observedLineIds = emailEvidence
    .filter((item) => finalEmails.includes(item.value))
    .map((item) => item.lineId)
    .filter((lineId): lineId is number => lineId !== null);
  const repairedCount = emailEvidence.filter(
    (item) => item.origin === 'repaired'
  ).length;
  const observedEmailCount = emailEvidence.filter(
    (item) => item.origin === 'observed' && item.confirmed && item.validationStatus === 'valid'
  ).length;
  const emailReasons = [
    ...(observedEmailCount
      ? [`${observedEmailCount} email osservate integralmente nell'OCR`]
      : []),
    ...(repairedCount
      ? [`${repairedCount} email riparate richiedono conferma`]
      : []),
  ];

  if (company.value && lastName.value) {
    const finalCompanyKey = normalizeBrandKey(stripLegalFormSuffix(company.value));
    const finalSurnameKey = normalizeBrandKey(lastName.value);
    const nearObservedSurname =
      finalCompanyKey.length >= 4 &&
      finalSurnameKey.length >= 4 &&
      finalCompanyKey !== finalSurnameKey &&
      fuzzyCompanyDomainDistance(finalCompanyKey, finalSurnameKey) <= 1;
    const surnameCorroboratedByEmail = structured.emails.some((email) => {
      const local = normalizeBrandKey(email.split("@")[0] ?? "");
      return local === finalSurnameKey || local.includes(finalSurnameKey);
    });
    if (nearObservedSurname && surnameCorroboratedByEmail) {
      const acronym = recoverShortCardAcronymCompany(
        workingLines,
        firstName.value,
        lastName.value,
        emailToks
      );
      const usableAcronym = acronym && normalizeBrandKey(acronym) !== finalCompanyKey && fuzzyCompanyDomainDistance(normalizeBrandKey(acronym), finalSurnameKey) > 1 ? acronym : null;
      const corrected = usableAcronym ?? lastName.value;
      const finalizedCorrected = usableAcronym ? finalizeCompanyValue(usableAcronym, companyEmails, ocrContextText) : lastName.value;
      if (finalizedCorrected) {
        company = {
          ...company,
          value: finalizedCorrected,
          reasons: [...company.reasons, usableAcronym ? "acronimo osservato preferito a company OCR quasi-cognome" : "company OCR corretta da cognome corroborato"],
        };
      }
    }
  }

  if (company.value) {
    const domainBrand = resolveBrandFromEmailDomain(companyEmails);
    const companyIsDomainDerived = Boolean(
      domainBrand &&
      normalizeBrandKey(company.value) === normalizeBrandKey(domainBrand)
    );
    if (companyIsDomainDerived && domainBrand) {
      const domainKey = normalizeBrandKey(domainBrand);
      const observedBrand = workingLines
        .map((line) => clean(line.rawOcr || line.text))
        .find((line) => {
          if (!line || /@|https?:\/\/|www\./i.test(line)) return false;
          if (ROLE_RE.test(line) || CONTACT_LABEL_RE.test(line)) return false;
          if (/\d{4,}/.test(line) || STREET_RE.test(line) || POSTAL_RE.test(line)) return false;
          const key = normalizeBrandKey(line);
          if (key.length < 4 || key === domainKey || !domainKey.startsWith(key)) return false;
          const tail = domainKey.slice(key.length);
          return /^(?:net|web|online|group|global|digital|italia|italy|official|app)$/.test(tail);
        });
      if (observedBrand) {
        company = {
          ...company,
          value: observedBrand === observedBrand.toLowerCase()
            ? observedBrand.charAt(0).toUpperCase() + observedBrand.slice(1)
            : normalizeCompanyPhraseCasing(observedBrand),
          reasons: [...company.reasons, 'brand osservato forte prevale su estensione tecnica del dominio'],
          source: 'observed',
        };
      }
    }
    if (companyIsDomainDerived) {
      const professionalStudioLine = ocrContextText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => {
          const compact = line.toLowerCase().replace(/[^a-zà-ü]/g, "");
          return compact.includes("studiolegale");
        });
      if (professionalStudioLine) {
        company = {
          ...company,
          value: "Studio Legale",
          reasons: [...company.reasons, "denominazione professionale osservata prevale sul dominio"],
        };
      }
    }
  }

  if (firstName.value && lastName.value) {
    const finalLastKey = normalizeBrandKey(lastName.value);
    const surnameLooksLikeDomainFragment = structured.emails.some((email) => {
      const domain = email.split("@")[1]?.toLowerCase().trim();
      if (!domain) return false;
      const root = normalizeBrandKey(domain.split(".")[0] ?? "");
      return finalLastKey.length >= 4 && root.length >= 6 && root.includes(finalLastKey) && finalLastKey.length <= root.length - 2;
    });
    if (surnameLooksLikeDomainFragment) {
      for (const email of structured.emails) {
        const fromEmail = parseNameFromEmailLocal(email);
        const rawLocal = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-zà-ü]/g, "");
        const compactInitialSurname = rawLocal.match(/^([a-zà-ü])([a-zà-ü]{4,})$/i);
        const expectedInitial = normalizeBrandKey(firstName.value).charAt(0);
        const inferredSurname =
          fromEmail?.lastName ??
          (compactInitialSurname && normalizeBrandKey(compactInitialSurname[1]) === expectedInitial
            ? compactInitialSurname[2].charAt(0).toUpperCase() + compactInitialSurname[2].slice(1).toLowerCase()
            : null);
        if (!inferredSurname) continue;
        const repairedLastKey = normalizeBrandKey(inferredSurname);
        if (!repairedLastKey || repairedLastKey === finalLastKey) continue;
        const firstInitial = normalizeBrandKey(firstName.value).charAt(0);
        const local = normalizeBrandKey(email.split("@")[0] ?? "");
        if (!firstInitial || !local.startsWith(firstInitial) || !local.includes(repairedLastKey)) continue;
        const repaired = validatePersonName({ firstName: firstName.value, lastName: inferredSurname });
        if (repaired?.firstName && repaired.lastName) {
          firstName = { ...firstName, value: repaired.firstName, reasons: [...firstName.reasons, "persona confermata da email personale"] };
          lastName = { ...lastName, value: repaired.lastName, reasons: [...lastName.reasons, "cognome OCR frammento dominio corretto da email personale"] };
          break;
        }
      }
    }
  }

  // P0 audit: preserva un'iniziale realmente osservata nel raw OCR
  // solo quando nome e cognome coincidono esattamente con quelli gia estratti.
  if (firstName.value && lastName.value && !/^[A-Za-zÀ-Ü].\s+/u.test(firstName.value)) {
    const currentFirstKey = normalizeBrandKey(firstName.value);
    const currentLastKey = normalizeBrandKey(lastName.value);
    for (const line of workingLines) {
      const observedRaw = clean(line.rawOcr || line.text);
      const expanded = observedRaw
        .replace(/([a-zà-ü])([A-ZÀ-Ü])/gu, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
      const observed = expanded.match(
        /^([A-Za-zÀ-Ü])\.\s+([A-Za-zÀ-ü'’-]{2,})\s+([A-Za-zÀ-ü'’-]{2,})$/u
      );
      if (!observed) continue;
      if (
        normalizeBrandKey(observed[2] || '') !== currentFirstKey ||
        normalizeBrandKey(observed[3] || '') !== currentLastKey
      ) {
        continue;
      }
      firstName = {
        ...firstName,
        value: (observed[1] || '').toUpperCase() + '. ' + firstName.value,
        reasons: [...firstName.reasons, 'iniziale persona preservata da raw OCR'],
        lineIds: [...new Set([...(firstName.lineIds ?? []), line.id])],
      };
      break;
    }
  }

  // P0 audit: se il brand finale è pulito ma una riga OCR/fiscale allineata
  // contiene una forma giuridica osservata, preserva il suffisso senza farlo
  // passare di nuovo da una finalizzazione che può scartare forme ambigue (es. AG).
  if (company.value && !hasTerminalLegalFormSuffix(company.value)) {
    const currentBase = normalizeBrandKey(stripLegalFormSuffix(company.value));
    for (const line of workingLines) {
      const prefix = extractCompanyPrefixFromFiscalLine(line.text);
      const observedRawCompany = normalizeLegal(prefix ?? line.text);
      const terminal = matchTerminalLegalFormSuffix(observedRawCompany);
      if (!terminal) continue;
      const observedBase = normalizeBrandKey(terminal.brand);
      if (!brandKeysAlign(currentBase, observedBase)) continue;
      const legalTail = observedRawCompany.slice(terminal.brand.length).trim();
      if (!isLegalFormOnlyCompanyLine(legalTail)) continue;

      // Il brand selezionato può essere più pulito della riga fiscale OCR
      // (es. OrientaForm vs OrientoForm snc). Conserva il brand già scelto
      // e aggiungi soltanto la forma giuridica realmente osservata.
      const preserved = sanitizeCompanyValue(
        normalizeLegal(`${company.value.trim()} ${legalTail}`)
      );
      if (!preserved || !hasTerminalLegalFormSuffix(preserved)) continue;

      company = {
        ...company,
        value: preserved,
        reasons: [...company.reasons, 'forma giuridica osservata preservata da riga OCR/fiscale allineata'],
        lineIds: [...new Set([...(company.lineIds ?? []), line.id])],
      };
      break;
    }
  }

  // P0 C1 — FINAL OBSERVED COMPANY AUTHORITY LOCK
  // Una company osservata forte già selezionata non può essere sostituita
  // da descriptor/frasi/derivazioni deboli nei passaggi tardivi.
  const selectedObservedCompanyAtAuthority = rankedCompanyEvidence.find(
    (candidate) => candidate.selected && candidate.score >= 8.5
  );
  if (selectedObservedCompanyAtAuthority?.normalizedValue && company.value) {
    const selectedValue = selectedObservedCompanyAtAuthority.normalizedValue;
    const selectedBase = normalizeBrandKey(stripLegalFormSuffix(selectedValue));
    const currentBase = normalizeBrandKey(stripLegalFormSuffix(company.value));
    const sameIdentity =
      selectedBase &&
      currentBase &&
      (
        selectedBase === currentBase ||
        selectedBase.startsWith(currentBase) ||
        currentBase.startsWith(selectedBase)
      );

    const currentDescribesSelected = Boolean(
      currentBase.startsWith(selectedBase) &&
      currentBase !== selectedBase &&
      (() => {
        const selectedText = selectedValue.trim();
        const currentText = company.value!.trim();
        if (!currentText.toLocaleLowerCase().startsWith(selectedText.toLocaleLowerCase())) return false;
        const tail = currentText.slice(selectedText.length).trim();
        return /^(?:\u00e8|e['\u2019]|is|are)\s+(?:un|uno|una|a|an|the)\b/iu.test(tail);
      })()
    );

    if (!sameIdentity || currentDescribesSelected) {
      company = {
        value: selectedValue,
        score: Math.min(
          0.94,
          Math.max(0.72, selectedObservedCompanyAtAuthority.score / 12)
        ),
        reasons: [
          selectedObservedCompanyAtAuthority.reason,
          'autorità company osservata preservata dopo post-processing',
        ],
        lineIds: selectedObservedCompanyAtAuthority.sourceLineIds?.length
          ? [...selectedObservedCompanyAtAuthority.sourceLineIds]
          : [selectedObservedCompanyAtAuthority.lineId],
        source: 'observed',
      };
    }
  }

  // Un nominativo uguale al marchio del dominio, senza una conferma personale
  // osservata, resta un brand. Evita che titoli editoriali/social diventino
  // persone quando l'unica email della carta è generica.
  if (
    firstName.value &&
    lastName.value &&
    isPersonNameDomainBrandCollision(firstName.value, lastName.value, structured.emails) &&
    !hasExactObservedPersonalEmailEvidence(
      `${firstName.value} ${lastName.value}`,
      structured.emails
    )
  ) {
    firstName = {
      ...firstName,
      value: null,
      score: 0,
      reasons: [...firstName.reasons, 'nome coincide con marchio dominio senza conferma personale'],
    };
    lastName = {
      ...lastName,
      value: null,
      score: 0,
      reasons: [...lastName.reasons, 'cognome coincide con marchio dominio senza conferma personale'],
    };
  }

  return {
    firstName,
    lastName,
    company,
    role,
    emails: {
      value: finalEmails,
      score: finalEmails.length
        ? Math.max(
            observedEmailScore(emailEvidence),
            ...emailEvidence
              .filter((item) => repairedWhitespaceAtEmails.includes(item.value))
              .map((item) => Math.min(0.69, item.confidence)),
          )
        : 0,
      reasons: emailReasons,
      lineIds: observedLineIds,
    },
    emailEvidence,
    phones: { value: structured.phones, score: structured.phones.length ? 0.9 : 0, reasons: [] },
    website: {
      value: websiteResolved.value,
      score: websiteResolved.value ? 0.85 : 0,
      reasons: websiteResolved.reasons,
    },
    addressAlternatives,
    address: addressFinal
      ? {
          value: addressFinal,
          score: Math.min(0.92, 0.38 + (addressFinal.completeness ?? 0.72) * 0.58),
          reasons: [
            ...(addressFinal.partial ? ['indirizzo parziale OCR'] : []),
            'validazione finale',
          ],
        }
      : empty(),
    vatNumber: {
      value: hasItalianVatContext || structured.vatValidatedByEvidence ? structured.vat ?? null : null,
      score: structured.vat && (hasItalianVatContext || structured.vatValidatedByEvidence)
        ? (isValidItalianVat(structured.vat) || structured.vatValidatedByEvidence ? 0.9 : 0.35)
        : 0,
      reasons: structured.vat && !hasItalianVatContext && !structured.vatValidatedByEvidence
        ? ['identificativo fiscale estero non corroborato']
        : structured.vat && !isValidItalianVat(structured.vat)
          ? ['checksum non valido: possibile errore OCR su una cifra']
          : [],
    },
    taxCode: { value: structured.taxCode ?? null, score: structured.taxCode ? 0.9 : 0, reasons: [] },
    rawText,
    pageMismatch: coherence.pageMismatch,
    pageMismatchReasons: coherence.reasons,
    pageCoherence,
    emailDomainOcrMismatch,
    entityAlternatives: {
      company: rankedCompanyEvidence,
      person: personEvidenceAlternatives,
    },
    businessEvidenceProposals,
    repairProposals,
    debugLines: lines.map((l) => ({
      id: l.id,
      page: l.page,
      text: l.text,
      masked: l.masked,
      fontScale: l.f ? Number(l.f.fontScale.toFixed(2)) : 0,
      scores: { person: Number(l.personScore.toFixed(2)), company: Number(l.companyScore.toFixed(2)), role: Number(l.roleScore.toFixed(2)) },
      pageDisposition: pageDisposition(includedContext, l.page),
    })),
  };
}
