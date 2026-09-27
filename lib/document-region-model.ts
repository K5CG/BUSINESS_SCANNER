import type {
  DocumentLayoutLine,
  DocumentZoneClassification,
  SemanticDocumentRegion,
  StructuredDocumentPage,
} from './document-structure';
import { logQaDocument } from './qa-document-logging';

const ZONE_TO_REGION: Partial<Record<DocumentZoneClassification, SemanticDocumentRegion>> = {
  header: 'header',
  issuer: 'issuer_block',
  customer: 'customer_block',
  metadata: 'document_identity',
  subject: 'references',
  items_table: 'commercial_table_body',
  tax_summary: 'tax_recap',
  totals: 'document_totals',
  payment: 'payment_terms',
  footer: 'footer',
  notes: 'notes',
};

const IDENTITY_LABEL =
  /\b(?:fattura\s+n\.?|n\.\s*fattura|invoice\s+no\.?|quote\s+no\.?|quotation\s+no\.?|preventivo\s+n\.?|ordine\s+n\.?|devis\s+n[°º.]?|facture\s+n[°º.]?|auftragsnummer|angebotsnummer|rechnungsnummer|presupuesto|pedido|bestellung)\b/i;

const PARTY_CUSTOMER =
  /\b(?:cliente|bill\s*to|customer|client|factur[eé]\s*[àa]|rechnungsadresse|rechnung\s+an|datos\s+del\s+cliente|spettabile|destinatario\s+fattura)\b/i;

const PARTY_SHIP =
  /\b(?:destinazione\s+merce|ship\s*to|delivery\s+address|lieferadresse|adresse\s+de\s+livraison|direcci[oó]n\s+de\s+entrega|consegna)\b/i;

const PARTY_ISSUER =
  /\b(?:fornitore|supplier|vendor|vendeur|proveedor|lieferant|emittente)\b/i;

const TABLE_HEADER =
  /\b(?:codice|descrizione|description|d[eé]signation|bezeichnung|cantidad|quantit|q\.?t[aàeé]|qty|prezzo|unit\s+price|sconto|discount|iva|vat|tva|mwst|importo|line\s+total|montant|gesamt)\b/i;

const TOTALS =
  /\b(?:imponibile|subtotal|subtotale|taxable|zwischensumme|base\s+imponib|totale\s+documento|grand\s+total|gesamtbetrag|total\s+ttc|totale\s+offerta|sconto\s+documento|spese?\s+trasporto)\b/i;

const TAX_RECAP =
  /\b(?:riepilogo(?:\s+iva)?|vat\s+recap|vat\s+summary|aliquota\s*\/\s*rate|tax\s+recap)\b/i;

const HISTORICAL_RECAP =
  /\b(?:resumen(?:\s+de\s+cantidades)?|r[ée]sum[eé]|zusammenfassung|historical|previous\s+orders|triennal[e]?|trienal|totale?\s+anno|annual\s+total|total\s+unidades\s+a[nñ]o|total\s+3\s+a[nñ]os|statistics)\b/i;

const CARRY_FORWARD =
  /\b(?:riporto(?:\s+(?:a|da)\s+pagina)?|a\s+riportare|carry(?:ed)?(?:\s+|-)forward|brought\s+forward|[uü]bertrag|subtotal\s+carried\s+forward|a\s+reporter)\b/i;

const PAYMENT_OR_NOTES =
  /\b(?:condizioni\s+di\s+pagamento|payment\s+terms|zahlungsbedingungen|observaciones|osservazioni|notes?:|iban|bic|swift)\b/i;

export function isCarryForwardText(text: string): boolean {
  return CARRY_FORWARD.test(text);
}

export function isHistoricalOrStatisticalRecapText(text: string): boolean {
  return HISTORICAL_RECAP.test(text);
}

export function isTaxRecapHeadingText(text: string): boolean {
  return TAX_RECAP.test(text);
}

export function looksLikeIsolatedOcrNoiseToken(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 8) return false;
  if (/\d/.test(trimmed)) return false;
  if (/[%€$£.,/-]/.test(trimmed)) return false;
  return /^[A-Za-zÀ-ÿ]{3,6}$/.test(trimmed);
}

export function classifySemanticRegion(
  text: string,
  zone?: DocumentZoneClassification,
): { region: SemanticDocumentRegion; confidence: number; reason: string } {
  const folded = text.replace(/\s+/g, ' ').trim();
  if (!folded) return { region: 'unknown', confidence: 0, reason: 'empty' };
  if (isCarryForwardText(folded)) {
    return { region: 'table_subtotal', confidence: 0.9, reason: 'carry_forward_label' };
  }
  if (isHistoricalOrStatisticalRecapText(folded)) {
    return { region: 'historical_recap', confidence: 0.88, reason: 'historical_or_statistical_recap' };
  }
  if (isTaxRecapHeadingText(folded)) {
    return { region: 'tax_recap', confidence: 0.9, reason: 'tax_recap_heading' };
  }
  if (IDENTITY_LABEL.test(folded)) {
    return { region: 'document_identity', confidence: 0.86, reason: 'document_number_label' };
  }
  if (PARTY_SHIP.test(folded)) {
    return { region: 'ship_to_block', confidence: 0.85, reason: 'ship_to_anchor' };
  }
  if (PARTY_CUSTOMER.test(folded)) {
    return { region: 'customer_block', confidence: 0.85, reason: 'customer_anchor' };
  }
  if (PARTY_ISSUER.test(folded)) {
    return { region: 'issuer_block', confidence: 0.8, reason: 'issuer_anchor' };
  }
  if (TOTALS.test(folded)) {
    return { region: 'document_totals', confidence: 0.82, reason: 'totals_label' };
  }
  if (PAYMENT_OR_NOTES.test(folded)) {
    return { region: 'payment_terms', confidence: 0.75, reason: 'payment_or_notes' };
  }
  if (TABLE_HEADER.test(folded) && folded.length <= 48) {
    return { region: 'commercial_table_header', confidence: 0.7, reason: 'table_header_token' };
  }
  if (zone && ZONE_TO_REGION[zone]) {
    return { region: ZONE_TO_REGION[zone]!, confidence: 0.55, reason: `zone_${zone}` };
  }
  return { region: 'unknown', confidence: 0.2, reason: 'unclassified' };
}

export function annotateDocumentRegions(
  pages: readonly StructuredDocumentPage[],
): StructuredDocumentPage[] {
  let recapLatch: SemanticDocumentRegion | undefined;
  const annotated = pages.map((page) => {
    const zoneByLine = new Map<string, DocumentZoneClassification>();
    for (const zone of page.zones) {
      for (const id of zone.lineIds) zoneByLine.set(id, zone.classification);
    }
    const lines = page.lines.map((line) => {
      const classified = classifySemanticRegion(line.text, zoneByLine.get(line.id));
      if (classified.region === 'historical_recap' || classified.region === 'tax_recap') {
        recapLatch = classified.region;
      } else if (
        recapLatch
        && classified.region !== 'document_totals'
        && classified.region !== 'commercial_table_header'
        && classified.region !== 'commercial_table_body'
      ) {
        if (classified.confidence < 0.75) {
          classified.region = recapLatch;
          classified.reason = `${classified.reason}+latched_recap`;
        }
      } else if (classified.region === 'commercial_table_header' || classified.region === 'commercial_table_body') {
        recapLatch = undefined;
      }
      const next: DocumentLayoutLine = {
        ...line,
        semanticRegion: classified.region,
        regionConfidence: classified.confidence,
      };
      if (classified.confidence >= 0.7) {
        logQaDocument('DocumentRegion', {
          page: line.pageIndex,
          region: classified.region,
          confidence: classified.confidence,
          reason: classified.reason,
          lineId: line.id,
        });
      }
      return next;
    });
    return { ...page, lines };
  });
  return annotated;
}

export function lineRegion(line: DocumentLayoutLine): SemanticDocumentRegion {
  return line.semanticRegion ?? 'unknown';
}

export function isNonCommercialRegion(region: SemanticDocumentRegion | undefined): boolean {
  return region === 'historical_recap'
    || region === 'statistical_recap'
    || region === 'tax_recap'
    || region === 'footer'
    || region === 'notes'
    || region === 'payment_terms'
    || region === 'table_subtotal';
}
