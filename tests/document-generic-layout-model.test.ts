import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';
import { extractDocumentItemsAndTotals, detectDocumentTableColumnFast } from '../lib/document-items-totals';
import { isImplausibleOrganizationName, organizationNameAllowed } from '../lib/document-party-roles';
import { classifyMoneyLabel } from '../lib/document-money-semantics';
import {
  classifySemanticRegion,
  isCarryForwardText,
  isHistoricalOrStatisticalRecapText,
  annotateDocumentRegions,
} from '../lib/document-region-model';
import { classifyTableHeading, isSummaryOrAggregateHeading } from '../lib/document-table-hierarchy';
import { parseInternationalAmount } from '../lib/document-international-values';

function line(text: string, x: number, y: number, width = 90, height = 22): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height } };
}

function layout(lines: OcrLine[], width = 1400, height = 1800) {
  return annotateDocumentRegions(classifyDocumentLayoutPages([{
    pageIndex: 0,
    width,
    height,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]));
}

function layoutPages(pages: OcrLine[][], width = 1400, height = 1800) {
  return annotateDocumentRegions(classifyDocumentLayoutPages(pages.map((lines, pageIndex) => ({
    pageIndex,
    width,
    height,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }))));
}

function identity(lines: OcrLine[]) {
  return extractDocumentIdentity(layout(lines), 'invoice');
}

test('document identity: type word + hyphen number on same line', () => {
  const result = identity([
    line('FACTURE DEV-2026-0612', 400, 40, 280),
    line('du 30/06/2026', 400, 70),
  ]);
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'DEV-2026-0612');
});

test('document identity: Auftragsnummer keeps prefix before year/slash and binds order date/type', () => {
  const result = identity([
    line('AUFTRAGSBESTÄTIGUNG', 80, 20, 300),
    line('Auftragsnummer ORD-2026/143 vom 04/06/2026', 80, 40, 420),
  ]);
  assert.equal(result.metadata.documentType?.normalizedValue, 'order');
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'ORD-2026/143');
  assert.equal(result.metadata.issueDate?.normalizedValue, '2026-06-04');
});

test('document identity: OCR FATTURAN. without whitespace still binds the inline date', () => {
  const result = identity([
    line('FATTURA', 80, 20, 160),
    line('FATTURAN. FT-2026-0412', 80, 40, 320),
    line('del 12/06/2026', 80, 70, 180),
  ]);
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'FT-2026-0412');
  assert.equal(result.metadata.issueDate?.normalizedValue, '2026-06-12');
});

test('document identity: customer reference does not beat type-labeled number', () => {
  const result = identity([
    line('PRESUPUESTO PRES-2026-0478', 80, 40, 320),
    line('Referencia cliente: RM-2026-88', 80, 80, 280),
  ]);
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'PRES-2026-0478');
});

test('document identity: label above value and fragmented tail', () => {
  const result = identity([
    line('N. Preventivo / Quotation No.', 500, 40, 260),
    line('QTN-2026-0816-L', 500, 70, 180),
  ]);
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'QTN-2026-0816-L');
});

test('parties: short OCR junk is not an organization name', () => {
  assert.equal(isImplausibleOrganizationName('Ctrl'), true);
  assert.equal(isImplausibleOrganizationName('Institute of Marine Geoscience Research'), false);
});

test('parties: hyphenated bill-to binds the left organization, not ship-to OCR junk', () => {
  const result = identity([
    line('NORTHSHORE LAB SUPPLIES LTD', 40, 30, 280),
    line('48 Harbour Science Park', 40, 55, 220),
    line('Aberdeen AB11 5XY', 40, 80, 180),
    line('United Kingdom', 40, 105, 140),
    line('Bill-to:', 40, 160, 80),
    line('Ship-to:', 520, 160, 80),
    line('Ctrl', 900, 160, 40),
    line('Institute of Marine Geoscience Research', 40, 190, 320),
    line('17 Oceanic Drive', 40, 215, 160),
    line('Dock Warehouse 3', 520, 190, 180),
    line('South Pier Road', 520, 215, 160),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Institute of Marine/i);
  assert.doesNotMatch(String(result.customer?.name?.normalizedValue ?? ''), /Aberdeen|Ctrl|United Kingdom/i);
  assert.notEqual(String(result.recipient?.name?.normalizedValue ?? ''), 'Ctrl');
});

test('parties: delivery-date request is not a customer name', () => {
  const result = identity([
    line('ATELIER THERMOFLUX SARL', 40, 30, 280),
    line('12 rue des Forges', 40, 55, 200),
    line('69007 Lyon', 40, 80, 140),
    line('Livraison souhaitée: 05/07/2026', 40, 110, 260),
    line('Domaine des Hautes Collines', 420, 140, 280),
    line('18 route des Vignes', 420, 165, 220),
    line('84100 Orange', 420, 190, 160),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Hautes Collines/i);
  assert.doesNotMatch(String(result.customer?.name?.normalizedValue ?? ''), /Livraison/i);
});

test('parties: unlabeled legal-name block with route address becomes customer', () => {
  const result = identity([
    line('ATELIER THERMOFLUX SARL', 40, 30, 280),
    line('12 rue des Forges', 40, 55, 200),
    line('69007 Lyon', 40, 80, 140),
    line('Domaine des Hautes Collines', 420, 140, 280),
    line('18 route des Vignes', 420, 165, 220),
    line('84100 Orange', 420, 190, 160),
    line('Désignation', 40, 360, 140),
    line('Qté', 520, 360, 50),
  ]);
  assert.match(String(result.customer?.name?.normalizedValue ?? ''), /Hautes Collines/i);
});

test('table headers: multilingual VAT/discount/price tokens stay distinct', () => {
  assert.equal(detectDocumentTableColumnFast('VAT %'), 'vatRate');
  assert.equal(detectDocumentTableColumnFast('IVA %'), 'vatRate');
  assert.equal(detectDocumentTableColumnFast('VA %'), 'vatRate');
  assert.equal(detectDocumentTableColumnFast('MwSt %'), 'vatRate');
  assert.equal(detectDocumentTableColumnFast('Discount %'), 'discount');
  assert.equal(detectDocumentTableColumnFast('Desc. %'), 'discount');
  assert.equal(detectDocumentTableColumnFast('Rem. %'), 'discount');
  assert.equal(detectDocumentTableColumnFast('P. Unitario'), 'unitPrice');
  assert.equal(detectDocumentTableColumnFast('Cant.'), 'quantity');
  assert.equal(detectDocumentTableColumnFast('Montant HT'), 'lineTotal');
  assert.equal(detectDocumentTableColumnFast('Gesamt'), 'lineTotal');
});

test('parties: totals labels are not organization names', () => {
  assert.equal(isImplausibleOrganizationName('Goods subtotal'), true);
  assert.equal(isImplausibleOrganizationName('Montant HT'), true);
});

test('French space-grouped line total stays in Montant HT, not quantity', () => {
  const pages = layout([
    line('Réf.', 40, 120, 50),
    line('Désignation', 140, 120, 140),
    line('Qté', 500, 120, 40),
    line('PU HT (E)', 600, 120, 90),
    line('Rem. %', 760, 120, 70),
    line('TVA', 880, 120, 40),
    line('Montant HT', 1000, 120, 100),
    line('ECH-90', 40, 180, 70),
    line('Echangeur modulaire inox', 140, 180, 200),
    line('2', 500, 180, 20),
    line('4 500,00', 600, 180, 80),
    line('20', 880, 180, 30),
    line('9 000,00', 1000, 180, 90),
    line('Base taxable', 700, 280, 140),
    line('9 000,00', 1000, 280, 90),
    line('TVA 20', 700, 310, 70),
    line('1 800,00', 1000, 310, 80),
    line('Total TTC', 700, 340, 90),
    line('10 800,00', 1000, 340, 90),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 2);
  assert.equal(extraction.items[0]?.unitPrice?.normalizedValue, 4500);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 9000);
  assert.equal(extraction.items[0]?.vatRate?.normalizedValue, 20);
});

test('skewed rightmost Montant HT stays on the same commercial row', () => {
  const pages = layout([
    line('Réf.', 131, 862, 56),
    line('Désignation', 405, 862, 184),
    line('Qté', 797, 885, 48),
    line('PU HT (E)', 936, 893, 136),
    line('Rem. %', 1142, 905, 108),
    line('TVA', 1316, 906, 61),
    line('Montant HT', 1457, 901, 165),
    line('ECH-90', 80, 956, 116),
    line('Echangeur modulaire inox', 283, 951, 407),
    line('2', 809, 975, 17),
    line('4 500,00', 941, 983, 125),
    line('20', 1328, 993, 35),
    line('9 000,00', 1508, 991, 132),
    line('KIT-TUY', 79, 1055, 124),
    line('Kit de tuyauterie DN50', 283, 1052, 360),
    line('5', 809, 1075, 20),
    line('790,00', 941, 1078, 90),
    line('0', 1160, 1080, 20),
    line('20', 1328, 1082, 30),
    line('3 950,00', 1508, 1080, 120),
    line('Base taxable', 700, 1280, 140),
    line('12 950,00', 1508, 1280, 120),
    line('TVA 20', 700, 1310, 70),
    line('2 590,00', 1508, 1310, 100),
    line('Total TTC', 700, 1340, 90),
    line('15 540,00', 1508, 1340, 110),
  ], 3060, 4080);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 2);
  assert.equal(extraction.items[0]?.unitPrice?.normalizedValue, 4500);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 9000);
  assert.equal(extraction.items[0]?.vatRate?.normalizedValue, 20);
});

test('item-code between numeric bands keeps two commercial rows', () => {
  const pages = layout([
    line('Codice', 40, 120, 80),
    line('Descrizione', 160, 120, 160),
    line('Q.tà', 520, 120, 50),
    line('Prezzo', 640, 120, 80),
    line('IVA %', 900, 120, 50),
    line('Totale riga', 1040, 120, 90),
    line('VAL-MOT-230', 40, 180, 120),
    line('Valvola motorizzata wrapping onto the next band', 160, 180, 300),
    line('4', 520, 180, 20),
    line('1.250,00', 640, 180, 80),
    line('22', 900, 180, 30),
    line('4.500,00', 1040, 210, 80),
    line('SEN-LIV-CLP', 40, 220, 120),
    line('Sensore di livello capacitivo', 160, 220, 240),
    line('6', 520, 225, 20),
    line('285,00', 640, 225, 70),
    line('22', 900, 225, 30),
    line('1.569,60', 1040, 225, 80),
    line('Imponibile', 700, 320, 120),
    line('6.069,60', 1040, 320, 80),
    line('Totale documento', 700, 360, 140),
    line('7.404,91', 1040, 360, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.match(extraction.items[0]?.description?.normalizedValue ?? '', /Valvola/);
  assert.match(extraction.items[1]?.description?.normalizedValue ?? '', /Sensore/);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 4);
  assert.equal(extraction.items[1]?.quantity?.normalizedValue, 6);
});

test('VAT column without discount does not manufacture discounts from 20', () => {
  const pages = layout([
    line('Code', 40, 120, 70),
    line('Description', 140, 120, 160),
    line('Qty', 500, 120, 40),
    line('Unit Price', 600, 120, 110),
    line('Discount %', 780, 120, 90),
    line('VAT %', 900, 120, 60),
    line('Line Total', 1020, 120, 90),
    line('PMP-110', 40, 170, 80),
    line('Peristaltic pump', 140, 170, 180),
    line('1', 500, 170, 30),
    line('2,100.00', 600, 170, 80),
    line('20', 900, 170, 40),
    line('2,100.00', 1020, 170, 80),
    line('Taxable subtotal', 700, 280, 160),
    line('2,100.00', 1020, 280, 80),
    line('VAT 20%', 700, 310, 80),
    line('420.00', 1020, 310, 70),
    line('Grand total', 700, 340, 120),
    line('2,520.00', 1020, 340, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.vatRate?.normalizedValue, 20);
  assert.equal(extraction.items[0]?.discount?.normalizedValue ?? 0, 0);
});

test('numeric prose in description stays text, not quantity', () => {
  const pages = layout([
    line('Codice', 40, 120, 80),
    line('Descrizione', 160, 120, 180),
    line('Q.tà', 620, 120, 50),
    line('Prezzo unit.', 720, 120, 110),
    line('IVA %', 980, 120, 50),
    line('Totale riga', 1100, 120, 90),
    line('SEN-01', 40, 180, 80),
    line('uscita 4-20 mA, alimentazione 24V DC, cavo 5 m IP67', 160, 180, 420),
    line('2', 620, 180, 30),
    line('100,00', 720, 180, 70),
    line('22', 980, 180, 30),
    line('200,00', 1100, 180, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 2);
  assert.match(String(extraction.items[0]?.description?.normalizedValue ?? ''), /4-20 mA/);
});

test('recap and carry-forward are not commercial items', () => {
  assert.equal(isHistoricalOrStatisticalRecapText('Resumen de cantidades trienal'), true);
  assert.equal(classifyTableHeading('TOTAL 3 AÑOS'), 'aggregate_summary');
  assert.equal(isSummaryOrAggregateHeading('Total unidades año 1'), true);
  assert.equal(isCarryForwardText('Riporto da pagina 1: 63.109,30'), true);
  const pages = layout([
    line('Código', 40, 120, 70),
    line('Descripción', 140, 120, 140),
    line('Cant.', 500, 120, 50),
    line('P. Unitario', 600, 120, 100),
    line('IVA %', 900, 120, 50),
    line('Importe', 1040, 120, 80),
    line('SILLA-AL', 40, 170, 80),
    line('Silla aluminio', 140, 170, 160),
    line('2', 500, 170, 30),
    line('200,00', 600, 170, 70),
    line('21', 900, 170, 30),
    line('400,00', 1040, 170, 70),
    line('Resumen de cantidades trienal', 140, 280, 260),
    line('Total unidades año 1', 140, 310, 200),
    line('42 unidades', 500, 310, 90),
    line('TOTAL 3 AÑOS', 140, 360, 140),
    line('Base imponible neta', 700, 420, 180),
    line('400,00', 1040, 420, 70),
    line('IVA 21%', 700, 450, 80),
    line('84,00', 1040, 450, 70),
    line('TOTAL', 700, 480, 70),
    line('484,00', 1040, 480, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items.some((item) => /resumen|unidades|años/i.test(item.description?.normalizedValue ?? '')), false);
});

test('zero-price row with VAT is kept', () => {
  const pages = layout([
    line('Artikel', 40, 120, 80),
    line('Beschreibung', 160, 120, 160),
    line('Menge', 520, 120, 60),
    line('Preis', 640, 120, 70),
    line('Rabatt %', 780, 120, 70),
    line('MwSt %', 900, 120, 60),
    line('Gesamt', 1040, 120, 70),
    line('FREI-LOG', 40, 180, 90),
    line('Logo-Datensatz / kostenlose Einrichtung', 160, 180, 280),
    line('1', 520, 180, 30),
    line('0,00', 640, 180, 50),
    line('0', 780, 180, 30),
    line('19', 900, 180, 30),
    line('0,00', 1040, 180, 50),
    line('Zwischensumme', 700, 280, 140),
    line('0,00', 1040, 280, 50),
    line('MwSt 19%', 700, 310, 90),
    line('0,00', 1040, 310, 50),
    line('Gesamtbetrag', 700, 340, 120),
    line('0,00', 1040, 340, 50),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.unitPrice?.normalizedValue, 0);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 0);
  assert.equal(extraction.items[0]?.vatRate?.normalizedValue, 19);
});

test('document discount label is not a VAT rate or subtotal', () => {
  assert.equal(classifyMoneyLabel('Sconto documento 2%'), 'discount');
  assert.equal(classifyMoneyLabel('Imponibile merce'), 'net_taxable');
  assert.equal(classifyMoneyLabel('TOTALE OFFERTA'), 'grand_total');
});

test('space-grouped locale money parses', () => {
  assert.equal(parseInternationalAmount('9 000,00').normalizedValue, 9000);
  assert.equal(parseInternationalAmount('4 500,00').normalizedValue, 4500);
  assert.equal(parseInternationalAmount('1.234,56').normalizedValue, 1234.56);
});

test('region model tags recap and carry-forward', () => {
  assert.equal(classifySemanticRegion('RIEPILOGO NA VAT RECAP').region, 'tax_recap');
  assert.equal(classifySemanticRegion('Riporto a pagina 2').region, 'table_subtotal');
  assert.equal(classifySemanticRegion('Resumen de cantidades trienal').region, 'historical_recap');
});

test('conflicting recap vs primary totals flags source inconsistency', () => {
  const pages = layout([
    line('Codice', 40, 120, 80),
    line('Descrizione', 160, 120, 160),
    line('Q.tà', 520, 120, 50),
    line('Prezzo unit.', 640, 120, 110),
    line('IVA %', 900, 120, 50),
    line('Totale riga', 1040, 120, 90),
    line('A-1', 40, 180, 50),
    line('Filtro', 160, 180, 80),
    line('1', 520, 180, 30),
    line('100,00', 640, 180, 70),
    line('22', 900, 180, 30),
    line('100,00', 1040, 180, 70),
    line('Imponibile merce', 700, 320, 160),
    line('74.040,90', 1040, 320, 90),
    line('Spese trasporto e imballo', 700, 350, 200),
    line('950,00', 1040, 350, 70),
    line('Sconto documento 2%', 700, 380, 180),
    line('-1.499,82', 1040, 380, 90),
    line('RIEPILOGO IVA VAT RECAP', 80, 430, 220),
    line('IVA 22%', 80, 460, 80),
    line('16.168,05', 400, 460, 90),
    line('IVA 10%', 80, 490, 80),
    line('107,46', 400, 490, 70),
    line('TOTALE OFFERTA', 700, 540, 160),
    line('91.355,63', 1040, 540, 90),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.summary.total?.normalizedValue, 91355.63);
  assert.ok(Math.abs((extraction.summary.subtotal?.normalizedValue ?? 0) - 74040.9) < 0.05);
  assert.equal(extraction.summary.shippingCost?.normalizedValue, 950);
  assert.equal(extraction.summary.discountTotal?.normalizedValue, -1499.82);
  assert.notEqual(extraction.summary.subtotal?.normalizedValue, 950);
  assert.notEqual(extraction.summary.subtotal?.normalizedValue, 650);
  assert.notEqual(extraction.summary.vatAmount?.normalizedValue, 107.46);
});

test('multipage inherited schema keeps adjacent item-code row bands separate', () => {
  const pages = layoutPages([
    [
      line('Codice', 40, 120, 80),
      line('Descrizione', 160, 120, 160),
      line('Q.tà', 520, 120, 50),
      line('Prezzo', 640, 120, 80),
      line('IVA %', 900, 120, 50),
      line('Totale riga', 1040, 120, 90),
      line('ABC-123', 40, 180, 90),
      line('Primary pump assembly', 160, 180, 220),
      line('1', 520, 180, 20),
      line('100,00', 640, 180, 70),
      line('22', 900, 180, 30),
      line('100,00', 1040, 180, 70),
      line('Riporto a pagina 2', 40, 420, 180),
      line('100,00', 1040, 420, 70),
    ],
    [
      line('Codice', 40, 80, 80),
      line('Descrizione', 160, 80, 160),
      line('Q.tà', 520, 80, 50),
      line('Prezzo', 640, 80, 80),
      line('IVA %', 900, 80, 50),
      line('Totale riga', 1040, 80, 90),
      line('PUMP-200', 40, 180, 110),
      line('Wrapped motor valve description continuing onto the next band', 160, 175, 280, 48),
      line('4', 520, 205, 20),
      line('1.250,00', 640, 210, 80),
      line('22', 900, 210, 30),
      line('4.500,00', 1040, 218, 80),
      line('KIT-01', 40, 225, 80),
      line('Capacitive level sensor body text', 160, 218, 240, 46),
      line('6', 520, 268, 20),
      line('285,00', 640, 272, 70),
      line('22', 900, 272, 30),
      line('1.569,60', 1040, 278, 80),
      line('XK-220', 40, 330, 80),
      line('Free setup / zero priced row', 160, 330, 220),
      line('1', 520, 330, 20),
      line('0,00', 640, 330, 50),
      line('22', 900, 330, 30),
      line('0,00', 1040, 330, 50),
      line('Riporto da pagina 1: 100,00', 40, 430, 220),
      line('Imponibile', 700, 500, 120),
      line('6.169,60', 1040, 500, 80),
      line('Totale documento', 700, 540, 140),
      line('7.526,91', 1040, 540, 80),
    ],
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  const codes = extraction.items.map((item) => String(item.itemCode?.normalizedValue ?? item.description?.normalizedValue ?? ''));
  assert.equal(extraction.items.length, 4);
  assert.equal(extraction.items.filter((item) => item.pageIndex === 0).length, 1);
  assert.equal(extraction.items.filter((item) => item.pageIndex === 1).length, 3);
  assert.equal(extraction.items.some((item) => /riporto/i.test(item.description?.normalizedValue ?? '')), false);
  assert.match(codes.join(' | '), /PUMP-200/i);
  assert.match(codes.join(' | '), /KIT-01/i);
  assert.equal(extraction.items.some((item) => /PUMP-200/i.test(String(item.itemCode?.normalizedValue ?? ''))
    && /KIT-01|level sensor/i.test(String(item.description?.normalizedValue ?? ''))), false);
  const pump = extraction.items.find((item) => /PUMP-200/i.test(String(item.itemCode?.normalizedValue ?? '')));
  const kit = extraction.items.find((item) => /KIT-01/i.test(String(item.itemCode?.normalizedValue ?? '')));
  const free = extraction.items.find((item) => /XK-220/i.test(String(item.itemCode?.normalizedValue ?? '')));
  assert.equal(pump?.quantity?.normalizedValue, 4);
  assert.equal(kit?.quantity?.normalizedValue, 6);
  assert.equal(free?.unitPrice?.normalizedValue, 0);
  assert.equal(free?.lineTotal?.normalizedValue, 0);
  assert.match(String(pump?.description?.normalizedValue ?? ''), /motor valve/i);
  assert.match(String(kit?.description?.normalizedValue ?? ''), /level sensor/i);
});

test('ship-to short OCR junk is rejected; short brands need a complete block', () => {
  assert.equal(isImplausibleOrganizationName('Ctrl'), true);
  assert.equal(organizationNameAllowed('Ctrl', { hasAddress: true }), false);
  assert.equal(organizationNameAllowed('IBM', { hasAddress: true }), true);
  assert.equal(organizationNameAllowed('IBM'), false);
  assert.equal(organizationNameAllowed('3M', { hasAddress: true, hasLegalSuffix: true }), true);
  assert.equal(organizationNameAllowed('KÜNZI', { hasWebsite: true }), true);
  assert.equal(organizationNameAllowed('KÜNZI'), false);
  assert.equal(organizationNameAllowed('Ship-to'), false);

  const junk = identity([
    line('NORTHSHORE LAB SUPPLIES LTD', 40, 30, 280),
    line('Bill-to:', 40, 160, 80),
    line('Institute of Marine Geoscience Research', 40, 190, 320),
    line('17 Oceanic Drive', 40, 215, 160),
    line('Ship-to:', 520, 160, 80),
    line('Ctrl', 900, 160, 40),
  ]);
  assert.notEqual(String(junk.recipient?.name?.normalizedValue ?? ''), 'Ctrl');

  const ibm = identity([
    line('NORTHSHORE LAB SUPPLIES LTD', 40, 30, 280),
    line('Bill-to:', 40, 160, 80),
    line('Institute of Marine Geoscience Research', 40, 190, 320),
    line('17 Oceanic Drive', 40, 215, 160),
    line('Ship-to:', 520, 160, 80),
    line('IBM', 520, 190, 50),
    line('1 New Orchard Road', 520, 215, 180),
    line('Armonk 10504', 520, 240, 140),
  ]);
  assert.equal(ibm.recipient?.name?.normalizedValue, 'IBM');

  const brand = identity([
    line('NORTHSHORE LAB SUPPLIES LTD', 40, 30, 280),
    line('Bill-to:', 40, 160, 80),
    line('Institute of Marine Geoscience Research', 40, 190, 320),
    line('17 Oceanic Drive', 40, 215, 160),
    line('Ship-to:', 520, 160, 80),
    line('3M', 520, 190, 40),
    line('3M GmbH', 520, 215, 90),
    line('Carl-Schurz-Strasse 1', 520, 240, 180),
    line('41453 Neuss', 520, 265, 140),
  ]);
  assert.match(String(brand.recipient?.name?.normalizedValue ?? ''), /3M/i);

  const labeledOrg = identity([
    line('NORTHSHORE LAB SUPPLIES LTD', 40, 30, 280),
    line('Ship-to:', 40, 160, 80),
    line('Dock Warehouse Logistics Ltd', 40, 190, 260),
    line('South Pier Road', 40, 215, 160),
  ]);
  assert.match(String(labeledOrg.recipient?.name?.normalizedValue ?? ''), /Dock Warehouse/i);
  assert.notEqual(String(labeledOrg.recipient?.name?.normalizedValue ?? ''), 'Ship-to');
});

test('shipping labels bind independently of subtotal and discount', () => {
  const pages = layout([
    line('Description', 80, 120, 160),
    line('Qty', 500, 120, 40),
    line('Unit Price', 620, 120, 90),
    line('Line Total', 1020, 120, 90),
    line('PMP-110', 40, 170, 80),
    line('Pump', 140, 170, 80),
    line('1', 500, 170, 20),
    line('100,00', 620, 170, 70),
    line('100,00', 1020, 170, 70),
    line('Subtotal', 700, 280, 100),
    line('100,00', 1020, 280, 70),
    line('Shipping', 700, 310, 100),
    line('15,00', 1020, 310, 70),
    line('Sconto documento', 700, 340, 160),
    line('-5,00', 1020, 340, 70),
    line('VAT 20%', 700, 370, 80),
    line('22,00', 1020, 370, 70),
    line('Grand total', 700, 400, 120),
    line('132,00', 1020, 400, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.summary.shippingCost?.normalizedValue, 15);
  assert.equal(extraction.summary.subtotal?.normalizedValue, 100);
  assert.notEqual(extraction.summary.subtotal?.normalizedValue, 15);

  const german = layout([
    line('Beschreibung', 80, 120, 160),
    line('Menge', 500, 120, 50),
    line('Preis', 640, 120, 70),
    line('Gesamt', 1040, 120, 70),
    line('A-1', 40, 170, 50),
    line('Teil', 160, 170, 60),
    line('1', 500, 170, 20),
    line('100,00', 640, 170, 70),
    line('100,00', 1040, 170, 70),
    line('Zwischensumme', 700, 280, 140),
    line('100,00', 1040, 280, 70),
    line('Versand', 700, 310, 90),
    line('12,00', 1040, 310, 70),
    line('Gesamtbetrag', 700, 350, 120),
    line('112,00', 1040, 350, 70),
  ]);
  assert.equal(extractDocumentItemsAndTotals(german).summary.shippingCost?.normalizedValue, 12);

  const nearPreviousTotal = layout([
    line('Codice', 40, 120, 80),
    line('Descrizione', 160, 120, 160),
    line('Q.tà', 520, 120, 50),
    line('Prezzo', 640, 120, 80),
    line('Totale', 1040, 120, 70),
    line('A-1', 40, 180, 50),
    line('Filtro', 160, 180, 80),
    line('1', 520, 180, 20),
    line('100,00', 640, 180, 70),
    line('100,00', 1040, 180, 70),
    line('Imponibile merce', 700, 320, 160),
    line('74.040,90', 1040, 320, 90),
    line('Spese trasporto e imballo', 700, 350, 220),
    line('950,00', 1075, 351, 70),
    line('Sconto documento 2%', 700, 380, 180),
    line('-1.499,82', 1040, 380, 90),
    line('TOTALE OFFERTA', 700, 430, 160),
    line('73.491,08', 1040, 430, 90),
  ]);
  const shippingExtraction = extractDocumentItemsAndTotals(nearPreviousTotal);
  assert.equal(shippingExtraction.summary.shippingCost?.normalizedValue, 950);
  assert.ok(Math.abs((shippingExtraction.summary.subtotal?.normalizedValue ?? 0) - 74040.9) < 0.05);
  assert.notEqual(shippingExtraction.summary.shippingCost?.normalizedValue, 74040.9);
});

test('printed line total in the total column is preserved', () => {
  const pages = layout([
    line('Codice', 40, 120, 80),
    line('Descrizione', 160, 120, 160),
    line('Q.tà', 520, 120, 50),
    line('Prezzo', 640, 120, 80),
    line('Sconto %', 800, 120, 80),
    line('IVA %', 940, 120, 50),
    line('Totale', 1100, 120, 70),
    line('FILT-20', 40, 180, 80),
    line('Filtro industriale', 160, 180, 180),
    line('6', 520, 180, 20),
    line('42,50', 640, 180, 70),
    line('10', 800, 180, 30),
    line('22', 940, 180, 30),
    line('229,50', 1100, 180, 80),
    line('KIT-01', 40, 260, 80),
    line('Kit valvole', 160, 260, 140),
    line('2', 520, 260, 20),
    line('50,00', 640, 260, 70),
    line('0', 800, 260, 20),
    line('22', 940, 260, 30),
    line('100,00', 1100, 260, 70),
    line('FREE-1', 40, 340, 80),
    line('Logo setup', 160, 340, 120),
    line('1', 520, 340, 20),
    line('0,00', 640, 340, 50),
    line('0', 800, 340, 20),
    line('22', 940, 340, 30),
    line('0,00', 1100, 340, 50),
    line('Imponibile', 700, 430, 120),
    line('329,50', 1100, 430, 70),
    line('Totale documento', 700, 470, 140),
    line('401,99', 1100, 470, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 3);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 229.5);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 100);
  assert.equal(extraction.items[2]?.lineTotal?.normalizedValue, 0);
  assert.notEqual(extraction.items[0]?.lineTotal?.normalizedValue, 100);
});

test('item-code column raw Y keeps adjacent codes as separate rows', () => {
  const pages = layout([
    line('Codice', 40, 100, 80),
    line('Descrizione', 180, 102, 160),
    line('Q.tà', 520, 108, 50),
    line('Prezzo', 640, 110, 80),
    line('IVA %', 900, 112, 50),
    line('Totale', 1100, 118, 70),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('KIT-01', 40, 260, 80),
    line('Kit valvole ottone', 180, 261, 200),
    line('4', 520, 276, 20),
    line('24,90', 640, 278, 70),
    line('22', 900, 279, 30),
    line('89,64', 1100, 280, 80),
    line('MANO-01', 40, 340, 90),
    line('Manodopera installazione', 180, 341, 240),
    line('2', 520, 356, 20),
    line('35,00', 640, 358, 70),
    line('22', 900, 359, 30),
    line('70,00', 1100, 360, 70),
    line('TRASP', 40, 420, 80),
    line('Courier express', 180, 421, 180),
    line('1', 520, 436, 20),
    line('15,00', 640, 438, 70),
    line('22', 900, 439, 30),
    line('15,00', 1100, 440, 70),
    line('Imponibile', 700, 520, 120),
    line('404,14', 1100, 520, 80),
    line('Totale documento', 700, 560, 140),
    line('493,05', 1100, 560, 80),
  ], 1400, 1800);
  const extraction = extractDocumentItemsAndTotals(pages);
  const codes = extraction.items.map((item) => String(item.itemCode?.normalizedValue ?? ''));
  assert.equal(extraction.items.length, 4);
  assert.match(codes.join(' | '), /ABC-123/i);
  assert.match(codes.join(' | '), /KIT-01/i);
  assert.match(codes.join(' | '), /MANO-01/i);
  assert.match(codes.join(' | '), /TRASP/i);
  assert.ok(extraction.items.some((item) => /Courier express/i.test(String(item.description?.normalizedValue ?? ''))));
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 229.5);
  assert.equal(extraction.items[3]?.lineTotal?.normalizedValue, 15);
});
