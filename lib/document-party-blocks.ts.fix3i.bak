/**
 * Geometry-first organization blocks. Role labels may sit above, below,
 * left or right of the value; reading-order inversion must not swap roles.
 */
import type { DocumentLayoutLine, StructuredDocumentPage } from './document-structure';
import {
  classifyPartyNameRejection,
  looksLikeAddressLikeOrganizationName,
  looksLikeDeliveryRequestOrDateField,
  looksLikePartySectionHeading,
  looksLikeRecipientSiteName,
  organizationNameAllowed,
  organizationQualityScore,
  partyNameConfidence,
  resolveExclusivePartyRoles,
  samePartyName,
  isShortBrandOrganizationToken,
  looksLikeOcrGarbageOrganization,
  looksLikeDocumentIdentityAsOrganization,
  isCustomerReferenceLabel,
  isPartyLabelOnly,
  type PartyNameEvidence,
} from './document-party-roles';
import { logQaDocument } from './qa-document-logging';

export type PartyBlockRole = 'issuer' | 'customer' | 'recipient' | 'unknown';
export type ReadingDirection = 'ltr' | 'rtl' | 'ttb' | 'btt' | 'unknown';

export interface OrganizationBlock {
  nameCandidates: string[];
  primaryName?: string;
  nameLine?: DocumentLayoutLine;
  addressLines: string[];
  vatIdentifiers: string[];
  vatLine?: DocumentLayoutLine;
  email?: string;
  phone?: string;
  roleAnchor?: { text: string; role: PartyBlockRole; line: DocumentLayoutLine };
  roleEligibility?: PartyBlockRole;
  bbox?: { x: number; y: number; width: number; height: number };
  pageIndex: number;
  readingOrder: number;
  readingDirection: ReadingDirection;
  confidence: number;
  lines: DocumentLayoutLine[];
}

const ROLE_ANCHOR =
  /^(?:cliente|customer|client|kunde|comprador|bill[\s\-]*to|billed[\s\-]*to|sold[\s\-]*to|ship[\s\-]*to|fatturare\s+a|consegnare\s+a|datos\s+del\s+cliente|destinatario|destinazione(?:\s+merce)?|lieferadresse|lieferanschrift|adresse\s+de\s+livraison|spettabile|spettable|spett\.?\s*le|intestazione(?:\s+fattura)?|prospect|facturer\s+[àa]|factur[eé]\s*[àa]|client\s+factur[eé]|rechnung\s+an|rechnungsadresse)\s*:?$/i;
const CUSTOMER_ANCHOR =
  /\b(?:bill[\s\-]*to|billed[\s\-]*to|sold[\s\-]*to|fatturare\s+a|datos\s+del\s+cliente|cliente|customer|client|kunde|spettabile|spettable|spett\.?\s*le|intestazione(?:\s+fattura)?|client\s+factur[eé]|factur[eé]\s*[àa]|rechnung\s+an)\b/i;
const INLINE_CUSTOMER_PREFIX =
  /^(?:spettabile|spettable|spett\.?\s*le|cliente|customer|client|bill[\s\-]*to|billed[\s\-]*to|sold[\s\-]*to|kunde|factur[eé]\s*[àa]|facturer\s+[àa]|rechnung\s+an)\s*:?\s+/i;
const TAX_METADATA_SUFFIX =
  /\s+(?:[-–]\s*)?(?:p\.?\s*iva|partita\s+iva|vat(?:\s+(?:no\.?|number|id))?|tva|ust[\s.\-]*id(?:nr)?|mwst\.?|nif|cif|uid|codice\s+fiscale|c\.?\s*f\.?|tax\s+id)\s*[:\-]?\s*[A-Z]{0,3}[\dA-Z][\dA-Z\s.\-]{5,}.*$/i;
const RECIPIENT_ANCHOR =
  /\b(?:ship[\s\-]*to|consegnare\s+a|destinatario|destinazione(?:\s+merce)?|lieferadresse|adresse\s+de\s+livraison)\b/i;
const ADDRESS_SIGNAL =
  /\b(?:via|viale|piazza|corso|road|street|avenue|drive|park|warehouse|harbour|harbor|route|chemin|passeig|bahnhof|industriestr|werkstatt|rue|straße|strasse|calle|avenida|plaza|tee|gade|vej|väg|vag|katu|tänav|tnav|c\/)\b|\b\d{4,5}\s+[A-ZÀ-ÿ]|\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i;
const VAT_LABEL =
  /\b(?:p\.?\s*iva|partita\s+iva|vat(?:\s+(?:no\.?|number|id))?|tva|mwst|ust|nif|cif|uid)\b/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /\b(?:tel|phone|tel[eé]fono)\s*:?\s*(\+?[\d][\d\s()./-]{6,})/i;
const BANK_OR_LEGAL_FOOTER =
  /\b(?:iban|bic|swift|bankverbindung|dati\s+bancari|bank\s+details|registro\s+mercantil|iscritta|inscrita|hrb|handelsregister)\b/i;
const LEGAL_FORM =
  /\b(?:s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|sarl|gmbh|ltd\.?|inc\.?|bv|sl|ag|s\.?a\.?|o[uü])\b/i;
const TABLE_OR_FIELD_HEADING =
  /^(?:code(?:\s+article)?|item\s+code|codice|c[oó]digo|descripci[oó]n|description|d[eé]signation|bezeichnung|cantidad|quantit[eé]|quantity|q\.?t[aàeé]|qty|plazo de entrega|forma de pago|condiciones de|unit(?:\s+price)?|prezzo|prix|totale|total|iva|vat|tva|mwst|descuento|sconto|remise|artikelnummer|belegnummer|numero(?:\s+documento)?|document\s+no\.?|n[uú]mero|date(?:\s+d.?\s*[eé]mission)?|fecha(?:\s+de\s+emisi[oó]n)?|data(?:\s+documento)?|issue\s+date|belegdatum)\s*:?$/i;
const LEGAL_REGISTRATION_METADATA =
  /^(?:(?:compa[a-z]{0,3}ny|business)\s+)?(?:reg(?:istration)?|register)\.?\s*[,.:#\-]*(?:no\.?|number|n[°º])?\s*[:#\-]?\s*[A-Z0-9][A-Z0-9 ._\/-]{2,}$/i;

export function isPartyRoleAnchorText(value: string): boolean {
  const folded = value.trim().replace(/[:]+$/, '');
  if (!folded || folded.length > 64) return false;
  if (isCustomerReferenceLabel(folded)) return false;
  if (ROLE_ANCHOR.test(folded)) return true;
  const parts = folded.split(/\s*\/\s*/).map((part) => part.replace(/[:]+$/, '').trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((part) => ROLE_ANCHOR.test(part) && !isCustomerReferenceLabel(part));
}

export function roleFromAnchorText(value: string): PartyBlockRole {
  if (isCustomerReferenceLabel(value)) return 'unknown';
  if (RECIPIENT_ANCHOR.test(value) && !CUSTOMER_ANCHOR.test(value)) return 'recipient';
  if (CUSTOMER_ANCHOR.test(value) || ROLE_ANCHOR.test(value.trim().replace(/[:]+$/, ''))) return 'customer';
  return 'unknown';
}

export function stripTaxMetadataFromOrganizationLine(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(TAX_METADATA_SUFFIX, '')
    .replace(/\s*[-–]\s*$/, '')
    .trim();
}

const FUSED_CONTACT_CONTINUATION =
  /\s+(?:[-–]\s*)?(?:via|viale|v\.?|ve\.?|c\/|street|str(?:asse|\.)?|road|avenue|plaza|calle|piazza|corso|rue|route|chemin|bahnhof|\d{4,5}\b|tel|phone|tel[eé]fono|fax|e-?mail|mail|www\.|http|https)/i;

function isolateFusedOrganizationNameSegment(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed || !LEGAL_FORM.test(trimmed)) return trimmed;
  const legalMatch = trimmed.match(
    new RegExp(`^(.{2,120}?${LEGAL_FORM.source})(?:\\.|\\b)`, 'i'),
  );
  if (!legalMatch?.[1]) return trimmed;
  const candidate = legalMatch[1].trim().replace(/\s*[-–,]\s*$/, '');
  if (!candidate || candidate.length < 4) return trimmed;
  const rest = trimmed.slice(legalMatch.index! + legalMatch[0].length).trim();
  if (!rest) return candidate;
  if (
    FUSED_CONTACT_CONTINUATION.test(` ${rest}`)
    || EMAIL.test(rest)
    || /(?:^|\s)(?:web|www\.)/i.test(rest)
  ) {
    return candidate;
  }
  return trimmed;
}

export function organizationNameFromLine(value: string): {
  name: string;
  vat?: string;
  customerLabeled: boolean;
} {
  const raw = value.trim().replace(/\s+/g, ' ');
  const vat = extractVatToken(raw);
  const withoutTax = stripTaxMetadataFromOrganizationLine(raw);
  if (
    isCustomerReferenceLabel(withoutTax)
    || isPartyLabelOnly(withoutTax)
    || isPartyRoleAnchorText(withoutTax)
    || LEGAL_REGISTRATION_METADATA.test(withoutTax)
  ) {
    return { name: '', vat, customerLabeled: false };
  }
  const customerLabeled = INLINE_CUSTOMER_PREFIX.test(withoutTax) || CUSTOMER_ANCHOR.test(withoutTax);
  const name = isolateFusedOrganizationNameSegment(
    withoutTax.replace(INLINE_CUSTOMER_PREFIX, '').trim(),
  );
  if (!name || isCustomerReferenceLabel(name) || isPartyLabelOnly(name) || isPartyRoleAnchorText(name) || /^[/:|-]+/.test(name)) {
    return { name: customerLabeled ? '' : name, vat, customerLabeled: false };
  }
  return { name, vat, customerLabeled };
}

function isCustomerOnlyBlock(block: OrganizationBlock): boolean {
  return block.roleEligibility === 'customer'
    || block.roleAnchor?.role === 'customer'
    || block.roleAnchor?.role === 'recipient';
}

export function isCoherentOrganizationName(value: string): boolean {
  const extracted = organizationNameFromLine(value);
  const text = extracted.name.trim().replace(/\s+/g, ' ');
  if (!text) return false;
  if (classifyPartyNameRejection(text) && !isShortBrandOrganizationToken(text)) return false;
  if (looksLikeDeliveryRequestOrDateField(text) || looksLikeAddressLikeOrganizationName(text)) return false;
  if (looksLikeDocumentIdentityAsOrganization(text)) return false;
  if (TABLE_OR_FIELD_HEADING.test(text.replace(/[:]+$/, '')) || LEGAL_REGISTRATION_METADATA.test(text)) return false;
  if (ADDRESS_SIGNAL.test(text) || EMAIL.test(text) || VAT_LABEL.test(text)) return false;
  if (BANK_OR_LEGAL_FOOTER.test(text)) return false;
  if (/^(?:atenci[oó]n|tel[eé]fono|phone|email|www\.|accounts\s+payable|accounts\s+receivable|stores\s*\/\s*receiving)/i.test(text)) return false;
  const words = text.split(/\s+/).filter((word) => /[A-Za-z\u00c0-\u024f]{2,}/.test(word));
  if (words.length === 1 && /^(?:france|italy|italia|spain|espa[nñ]a|germany|deutschland|switzerland|suisse|austria|belgium|belgio|portugal|netherlands|europe|europa)$/i.test(text)) {
    return false;
  }
  if (looksLikeOcrGarbageOrganization(text)) return false;
  if (words.length >= 2) return true;
  if (isShortBrandOrganizationToken(text)) return true;
  const repairedDuplicate = text.replace(/^([A-Za-z\u00c0-\u024f])\1(?=[A-Za-z\u00c0-\u024f]{2})/i, '$1');
  if (repairedDuplicate !== text && isShortBrandOrganizationToken(repairedDuplicate)) return true;
  if (LEGAL_FORM.test(text) && text.replace(LEGAL_FORM, '').replace(/[.\s]/g, '').length >= 2) return true;
  return words.length === 1 && LEGAL_FORM.test(text) && text.length >= 8;
}

function blockNameEvidence(block: OrganizationBlock): PartyNameEvidence {
  return {
    hasAddress: block.addressLines.length > 0,
    hasPostal: block.addressLines.some((line) => /\b\d{4,5}\b/.test(line)),
    hasVat: block.vatIdentifiers.length > 0,
    hasPhone: !!block.phone,
    hasEmail: !!block.email,
    hasWebsite: block.lines.some((line) => /(?:https?:\/\/|www\.)/i.test(line.text)),
    hasLegalSuffix: LEGAL_FORM.test(block.primaryName ?? ''),
  };
}

function blockNameAllowed(block: OrganizationBlock): boolean {
  return organizationNameAllowed(block.primaryName, blockNameEvidence(block));
}

const INELIGIBLE_CUSTOMER_REGIONS = new Set([
  'commercial_table_body',
  'document_totals',
  'tax_recap',
  'historical_recap',
  'notes',
  'table_subtotal',
]);

function partyBlockEligibleForCustomer(block: OrganizationBlock): boolean {
  if (!blockNameAllowed(block)) return false;
  if (looksLikeRecipientSiteName(block.primaryName ?? '') && block.roleAnchor?.role !== 'customer') {
    return false;
  }
  const region = block.nameLine?.semanticRegion;
  if (!region || !INELIGIBLE_CUSTOMER_REGIONS.has(region)) return true;
  const labeled = block.roleAnchor?.role === 'customer' || block.roleAnchor?.role === 'recipient';
  if (!labeled) return false;
  return block.addressLines.length > 0
    || block.vatIdentifiers.length > 0
    || LEGAL_FORM.test(block.primaryName ?? '');
}

function boxCenter(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function lineDistance(anchor: DocumentLayoutLine, line: DocumentLayoutLine): number {
  if (!anchor.boundingBox || !line.boundingBox) {
    return Math.abs(anchor.readingOrder - line.readingOrder) * 40;
  }
  const left = boxCenter(anchor.boundingBox);
  const right = boxCenter(line.boundingBox);
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function unionBox(lines: readonly DocumentLayoutLine[]) {
  const boxes = lines.flatMap((line) => (line.boundingBox ? [line.boundingBox] : []));
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

function readingDirection(anchor: DocumentLayoutLine, value: DocumentLayoutLine): ReadingDirection {
  if (!anchor.boundingBox || !value.boundingBox) return 'unknown';
  const dx = boxCenter(value.boundingBox).x - boxCenter(anchor.boundingBox).x;
  const dy = boxCenter(value.boundingBox).y - boxCenter(anchor.boundingBox).y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'ltr' : 'rtl';
  return dy >= 0 ? 'ttb' : 'btt';
}

function extractVatToken(text: string): string | undefined {
  const match = text.match(
    /\b(?:p\.?\s*iva|partita\s+iva|vat(?:\s+(?:no\.?|number|id))?|tva|nif|cif|uid)\s*[:\-]?\s*([A-Z]{0,3}[A-Z0-9][A-Z0-9\s.\-]{6,18})\b/i,
  );
  if (!match?.[1]) return undefined;
  const compact = match[1].toUpperCase().replace(/[ .-]/g, '');
  if (/^PIVA/i.test(compact)) return compact.replace(/^PIVA/i, '');
  return compact.length >= 8 ? compact : undefined;
}

function nearbyRadius(page?: StructuredDocumentPage): number {
  const width = page?.width ?? 1000;
  const height = page?.height ?? 1400;
  return Math.max(220, Math.min(width, height) * 0.22);
}

export function collectOrganizationBlocks(
  pages: readonly StructuredDocumentPage[],
): OrganizationBlock[] {
  const blocks: OrganizationBlock[] = [];
  for (const page of pages) {
    const radius = nearbyRadius(page);
    const nameLines = page.lines.filter((line) => isCoherentOrganizationName(line.text));
    for (const nameLine of nameLines) {
      const cluster = page.lines.filter((line) => {
        if (line.pageIndex !== nameLine.pageIndex) return false;
        if (isPartyRoleAnchorText(line.text)) return true;
        const distance = lineDistance(nameLine, line);
        if (distance > radius) return false;
        if (BANK_OR_LEGAL_FOOTER.test(line.text) && distance > 80) return false;
        if (isCoherentOrganizationName(line.text) && line !== nameLine && distance > 140) return false;
        return (
          line === nameLine
          || ADDRESS_SIGNAL.test(line.text)
          || VAT_LABEL.test(line.text)
          || EMAIL.test(line.text)
          || PHONE.test(line.text)
          || isCoherentOrganizationName(line.text)
        );
      });
      const extracted = organizationNameFromLine(nameLine.text);
      const vatLine = cluster.find((line) => extractVatToken(line.text)) ?? (extracted.vat ? nameLine : undefined);
      const email = cluster.map((line) => line.text.match(EMAIL)?.[0]).find(Boolean);
      const phone = cluster.map((line) => line.text.match(PHONE)?.[1]).find(Boolean);
      const names = [...new Set(
        cluster.map((line) => organizationNameFromLine(line.text).name).filter((text) => isCoherentOrganizationName(text)),
      )].sort((left, right) => partyNameConfidence(right) - partyNameConfidence(left)
        || right.split(/\s+/).length - left.split(/\s+/).length);
      const primaryName = extracted.name && isCoherentOrganizationName(extracted.name)
        ? extracted.name
        : names[0];
      if (!primaryName) continue;
      const words = primaryName.split(/\s+/).filter(Boolean).length;
      const customerLabeled = extracted.customerLabeled;
      blocks.push({
        nameCandidates: names,
        primaryName,
        nameLine,
        addressLines: cluster.filter((line) => ADDRESS_SIGNAL.test(line.text)).map((line) => line.text),
        vatIdentifiers: extracted.vat
          ? [extracted.vat]
          : (vatLine && extractVatToken(vatLine.text) ? [extractVatToken(vatLine.text)!] : []),
        vatLine,
        email,
        phone,
        ...(customerLabeled ? {
          roleAnchor: { text: nameLine.text, role: 'customer' as const, line: nameLine },
          roleEligibility: 'customer' as const,
        } : { roleEligibility: 'unknown' as const }),
        bbox: unionBox(cluster),
        pageIndex: page.pageIndex,
        readingOrder: nameLine.readingOrder,
        readingDirection: 'unknown',
        confidence: partyNameConfidence(primaryName) + (words >= 2 ? 0.1 : 0) + (LEGAL_FORM.test(primaryName) ? 0.05 : 0),
        lines: cluster,
      });
    }
  }
  return dedupeBlocks(blocks);
}

function dedupeBlocks(blocks: readonly OrganizationBlock[]): OrganizationBlock[] {
  const out: OrganizationBlock[] = [];
  for (const block of [...blocks].sort((left, right) => right.confidence - left.confidence)) {
    const duplicate = out.find((existing) =>
      existing.pageIndex === block.pageIndex
      && samePartyName(existing.primaryName, block.primaryName)
      && existing.nameLine && block.nameLine
      && lineDistance(existing.nameLine, block.nameLine) < 80,
    );
    if (!duplicate) out.push(block);
  }
  return out;
}

function anchorMatchCost(anchor: DocumentLayoutLine, block: OrganizationBlock): number {
  const nameLine = block.nameLine;
  if (!nameLine) return Number.POSITIVE_INFINITY;
  let cost = lineDistance(anchor, nameLine);
  if (anchor.boundingBox && nameLine.boundingBox) {
    const dy = Math.abs(
      (nameLine.boundingBox.y + nameLine.boundingBox.height / 2)
      - (anchor.boundingBox.y + anchor.boundingBox.height / 2),
    );
    const dx = Math.abs(
      (nameLine.boundingBox.x + nameLine.boundingBox.width / 2)
      - (anchor.boundingBox.x + anchor.boundingBox.width / 2),
    );
    if (dy <= Math.max(40, anchor.boundingBox.height * 1.8)) cost *= 0.35;
    if (dx <= Math.max(80, anchor.boundingBox.width * 1.2)) cost *= 0.55;
    const anchorY = anchor.boundingBox.y;
    const nameY = nameLine.boundingBox.y;
    if (nameY >= anchorY - 8 && dx <= Math.max(140, anchor.boundingBox.width * 2.2)) cost *= 0.45;
    if (anchorY > 220 && nameY < 160) cost += 240;
  }
  return cost;
}

export function nearestOrganizationToAnchor(
  anchor: DocumentLayoutLine,
  blocks: readonly OrganizationBlock[],
): OrganizationBlock | undefined {
  const samePage = blocks.filter((block) => block.pageIndex === anchor.pageIndex && block.nameLine);
  if (samePage.length === 0) return undefined;
  return [...samePage].sort((left, right) => {
    const leftCost = anchorMatchCost(anchor, left);
    const rightCost = anchorMatchCost(anchor, right);
    if (Math.abs(leftCost - rightCost) > 12) return leftCost - rightCost;
    return right.confidence - left.confidence;
  })[0];
}

export function resolvePartyBlocksFromLayout(pages: readonly StructuredDocumentPage[]): {
  blocks: OrganizationBlock[];
  issuerCandidates: OrganizationBlock[];
  customerCandidates: OrganizationBlock[];
  recipientCandidates: OrganizationBlock[];
  customer?: OrganizationBlock;
  issuer?: OrganizationBlock;
  recipient?: OrganizationBlock;
} {
  const blocks = collectOrganizationBlocks(pages);
  const issuerQuality = (block: OrganizationBlock) =>
    organizationQualityScore(block.primaryName ?? '', blockNameEvidence(block));
  const issuerCandidates = blocks.filter((block) => {
    if (!block.primaryName || looksLikeOcrGarbageOrganization(block.primaryName)) return false;
    if (looksLikeDocumentIdentityAsOrganization(block.primaryName)) return false;
    if (isCustomerOnlyBlock(block)) return false;
    if (BANK_OR_LEGAL_FOOTER.test(block.primaryName)) return false;
    if (looksLikePartySectionHeading(block.primaryName)) return false;
    const quality = issuerQuality(block);
    return LEGAL_FORM.test(block.primaryName) || (block.primaryName.split(/\s+/).length >= 2 && quality >= 0.7);
  });
  const customerCandidates = blocks.filter((block) => {
    if (!block.primaryName || looksLikeOcrGarbageOrganization(block.primaryName)) return false;
    if (looksLikePartySectionHeading(block.primaryName)) return false;
    if (BANK_OR_LEGAL_FOOTER.test(block.primaryName)) return false;
    return partyBlockEligibleForCustomer(block);
  });
  const recipientCandidates = blocks.filter((block) => {
    if (!block.primaryName || looksLikeOcrGarbageOrganization(block.primaryName)) return false;
    if (looksLikePartySectionHeading(block.primaryName)) return false;
    return block.roleAnchor?.role === 'recipient' || RECIPIENT_ANCHOR.test(block.roleAnchor?.text ?? '');
  });
  const anchors = pages.flatMap((page) =>
    page.lines.filter((line) => isPartyRoleAnchorText(line.text)).map((line) => ({
      line,
      role: roleFromAnchorText(line.text),
    })),
  );
  let customer: OrganizationBlock | undefined;
  let recipient: OrganizationBlock | undefined;
  const bindAnchor = (anchor: { line: DocumentLayoutLine; role: PartyBlockRole }, claimedBlockIds: Set<string>) => {
    const pool = anchor.role === 'recipient' ? recipientCandidates : customerCandidates;
    const available = (pool.length > 0 ? pool : blocks).filter((block) => {
      if (block.nameLine?.id && claimedBlockIds.has(block.nameLine.id)) return false;
      if (!block.nameLine) return false;
      const nameLine = block.nameLine;
      if (anchor.role === 'recipient') {
        const customerAnchors = anchors.filter((entry) => entry.role !== 'recipient');
        const selfCost = lineDistance(anchor.line, nameLine);
        if (customerAnchors.some((other) => lineDistance(other.line, nameLine) + 12 < selfCost)) {
          return false;
        }
      }
      return true;
    });
    const customerZoneLineIds = new Set(
      pages
        .flatMap((page) => page.zones)
        .filter((zone) => zone.classification === 'customer')
        .flatMap((zone) => zone.lineIds),
    );
    const ranked = [...available].sort((left, right) => {
      if (anchor.role === 'customer') {
        const leftInCustomerZone = left.nameLine?.id && customerZoneLineIds.has(left.nameLine.id) ? 1 : 0;
        const rightInCustomerZone = right.nameLine?.id && customerZoneLineIds.has(right.nameLine.id) ? 1 : 0;
        if (leftInCustomerZone !== rightInCustomerZone) return rightInCustomerZone - leftInCustomerZone;
      }
      if (anchor.role === 'customer') {
        const leftSite = looksLikeRecipientSiteName(left.primaryName ?? '') ? 1 : 0;
        const rightSite = looksLikeRecipientSiteName(right.primaryName ?? '') ? 1 : 0;
        if (leftSite !== rightSite) return leftSite - rightSite;
      }
      const leftCost = anchorMatchCost(anchor.line, left);
      const rightCost = anchorMatchCost(anchor.line, right);
      if (Math.abs(leftCost - rightCost) > 12) return leftCost - rightCost;
      return right.confidence - left.confidence;
    });
    const nearest = ranked[0];
    if (!nearest) return;
    const bound: OrganizationBlock = {
      ...nearest,
      roleAnchor: { text: anchor.line.text, role: anchor.role, line: anchor.line },
      readingDirection: nearest.nameLine ? readingDirection(anchor.line, nearest.nameLine) : 'unknown',
      confidence: nearest.confidence + 0.2,
    };
    if (anchor.role === 'recipient' && !recipient) {
      if (blockNameAllowed(bound)) recipient = bound;
    } else if (!customer) {
      if (partyBlockEligibleForCustomer(bound)) customer = bound;
    }
  };
  const claimed = new Set<string>();
  for (const anchor of anchors.filter((entry) => entry.role === 'recipient')) {
    bindAnchor(anchor, claimed);
    if (recipient?.nameLine?.id) claimed.add(recipient.nameLine.id);
  }
  for (const anchor of anchors.filter((entry) => entry.role !== 'recipient')) {
    bindAnchor(anchor, claimed);
    if (customer?.nameLine?.id) claimed.add(customer.nameLine.id);
  }
  if (!customer) {
    const inlineCustomer = [...customerCandidates, ...blocks].find((block) =>
      isCustomerOnlyBlock(block)
      && partyBlockEligibleForCustomer(block)
      && !!block.primaryName
      && (!block.nameLine?.id || !claimed.has(block.nameLine.id)));
    if (inlineCustomer) {
      customer = inlineCustomer;
      if (inlineCustomer.nameLine?.id) claimed.add(inlineCustomer.nameLine.id);
    }
  }

  const issuer = [...issuerCandidates]
    .filter((block) => {
      if (isCustomerOnlyBlock(block)) return false;
      if (looksLikeOcrGarbageOrganization(block.primaryName ?? '')) return false;
      if (looksLikeDocumentIdentityAsOrganization(block.primaryName ?? '')) return false;
      if (issuerQuality(block) <= 0) return false;
      if (customer && samePartyName(customer.primaryName, block.primaryName) && (customer.roleAnchor || isCustomerOnlyBlock(customer))) {
        return false;
      }
      if (recipient && samePartyName(recipient.primaryName, block.primaryName)) return false;
      return true;
    })
    .sort((left, right) => {
      const leftLegal = LEGAL_FORM.test(left.primaryName ?? '') ? 1 : 0;
      const rightLegal = LEGAL_FORM.test(right.primaryName ?? '') ? 1 : 0;
      if (leftLegal !== rightLegal) return rightLegal - leftLegal;
      const leftQuality = issuerQuality(left);
      const rightQuality = issuerQuality(right);
      const leftHeader = (left.nameLine?.boundingBox?.y ?? 400) < 220 && leftQuality > 0 ? 1 : 0;
      const rightHeader = (right.nameLine?.boundingBox?.y ?? 400) < 220 && rightQuality > 0 ? 1 : 0;
      if (leftHeader !== rightHeader) return rightHeader - leftHeader;
      const quality = rightQuality - leftQuality;
      if (Math.abs(quality) > 0.05) return quality;
      return right.confidence - left.confidence;
    })[0];

  const completeness = (block: OrganizationBlock) => (
    (block.addressLines.length > 0 ? 2 : 0)
    + (block.vatIdentifiers.length > 0 ? 2 : 0)
    + (block.email ? 1 : 0)
    + (block.phone ? 1 : 0)
    + (LEGAL_FORM.test(block.primaryName ?? '') ? 1 : 0)
  );
  const headingCustomer = !customer?.primaryName || looksLikePartySectionHeading(customer.primaryName)
    || looksLikeRecipientSiteName(customer.primaryName ?? '')
    || (customer ? !blockNameAllowed(customer) : false);
  if (headingCustomer) {
    const completeCustomer = [...customerCandidates]
      .filter((block) => {
        if (issuer && samePartyName(issuer.primaryName, block.primaryName)) return false;
        if ((block.nameLine?.boundingBox?.y ?? 999) < 220 && LEGAL_FORM.test(block.primaryName ?? '') && !block.roleAnchor) {
          return false;
        }
        return completeness(block) >= 2;
      })
      .sort((left, right) => completeness(right) - completeness(left) || right.confidence - left.confidence)[0];
    if (completeCustomer) customer = completeCustomer;
    else customer = undefined;
  }

  const exclusive = resolveExclusivePartyRoles({
    issuer: issuer?.primaryName,
    customer: customer?.primaryName,
  });
  logQaDocument('PartyCandidate', {
    issuer: exclusive.issuer,
    customer: exclusive.customer,
    recipient: recipient?.primaryName,
    reason: customer?.roleAnchor ? 'labeled_block' : 'unlabeled_complete_block',
    customerConfidence: customer?.confidence,
  });
  return {
    blocks,
    issuerCandidates,
    customerCandidates,
    recipientCandidates,
    ...(exclusive.customer && customer ? { customer } : {}),
    ...(exclusive.issuer && issuer ? { issuer } : {}),
    ...(recipient && blockNameAllowed(recipient) && !samePartyName(recipient.primaryName, exclusive.issuer) ? { recipient } : {}),
  };
}

