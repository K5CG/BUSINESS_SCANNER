import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractStructuredDocument } from '../lib/document-structured-extraction';
import {
  DOCUMENT_LABEL_DICTIONARY,
  detectDocumentLanguages,
  inferCanonicalDocumentType,
  type CanonicalCommercialDocumentType,
  type DocumentLanguage,
} from '../lib/document-label-dictionary';
import {
  looksLikeInternationalTaxIdentifier,
  parseInternationalAmount,
  parseInternationalDate,
} from '../lib/document-international-values';

type FixtureLabels = {
  language: DocumentLanguage;
  types: Record<'quotation' | 'order' | 'invoice', string>;
  issuer: string;
  issuerName: string;
  customer: string;
  customerName: string;
  number: string;
  date: string;
  code: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: string;
  lineTotal: string;
  taxable: string;
  vatAmount: string;
  total: string;
  payment: string;
  paymentValue: string;
  delivery: string;
  deliveryValue: string;
  bank: string;
  bankName: string;
  vatId: string;
};

const fixtures: FixtureLabels[] = [
  { language: 'it', types: { quotation: 'Preventivo', order: 'Ordine', invoice: 'Fattura' }, issuer: 'Fornitore', issuerName: 'ALFA ITALIA S.R.L.', customer: 'Cliente', customerName: 'BETA CLIENTE S.R.L.', number: 'Numero documento', date: 'Data documento', code: 'Codice', description: 'Descrizione', quantity: 'Quantità', unit: 'UdM', unitPrice: 'Prezzo unitario', vatRate: 'IVA', lineTotal: 'Totale riga', taxable: 'Imponibile', vatAmount: 'Importo IVA', total: 'Totale documento', payment: 'Condizioni di pagamento', paymentValue: 'Bonifico 30 giorni', delivery: 'Condizioni di consegna', deliveryValue: 'Franco destino', bank: 'Banca', bankName: 'Banca Alfa', vatId: 'IT12345678901' },
  { language: 'en', types: { quotation: 'Quotation', order: 'Purchase Order', invoice: 'Invoice' }, issuer: 'Supplier', issuerName: 'ALPHA UK LTD', customer: 'Bill To', customerName: 'BETA CUSTOMER LTD', number: 'Document No.', date: 'Issue Date', code: 'Item Code', description: 'Description', quantity: 'Quantity', unit: 'Unit', unitPrice: 'Unit Price', vatRate: 'VAT Rate', lineTotal: 'Line Total', taxable: 'Taxable Amount', vatAmount: 'VAT Amount', total: 'Grand Total', payment: 'Payment Terms', paymentValue: 'Bank transfer 30 days', delivery: 'Delivery Terms', deliveryValue: 'Delivered duty paid', bank: 'Bank', bankName: 'Alpha Bank', vatId: 'GB123456789' },
  { language: 'fr', types: { quotation: 'Devis', order: 'Commande', invoice: 'Facture' }, issuer: 'Fournisseur', issuerName: 'ALPHA FRANCE SARL', customer: 'Client', customerName: 'BETA CLIENT SARL', number: 'Numéro', date: "Date d'émission", code: 'Code article', description: 'Désignation', quantity: 'Quantité', unit: 'Unité', unitPrice: 'Prix unitaire', vatRate: 'TVA', lineTotal: 'Total ligne', taxable: 'Montant hors taxes', vatAmount: 'Montant TVA', total: 'Total TTC', payment: 'Conditions de paiement', paymentValue: 'Virement à 30 jours', delivery: 'Conditions de livraison', deliveryValue: 'Franco de port', bank: 'Banque', bankName: 'Banque Alpha', vatId: 'FRAB123456789' },
  { language: 'de', types: { quotation: 'Angebot', order: 'Bestellung', invoice: 'Rechnung' }, issuer: 'Lieferant', issuerName: 'ALPHA DEUTSCHLAND GMBH', customer: 'Kunde', customerName: 'BETA KUNDE GMBH', number: 'Belegnummer', date: 'Belegdatum', code: 'Artikelnummer', description: 'Beschreibung', quantity: 'Menge', unit: 'Einheit', unitPrice: 'Einzelpreis', vatRate: 'MwSt.', lineTotal: 'Gesamt', taxable: 'Nettobetrag', vatAmount: 'MwSt.-Betrag', total: 'Gesamtbetrag', payment: 'Zahlungsbedingungen', paymentValue: 'Überweisung 30 Tage', delivery: 'Lieferbedingungen', deliveryValue: 'Frei Haus', bank: 'Bankverbindung', bankName: 'Alpha Bank', vatId: 'DE123456789' },
  { language: 'es', types: { quotation: 'Presupuesto', order: 'Pedido', invoice: 'Factura' }, issuer: 'Proveedor', issuerName: 'ALPHA ESPAÑA SL', customer: 'Comprador', customerName: 'BETA CLIENTE SL', number: 'Número', date: 'Fecha de emisión', code: 'Código', description: 'Descripción', quantity: 'Cantidad', unit: 'Unidad', unitPrice: 'Precio unitario', vatRate: 'IVA', lineTotal: 'Total línea', taxable: 'Base imponible', vatAmount: 'Importe IVA', total: 'Importe total', payment: 'Condiciones de pago', paymentValue: 'Transferencia 30 días', delivery: 'Condiciones de entrega', deliveryValue: 'Porte pagado', bank: 'Banco', bankName: 'Banco Alpha', vatId: 'ESB12345678' },
];

const line = (text: string, x: number, y: number, width = 150): OcrLine => ({
  text,
  confidence: 0.95,
  boundingBox: { x, y, width, height: 24 },
});

function controlledPage(labels: FixtureLabels, documentType: keyof FixtureLabels['types'], pageIndex = 0) {
  const currency = labels.language === 'en' ? 'USD' : labels.language === 'de' ? 'CHF' : 'EUR';
  const amount = labels.language === 'en' || labels.language === 'de' ? '100.00' : '100,00';
  const vat = labels.language === 'en' || labels.language === 'de' ? '22.00' : '22,00';
  const total = labels.language === 'en' || labels.language === 'de' ? `${currency} 122.00` : `${currency} 122,00`;
  const lines = [
    line(labels.types[documentType], 40, 20, 260),
    line(labels.issuer, 40, 60), line(labels.issuerName, 220, 60, 300),
    line(`VAT: ${labels.vatId}`, 40, 95, 280),
    line(`${labels.bank}: ${labels.bankName}`, 360, 95, 280), line('IBAN: DE89370400440532013000', 650, 95, 300),
    line(labels.customer, 40, 150), line(labels.customerName, 220, 150, 320),
    line(labels.number, 40, 230), line(`${documentType.toUpperCase()}-2026-17`, 260, 230, 260),
    line(labels.date, 40, 275), line('27/03/2026', 260, 275),
    line(labels.code, 40, 400), line(labels.description, 170, 400, 220), line(labels.quantity, 430, 400),
    line(labels.unit, 540, 400), line(labels.unitPrice, 630, 400), line(labels.vatRate, 760, 400), line(labels.lineTotal, 860, 400),
    line('A-100', 40, 460), line(`${labels.description} originale`, 170, 460, 220), line('2', 430, 460),
    line('PZ', 540, 460), line('50,00', 630, 460), line('22%', 760, 460), line(amount, 860, 460),
    line(labels.taxable, 560, 650), line(amount, 860, 650),
    line(labels.vatAmount, 560, 690), line(vat, 860, 690),
    line(labels.total, 560, 730), line(total, 850, 730),
    line(labels.payment, 40, 800, 260), line(labels.paymentValue, 330, 800, 280),
    line(labels.delivery, 40, 850, 260), line(labels.deliveryValue, 330, 850, 280),
  ];
  return { pageIndex, width: 1100, height: 1400, rawText: lines.map((entry) => entry.text).join('\n'), lines };
}

for (const fixture of fixtures) {
  for (const documentType of ['quotation', 'order', 'invoice'] as const) {
    test(`${fixture.language}: ${documentType} usa lo schema canonico unico`, () => {
      const extraction = extractStructuredDocument('quote', [controlledPage(fixture, documentType)]);
      assert.equal(extraction.metadata.documentType?.normalizedValue, documentType);
      assert.equal(extraction.metadata.documentNumber?.normalizedValue, `${documentType.toUpperCase()}-2026-17`);
      assert.equal(extraction.metadata.issueDate?.normalizedValue, '2026-03-27');
      assert.equal(extraction.issuer?.name?.normalizedValue, fixture.issuerName);
      assert.equal(extraction.customer?.name?.normalizedValue, fixture.customerName);
      assert.equal(extraction.issuer?.vatNumber?.normalizedValue, fixture.vatId.replace(/^IT/, ''));
      assert.equal(extraction.items.length, 1);
      assert.equal(extraction.items[0].description?.normalizedValue, `${fixture.description} originale`);
      assert.equal(extraction.items[0].quantity?.normalizedValue, 2);
      assert.equal(extraction.items[0].unitPrice?.normalizedValue, 50);
      assert.equal(extraction.items[0].vatRate?.normalizedValue, 22);
      assert.equal(extraction.items[0].lineTotal?.normalizedValue, 100);
      assert.equal(extraction.summary.taxableAmount?.normalizedValue, 100);
      assert.equal(extraction.summary.vatAmount?.normalizedValue, 22);
      assert.equal(extraction.summary.total?.normalizedValue, 122);
      assert.ok(extraction.conditions.paymentTerms?.sourceLines.includes(fixture.paymentValue));
      assert.ok(extraction.conditions.deliveryTerms?.sourceLines.some((value) => value.includes(fixture.delivery)));
      assert.equal(extraction.issuer?.bankName?.normalizedValue, fixture.bankName);
      assert.equal(extraction.language?.primaryLanguage, fixture.language);
      assert.ok(extraction.language?.detectedLanguages.includes(fixture.language));
      assert.ok(!extraction.summary.vatAmount?.sourceLines.some((value) => value.includes(fixture.vatId)));
    });
  }
}

test('dizionario centralizzato copre i cinque idiomi senza parser separati', () => {
  const languages = new Set(Object.values(DOCUMENT_LABEL_DICTIONARY).flatMap((entries) => entries.map((entry) => entry.language)));
  assert.deepEqual([...languages].sort(), ['de', 'en', 'es', 'fr', 'it']);
  assert.equal(inferCanonicalDocumentType('Auftragsbestätigung')?.type, 'order');
  assert.equal(inferCanonicalDocumentType('Nota de crédito')?.type, 'credit_note');
});

test('documento bilingue e multipagina conserva lingua per pagina ed evidence originale', () => {
  const it = controlledPage(fixtures[0], 'quotation', 0);
  const en = controlledPage(fixtures[1], 'quotation', 1);
  const secondItemCode = en.lines.find((entry) => entry.text === 'A-100');
  if (secondItemCode) secondItemCode.text = 'A-200';
  en.rawText = en.lines.map((entry) => entry.text).join('\n');
  const extraction = extractStructuredDocument('quote', [it, en]);
  assert.equal(extraction.language?.mixedLanguage, true);
  assert.ok(extraction.language?.detectedLanguages.includes('it'));
  assert.ok(extraction.language?.detectedLanguages.includes('en'));
  assert.equal(extraction.language?.pages.length, 2);
  assert.ok(extraction.items.some((item) => item.description?.rawValue === 'Descrizione originale'));
  assert.ok(extraction.items.some((item) => item.description?.rawValue === 'Description originale'));
});

test('numeri internazionali conservano separatori, valuta e valore', () => {
  const italian = parseInternationalAmount('EUR 1.400,00', 'it');
  assert.equal(italian.normalizedValue, 1400);
  assert.equal(italian.decimalSeparator, ',');
  assert.equal(italian.thousandsSeparator, '.');
  assert.equal(italian.currency, 'EUR');
  const english = parseInternationalAmount('USD 1,400.00', 'en');
  assert.equal(english.normalizedValue, 1400);
  assert.equal(english.currency, 'USD');
  const swiss = parseInternationalAmount("CHF 1’400.00", 'de');
  assert.equal(swiss.normalizedValue, 1400);
  assert.equal(swiss.thousandsSeparator, "'");
});

test('data inglese ambigua non viene scelta automaticamente', () => {
  const ambiguous = parseInternationalDate('03/04/2026', 'en');
  assert.equal(ambiguous.normalizedValue, undefined);
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.alternatives.sort(), ['2026-03-04', '2026-04-03']);
  assert.equal(parseInternationalDate('27 mars 2026').normalizedValue, '2026-03-27');
  assert.equal(parseInternationalDate('27. März 2026').normalizedValue, '2026-03-27');
});

test('identificativi fiscali esteri non sono importi', () => {
  for (const value of ['IT12345678901', 'FRAB123456789', 'DE123456789', 'ESB12345678', 'GB123456789', 'CHE123456789MWST']) {
    assert.equal(looksLikeInternationalTaxIdentifier(value), true, value);
  }
  const detection = detectDocumentLanguages(['Facture', 'Montant TVA', 'Zahlungsbedingungen']);
  assert.equal(detection.mixedLanguage, true);
});
