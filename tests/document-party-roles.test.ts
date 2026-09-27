import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';
import { applySemanticFallbackOverlay, buildSemanticFallbackExtraction } from '../lib/document-semantic-fallback';
import {
  isCustomerReferenceLabel,
  isImplausibleOrganizationName,
  isLegalSuffixOnly,
  isPartyLabelOnly,
  looksLikeAddressLikeOrganizationName,
  looksLikeDocumentIdentityAsOrganization,
  looksLikeOcrGarbageOrganization,
  looksLikePartySectionHeading,
  looksLikeRecipientSiteName,
  organizationNameAllowed,
  shouldReplacePartyValue,
} from '../lib/document-party-roles';
import { isCoherentOrganizationName, isPartyRoleAnchorText } from '../lib/document-party-blocks';

function line(text: string, x: number, y: number): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 420, height: 22 } };
}

function identity(lines: OcrLine[]) {
  const pages = classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]);
  return extractDocumentIdentity(pages, 'order');
}

test('1 issuer top block + bill-to block stay distinct', () => {
  const result = identity([
    line('Nordica Componenti S.r.l.', 40, 40),
    line('Via Industria 12', 40, 70),
    line('P.IVA 01234567890', 40, 100),
    line('FATTURARE A / BILL TO', 40, 280),
    line('Baltic Frozen Foods OÜ', 40, 310),
    line('Kaluri tee 5', 40, 340),
  ]);
  assert.notEqual(result.issuer?.name?.normalizedValue, result.customer?.name?.normalizedValue);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Baltic Frozen Foods/i);
  assert.notEqual(result.issuer?.name?.normalizedValue, 'Srl.');
});

test('2 customer-ref token near customer is not the party name', () => {
  const result = identity([
    line('Spettabile', 40, 240),
    line('Associazione Amici Trafoi', 40, 270),
    line('Rif. Cliente', 40, 300),
    line('CO17406', 40, 330),
  ]);
  assert.equal(result.customer?.name?.normalizedValue, 'Associazione Amici Trafoi');
});

test('2b customer-code labels are never the customer organization', () => {
  for (const label of [
    'Vostro codice cliente',
    'Codice cliente',
    'Riferimento cliente',
    'Rilerimento cliente',
    'Customer code',
    'Customer no.',
    'Customer number',
    'Client code',
    'Client n°',
    'Kundennummer',
    'Rif. Cliente',
    'Customer Ref.',
    'Customer Reference',
    'Rif. Cliente / Customer Ref.',
    'Customer Ref. / Rif. Cliente',
    'Riferimento Cliente / Customer Reference',
  ]) {
    assert.equal(isCustomerReferenceLabel(label), true, label);
    assert.equal(isPartyLabelOnly(label), true, label);
  }
  const result = identity([
    line('Nordica Componenti S.r.l.', 40, 40),
    line('Via Industria 12', 40, 70),
    line('P.IVA 01234567890', 40, 100),
    line('Vostro codice cliente', 620, 120),
    line('CHS001', 620, 150),
    line('CLIENTE / INTESTAZIONE FATTURA', 40, 260),
    line('Officina Beta Service', 40, 290),
    line('Via dell\'Artigianato, 12', 40, 320),
    line('P.IVA 02987670279', 40, 350),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Officina Beta Service/i);
  assert.equal(/codice cliente|CHS001/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('3 bank details below parties do not become issuer', () => {
  const result = identity([
    line('Alfa Componenti S.r.l.', 40, 40),
    line('P.IVA 01234567890', 40, 70),
    line('Spettabile', 40, 260),
    line('Beta Logistica S.r.l.', 40, 290),
    line('DATI BANCARI / BANK DETAILS', 40, 1100),
    line('Banca Intesa Sanpaolo S.p.A.', 40, 1130),
    line('IBAN IT60X0542811101000000123456', 40, 1160),
  ]);
  assert.equal(/Intesa|Sanpaolo/i.test(String(result.issuer?.name?.normalizedValue ?? '')), false);
});

test('4 label-only line is never a party name', () => {
  assert.equal(isPartyLabelOnly('Cliente'), true);
  assert.equal(isPartyLabelOnly('Sede legale e operativa'), true);
  assert.equal(isPartyLabelOnly('Bill To'), true);
  const result = identity([
    line('Cliente', 40, 260),
    line('Gamma Service S.r.l.', 40, 290),
  ]);
  assert.notEqual(result.customer?.name?.normalizedValue, 'Cliente');
});

test('5 legal suffix-only candidate is rejected', () => {
  assert.equal(isLegalSuffixOnly('Srl.'), true);
  assert.equal(isLegalSuffixOnly('GmbH'), true);
  assert.equal(isLegalSuffixOnly('Nordica Componenti S.r.l.'), false);
  const result = identity([
    line('Srl.', 40, 40),
    line('FATTURARE A / BILL TO', 40, 260),
    line('Delta Foods OÜ', 40, 290),
  ]);
  assert.notEqual(result.issuer?.name?.normalizedValue, 'Srl.');
});

test('6 missing issuer stays null rather than copying the customer', () => {
  const result = identity([
    line('PREVENTIVO N. 12/Z', 40, 40),
    line('Spett.le', 40, 260),
    line('CHIOZZA TOMMASO', 40, 290),
  ]);
  assert.equal(result.issuer?.name?.normalizedValue ?? null, null);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /CHIOZZA/i);
});

test('7 fallback cannot replace a coherent customer', () => {
  const pages = classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines: [
      line('Alfa Componenti S.r.l.', 40, 40),
      line('Spettabile', 40, 260),
      line('CHIOZZA TOMMASO', 40, 290),
      line('Tino Documento Di Chiusure', 40, 360),
    ],
    rawText: 'Alfa Componenti S.r.l.\nSpettabile\nCHIOZZA TOMMASO\nTino Documento Di Chiusure',
  }]);
  const primary = extractDocumentIdentity(pages, 'quote');
  const rawText = 'Alfa Componenti S.r.l.\nSpettabile\nCHIOZZA TOMMASO\nTino Documento Di Chiusure';
  const lineTexts = pages[0].lines.map((entry) => entry.text);
  const fallback = buildSemanticFallbackExtraction(
    'quote',
    rawText,
    lineTexts,
    'semantic_overlay',
  );
  const overlaid = applySemanticFallbackOverlay({
    schemaVersion: 1,
    metadata: primary.metadata,
    ...(primary.issuer ? { issuer: primary.issuer } : {}),
    ...(primary.customer ? { customer: primary.customer } : {}),
    items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: true },
    conditions: {},
    pages,
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [],
  }, 'quote', rawText, lineTexts);
  assert.equal(shouldReplacePartyValue('CHIOZZA TOMMASO', 'Tino Documento Di Chiusure'), false);
  assert.match(String(overlaid.customer?.name?.normalizedValue ?? primary.customer?.name?.normalizedValue ?? ''), /CHIOZZA/i);
  assert.ok(fallback);
});

test('8 label before value binds the customer below', () => {
  const result = identity([
    line('Nordica Componenti S.r.l.', 40, 40),
    line('P.IVA IT01234567890', 40, 70),
    line('BILL TO', 40, 280),
    line('Baltic Frozen Foods OÜ', 40, 310),
    line('VAT EE123456789', 40, 340),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Baltic Frozen Foods/i);
});

test('9 label after value binds the customer above', () => {
  const result = identity([
    line('Medisupply Horizon GmbH', 40, 40),
    line('VAT No.: DE 341 789 123', 40, 70),
    line('St. Raphael Community Clinic', 520, 300),
    line('BILL TO:', 720, 330),
    line('VAT No.: IE 3598761 KH', 520, 360),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Raphael/i);
  assert.equal(/Medisupply/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('10 value left of label is still the customer', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('St. Raphael Community Clinic', 200, 300),
    line('BILL TO:', 700, 300),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Raphael/i);
});

test('11 value right of label is still the customer', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('BILL TO:', 40, 300),
    line('Baltic Frozen Foods OÜ', 520, 300),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Baltic Frozen Foods/i);
});

test('12 reversed OCR sequence keeps bill-to as customer', () => {
  const result = identity([
    line('1 ud', 80, 80),
    line('Cantidad', 80, 200),
    line('Comunidad Residencial Mirador del Mar', 480, 520),
    line('DATOS DEL CLIENTE', 520, 560),
    line('CIF: B-98765432', 520, 600),
    line('EnerSoluciones Levante S.L.', 480, 820),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Mirador/i);
  assert.equal(/EnerSoluciones/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('13 issuer and bill-to both present stay exclusive', () => {
  const result = identity([
    line('Medisupply Horizon GmbH', 40, 40),
    line('VAT No.: DE 341 789 123', 40, 70),
    line('BILL TO:', 520, 300),
    line('St. Raphael Community Clinic', 520, 330),
    line('VAT No.: IE 3598761 KH', 520, 360),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /Medisupply/i);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Raphael/i);
  assert.notEqual(result.issuer?.name?.normalizedValue, result.customer?.name?.normalizedValue);
});

test('14 customer VAT stays in the customer block', () => {
  const result = identity([
    line('Medisupply Horizon GmbH', 40, 40),
    line('VAT No.: DE 341 789 123', 40, 70),
    line('BILL TO:', 520, 300),
    line('St. Raphael Community Clinic', 520, 330),
    line('VAT No.: IE 3598761 KH', 520, 360),
  ]);
  assert.match(String(result.customer?.vatNumber?.normalizedValue ?? ''), /IE3598761KH|IE 3598761/i);
  assert.equal(/DE341789123/i.test(String(result.customer?.vatNumber?.normalizedValue ?? '')), false);
});

test('15 issuer VAT must not become customer VAT', () => {
  const result = identity([
    line('Medisupply Horizon GmbH', 40, 40),
    line('VAT No.: DE 341 789 123', 40, 70),
    line('BILL TO:', 40, 300),
    line('St. Raphael Community Clinic', 40, 330),
  ]);
  assert.notEqual(result.customer?.vatNumber?.normalizedValue, result.issuer?.vatNumber?.normalizedValue);
});

test('16 bank block below customer is not the customer', () => {
  const result = identity([
    line('Alfa Componenti S.r.l.', 40, 40),
    line('Spettabile', 40, 260),
    line('Beta Logistica S.r.l.', 40, 290),
    line('DATI BANCARI', 40, 1100),
    line('Banca Intesa Sanpaolo S.p.A.', 40, 1130),
    line('IBAN IT60X0542811101000000123456', 40, 1160),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Beta Logistica/i);
  assert.equal(/Intesa|Sanpaolo/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('17 legal footer organization is not the customer', () => {
  const result = identity([
    line('DATOS DEL CLIENTE', 480, 300),
    line('Comunidad Residencial Mirador del Mar', 480, 330),
    line('Inscrita en el Registro Mercantil de Alicante, Tomo 4001', 40, 1200),
    line('EnerSoluciones Levante S.L.', 40, 1240),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Mirador/i);
});

test('18 same organization competing for both roles keeps issuer and rejects customer copy', () => {
  const result = identity([
    line('Medisupply Horizon GmbH', 40, 40),
    line('BILL TO:', 40, 300),
    line('Medisupply Horizon GmbH', 40, 330),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /Medisupply/i);
  assert.equal(result.customer?.name?.normalizedValue ?? null, null);
});

test('19 explicit customer block beats a nearby plural customer heading', () => {
  const result = identity([
    line('Kuenzi Group S.r.l.', 40, 40),
    line('Spettable', 520, 230),
    line('Associazione Amici Trafoi', 520, 258),
    line('Via Alpina, 5', 520, 290),
    line('39029 TRAFOI BZ', 520, 320),
    line('ADDETTO VENDITE', 480, 520),
    line('CLIENTI DIREZIONALI PROMOZIONALI', 500, 532),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Associazione Amici Trafoi/i);
  assert.equal(/DIREZIONALI|CLIENTI/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('20 all-caps plural customer category is a heading not an organization', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('Spettabile', 40, 260),
    line('Baltic Frozen Foods OÜ', 40, 290),
    line('CUSTOMER LIST', 40, 520),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Baltic Frozen Foods/i);
  assert.equal(/CUSTOMER LIST/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('21 Global Food dual-column bill-to keeps organization over street line', () => {
  assert.equal(isCoherentOrganizationName('Kaluri tee 5'), false);
  assert.equal(looksLikeAddressLikeOrganizationName('Kaluri tee 5'), true);
  const result = identity([
    line('Global Food Machinery S.r.l.', 40, 40),
    line('Via Industria 9', 40, 70),
    line('FATTURARE A / BILL TO', 204, 280),
    line('Baltic Frozen Foods OÜ', 202, 310),
    line('Kaluri tee 5', 200, 340),
    line('CONSEGNARE A / SHIP TO', 886, 280),
    line('Baltic Frozen Foods OÜ', 886, 310),
    line('Lagedi tee 7', 885, 340),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /Global Food Machinery/i);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Baltic Frozen Foods/i);
  assert.equal(/Kaluri tee/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
  assert.match(String(result.recipient?.name?.normalizedValue ?? ''), /Baltic Frozen Foods/i);
});

test('22 ALPINA bill-to organization beats recipient plant site label', () => {
  assert.equal(looksLikeRecipientSiteName('Stabilimento Rovereto'), true);
  const result = identity([
    line('ALPINA PROCESS SYSTEMS S.r.l.', 40, 40),
    line('FATTURARE A / BILL TO', 40, 300),
    line('TECNOIMPIANTI DEL GARDA S.p.A.', 40, 330),
    line('CONSEGNARE A / SHIP TO', 520, 300),
    line('Stabilimento Rovereto', 520, 330),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /ALPINA/i);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /TECNOIMPIANTI DEL GARDA/i);
  assert.match(String(result.recipient?.name?.normalizedValue ?? ''), /Stabilimento Rovereto/i);
});

test('21 bill-to organization with address outranks a promotional heading', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('BILL TO', 520, 240),
    line('Nordica Componenti S.r.l.', 520, 270),
    line('Via Industria 12', 520, 300),
    line('CLIENTI DIREZIONALI PROMOZIONALI', 80, 540),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Nordica Componenti/i);
});

test('22 marketing heading containing CUSTOMER is not the party name', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('Spettabile', 40, 260),
    line('Gamma Service S.r.l.', 40, 290),
    line('CUSTOMERS PREMIUM PROGRAM', 40, 500),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Gamma Service/i);
});

test('23 sales-contact label is not a customer anchor', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('Spettabile', 520, 240),
    line('Associazione Amici Trafoi', 520, 270),
    line('ADDETTO VENDITE', 40, 500),
    line('La Monica Irene', 200, 500),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Associazione Amici Trafoi/i);
  assert.equal(/Monica|DIREZIONALI/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('24 no real customer stays null instead of a section heading', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('CLIENTI DIREZIONALI PROMOZIONALI', 40, 500),
  ]);
  assert.equal(/DIREZIONALI|CLIENTI/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('25 destination heading cannot become customer', () => {
  assert.equal(looksLikePartySectionHeading('DESTINAZIONE MERCE / CONSEGNA'), true);
  assert.equal(isImplausibleOrganizationName('DESTINAZIONE MERCE / CONSEGNA'), true);
  const result = identity([
    line('Motorparts Delta S.r.l.', 40, 40),
    line('CLIENTE / INTESTAZIONE FATTURA', 40, 240),
    line('DESTINAZIONE MERCE / CONSEGNA', 520, 240),
    line('Autofficina Chiozza Service', 40, 270),
    line('Via dell\'Artigianato, 12', 40, 300),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Autofficina Chiozza Service/i);
  assert.equal(/DESTINAZ/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('26 OCR typo DESTINAZ1ONE is still a heading', () => {
  assert.equal(looksLikePartySectionHeading('DESTINAZ1ONE MERCE / CONSEGNA'), true);
  assert.equal(isImplausibleOrganizationName('DESTINAZ1ONE MERCE / CONSEGNA'), true);
  const result = identity([
    line('Motorparts Delta S.r.l.', 40, 40),
    line('CLIENTE / INTESTAZIONE FATTURA', 40, 240),
    line('DESTINAZ1ONE MERCE / CONSEGNA', 520, 240),
    line('Autofficina Chiozza Service', 40, 270),
    line('Via dell\'Artigianato, 12', 40, 300),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Autofficina Chiozza Service/i);
  assert.equal(/DESTINAZ/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('27 bill-to organization beats delivery heading', () => {
  const result = identity([
    line('Issuer Tools GmbH', 40, 40),
    line('FATTURARE A / BILL TO', 40, 240),
    line('SHIP TO', 520, 240),
    line('Nordica Componenti S.r.l.', 40, 270),
    line('Via Industria 12', 40, 300),
    line('DELIVERY ADDRESS', 520, 270),
    line('Magazzino Nord', 520, 300),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Nordica Componenti/i);
  assert.equal(/SHIP TO|DELIVERY|DESTINAZ/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('28 bilingual customer-ref slash labels are never organization names', () => {
  assert.equal(isCustomerReferenceLabel('Rif. Cliente / Customer Ref.'), true);
  assert.equal(isPartyLabelOnly('Rif. Cliente / Customer Ref.'), true);
  assert.equal(isPartyRoleAnchorText('Rif. Cliente / Customer Ref.'), false);
  assert.equal(isCoherentOrganizationName('Rif. Cliente / Customer Ref.'), false);
  assert.equal(organizationNameAllowed('Rif. Cliente / Customer Ref.'), false);
  assert.equal(isPartyRoleAnchorText('Cliente / Bill To:'), true);
  assert.equal(isCoherentOrganizationName('/ Bill To:'), false);
  assert.equal(isCoherentOrganizationName('Cliente / Bill To:'), false);
  const result = identity([
    line('ALPINA PROCESS SYSTEMS S.r.l.', 40, 40),
    line('Via Industriale, 12', 40, 70),
    line('Rif. Cliente / Customer Ref.', 620, 80),
    line('C-8841', 620, 110),
    line('Cliente / Bill To:', 40, 240),
    line('TECNOIMPIANTI DEL GARDA S.p.A.', 40, 270),
    line('Via dell\'Artigianato, 22', 40, 300),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /ALPINA PROCESS/i);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /TECNOIMPIANTI DEL GARDA/i);
  assert.equal(/Rif\. Cliente|Customer Ref/i.test(String(result.customer?.name?.normalizedValue ?? '')), false);
});

test('29 mixed-token OCR chrome is garbage even if one short token is not junk', () => {
  assert.equal(looksLikeOcrGarbageOrganization('ooo (ornkO'), true);
  assert.equal(looksLikeOcrGarbageOrganization('zxqwm kPl'), true);
  assert.equal(looksLikeOcrGarbageOrganization('EUROMEDITALY IBERICA S.L.'), false);
  const result = identity([
    line('ooo (ornkO', 80, 20),
    line('EUROMEDITALY IBERICA S.L.', 40, 80),
    line('Calle Industria 12', 40, 110),
    line('Datos del cliente', 40, 280),
    line('Hotel Mirador del Puerto S.A.', 40, 310),
    line('Avenida del Puerto 41', 40, 340),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /EUROMEDITALY/i);
  assert.doesNotMatch(String(result.issuer?.name?.normalizedValue ?? ''), /ooo|ornk/i);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Hotel Mirador/i);
});

test('30 document-identity lines are not organization names', () => {
  assert.equal(looksLikeDocumentIdentityAsOrganization('Auftragsnummer ORD-2026/143 vom 04/06/2026'), true);
  assert.equal(isCoherentOrganizationName('Auftragsnummer ORD-2026/143 vom 04/06/2026'), false);
  assert.equal(organizationNameAllowed('Auftragsnummer ORD-2026/143 vom 04/06/2026'), false);
  assert.equal(isImplausibleOrganizationName('Auftragsnummer ORD-2026/143 vom 04/06/2026'), true);
  const result = identity([
    line('Auftragsnummer ORD-2026/143 vom 04/06/2026', 500, 30),
    line('MOTORPARTS DELTA GMBH', 40, 90),
    line('Industriestrasse 22', 40, 120),
    line('70173 Stuttgart', 40, 150),
    line('Kunde', 40, 280),
    line('Autoteile Chiozza Service KG', 40, 310),
    line('Bahnhofstrasse 9', 40, 340),
  ]);
  assert.match(String(result.issuer?.name?.normalizedValue ?? ''), /MOTORPARTS DELTA/i);
  assert.doesNotMatch(String(result.issuer?.name?.normalizedValue ?? ''), /Auftragsnummer/i);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Autoteile Chiozza/i);
});
