import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeAiStructuredDocuments, normalizeAiStructuredDocument } from '../lib/document-ai-contract';
import { pageResultFromCloudExtract } from '../lib/document-page-extraction';

const field = <T>(value: T, evidenceText = String(value), pageIndex = 0) => ({
  value, pageIndex, evidenceText, confidenceType: 'unknown',
  requiresReview: true, alternatives: [],
});

test('normalizza il contratto AI universale senza inventare campi', () => {
  const result = normalizeAiStructuredDocument({
    document: { documentType: field('order'), documentNumber: field('2026002581'), issueDate: field('2026-03-27') },
    issuer: { name: field('KÜNZI S.p.A.'), iban: field('IT76N0503432621000000006006') },
    customer: { name: field('Associazione Amici Trafoi'), shippingAddress: field('Via Trafoi 5') },
    items: [{ itemCode: field('V-0.61'), description: field('Multiuso Escort'), quantity: field(50), unitPrice: field(8.46), vatRate: field(22), lineTotal: field(422.95), pageIndex: 0, evidenceText: 'V-0.61 Multiuso Escort 50 8,46 422,95', requiresReview: true }],
    summary: { subtotal: field(557.95), vatAmount: field(122.75), total: field(680.7), shippingCost: field(15) },
    conditions: { paymentTerms: field('Bonifico Anticipato'), deliveryTerms: field('30 giorni'), bankDetails: field('Banca osservata') },
    conflicts: [], requiresReview: true,
  });
  assert.equal(result?.schemaVersion, 2);
  assert.equal(result?.document.documentNumber?.value, '2026002581');
  assert.equal(result?.issuer?.name?.value, 'KÜNZI S.p.A.');
  assert.equal(result?.items[0].itemCode?.value, 'V-0.61');
  assert.equal(result?.summary.shippingCost?.value, 15);
  assert.equal(result?.conditions.paymentTerms?.value, 'Bonifico Anticipato');
  assert.equal(result?.document.dueDate, undefined);
});

test('zero esplicito resta valido e missing non diventa zero', () => {
  const result = normalizeAiStructuredDocument({
    document: {}, issuer: {}, customer: {},
    items: [{ lineTotal: field(0, '0,00'), pageIndex: 0, evidenceText: 'Lavorazione 0,00', requiresReview: true }],
    summary: {}, conditions: {}, conflicts: [], requiresReview: true,
  });
  assert.equal(result?.items[0].lineTotal?.value, 0);
  assert.equal(result?.summary.total, undefined);
});

test('campo senza evidenza o pagina viene scartato', () => {
  const result = normalizeAiStructuredDocument({
    document: { documentNumber: { value: '123', pageIndex: 0, evidenceText: '' } },
    items: [], summary: {}, conditions: {}, conflicts: [], requiresReview: true,
  });
  assert.equal(result?.document.documentNumber, undefined);
});

test('schema v2 sopravvive al percorso pagina e al merge multipagina', () => {
  const first = normalizeAiStructuredDocument({ document: { documentNumber: field('K-1') }, items: [], summary: {}, conditions: {}, conflicts: [], requiresReview: true });
  const second = normalizeAiStructuredDocument({ document: {}, items: [{ description: field('Riga', 'Riga', 1), pageIndex: 1, evidenceText: 'Riga', requiresReview: true }], summary: { total: field(10, '10,00', 1) }, conditions: {}, conflicts: [], requiresReview: true });
  assert.ok(first && second);
  const page = pageResultFromCloudExtract(0, 'one.jpg', { rawText: 'K-1', structured: first });
  assert.equal(page.aiStructured?.document.documentNumber?.value, 'K-1');
  const merged = mergeAiStructuredDocuments([first, second]);
  assert.equal(merged?.document.documentNumber?.value, 'K-1');
  assert.equal(merged?.items.length, 1);
  assert.equal(merged?.summary.total?.value, 10);
});

test('riepiloghi IVA multi-aliquota conservano campi, evidenza e pagina', () => {
  const first = normalizeAiStructuredDocument({ document: {}, items: [], summary: { taxSummaries: [{ vatRate: field(10), taxableAmount: field(100), vatAmount: field(10), pageIndex: 0, requiresReview: true }] }, conditions: {}, conflicts: [], requiresReview: true });
  const second = normalizeAiStructuredDocument({ document: {}, items: [], summary: { taxSummaries: [{ vatRate: field(22, '22', 1), taxableAmount: field(200, '200', 1), vatAmount: field(44, '44', 1), pageIndex: 1, requiresReview: true }] }, conditions: {}, conflicts: [], requiresReview: true });
  assert.ok(first && second);
  const merged = mergeAiStructuredDocuments([first, second]);
  assert.equal(merged?.summary.taxSummaries?.length, 2);
  assert.equal(merged?.summary.taxSummaries?.[0].vatRate?.value, 10);
  assert.equal(merged?.summary.taxSummaries?.[1].pageIndex, 1);
  assert.equal(merged?.summary.taxSummaries?.[1].vatAmount?.evidenceText, '44');
});

test('contratto completo conserva sezioni specialistiche senza inventare dati assenti', () => {
  const result = normalizeAiStructuredDocument({
    document: {
      internalReference: field('INT-7'), customerReference: field('CLI-9'),
      subject: field('Manutenzione veicolo'), pageCount: field(2),
    },
    issuer: { name: field('PENDINGOMME SNC'), legalForm: field('SNC'), registrationNumber: field('REA 123') },
    recipient: { name: field('CHIOZZA TOMMASO'), address: field('Via esempio 1') },
    prospect: { name: field('Ufficio acquisti') },
    vehicle: { make: field('RENAULT'), model: field('CAPTUR'), plate: field('FG826MZ'), vin: field('VF12RAJ1D56655103'), kilometers: field(197000), requiresReview: true },
    project: { name: field('MARMED'), reference: field('G61B22002400006'), requiresReview: true },
    delivery: { date: field('2026-04-20'), recipient: field('Magazzino'), address: field('Via deposito 2'), requiresReview: true },
    shipping: { terms: field('Porto franco'), carrier: field('BARTOLINI SPA'), cost: field(15), requiresReview: true },
    bank: { bankName: field('Banca'), iban: field('IT60X0542811101000000123456'), bic: field('BCITITMM'), ownerRole: 'issuer', requiresReview: true },
    publicAdministrationData: { cup: field('G61B22002400006'), cig: field('Z123'), office: field('Ufficio gare'), requiresReview: true },
    items: [],
    summary: { materialTotal: field(978.61), laborTotal: field(353.09), externalWorkTotal: field(0), logisticsContribution: field(15) },
    conditions: { deliveryDate: field('2026-04-20'), shippingTerms: field('Porto franco'), notes: field('Non inventare') },
    conflicts: [], requiresReview: true,
  });

  assert.equal(result?.vehicle?.vin?.value, 'VF12RAJ1D56655103');
  assert.equal(result?.bank?.ownerRole, 'issuer');
  assert.equal(result?.bank?.iban?.value, 'IT60X0542811101000000123456');
  assert.equal(result?.summary.externalWorkTotal?.value, 0);
  assert.equal(result?.conditions.shippingTerms?.value, 'Porto franco');
  assert.equal(result?.publicAdministrationData?.office?.pageIndex, 0);
  assert.equal(result?.delivery?.terms, undefined);
});
