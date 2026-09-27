import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileDocumentField, reconcileStructuredDocument } from '../lib/document-ai-reconciler';
import type { AiField, AiStructuredDocumentExtract } from '../lib/document-ai-contract';
import type { DocumentEvidence, StructuredDocumentExtraction } from '../lib/document-structure';

const local = <T>(value: T, valid = true): DocumentEvidence<T> => ({
  rawValue: value, normalizedValue: value, pageIndex: 0,
  sourceLineIds: ['p1-l1'], sourceLines: [String(value)],
  validationStatus: valid ? 'valid' : 'unverified', confidenceType: 'heuristic',
  reasons: ['labeled'], requiresReview: !valid, alternatives: [],
});
const ai = <T>(value: T, evidence = String(value)): AiField<T> => ({
  value, pageIndex: 0, evidenceText: evidence, confidenceType: 'unknown',
  requiresReview: true, alternatives: [],
});

test('totale concorde produce agreed', () => {
  const result = reconcileDocumentField({ local: local(680.7), ai: ai(680.7, 'Totale 680,70'), ocrText: 'Totale 680,70' });
  assert.equal(result.status, 'agreed');
  assert.equal(result.selectedValue, 680.7);
});

test('numero solo AI osservabile resta ai_only e richiede review', () => {
  const result = reconcileDocumentField({ ai: ai('2026002581', 'N. 2026002581'), ocrText: 'N. 2026002581 del 27/03/2026' });
  assert.equal(result.status, 'ai_only');
  assert.equal(result.aiObservedInOcr, true);
  assert.equal(result.requiresReview, true);
});

test('valore AI non osservabile viene segnalato', () => {
  const result = reconcileDocumentField({ ai: ai('INVENTATO'), ocrText: 'Ordine 123' });
  assert.equal(result.status, 'ai_only');
  assert.equal(result.aiObservedInOcr, false);
  assert.ok(result.reasons.includes('ai_value_not_observed_in_ocr'));
});

test('divergenza non sceglie silenziosamente la proposta debole', () => {
  const result = reconcileDocumentField({ local: local(45, false), ai: ai(0.9), ocrText: '50 0,90 45,00' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.selectedValue, undefined);
  assert.equal(result.requiresReview, true);
});

test('campo locale etichettato prevale ma conserva conflitto', () => {
  const result = reconcileDocumentField({ local: local('ORD-7'), ai: ai('ORD-1'), ocrText: 'Numero ORD-7' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.selectedValue, 'ORD-7');
  assert.equal(result.selectedSource, 'local');
});

test('modifica manuale ha precedenza', () => {
  const result = reconcileDocumentField({ local: local(45, false), ai: ai(0.9), manualValue: 45, ocrText: '45,00' });
  assert.equal(result.selectedSource, 'manual');
  assert.equal(result.selectedValue, 45);
  assert.equal(result.requiresReview, false);
});

test('righe AI riordinate vengono abbinate per codice e non per posizione', () => {
  const localDocument: StructuredDocumentExtraction = {
    schemaVersion: 1, metadata: {},
    items: [
      { itemCode: local('A'), description: local('Alpha'), quantity: local(1), unitPrice: local(10), lineTotal: local(10), pageIndex: 0, sourceLineIds: [], sourceLines: ['A Alpha'], requiresReview: false },
      { itemCode: local('B'), description: local('Beta'), quantity: local(2), unitPrice: local(20), lineTotal: local(40), pageIndex: 0, sourceLineIds: [], sourceLines: ['B Beta'], requiresReview: false },
    ],
    summary: { taxSummaries: [], conflicts: [], requiresReview: false }, conditions: {}, pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [],
  };
  const item = (code: string, description: string) => ({ itemCode: ai(code), description: ai(description), quantity: ai(code === 'A' ? 1 : 2), unitPrice: ai(code === 'A' ? 10 : 20), lineTotal: ai(code === 'A' ? 10 : 40), pageIndex: 0, evidenceText: `${code} ${description}`, requiresReview: true });
  const aiDocument: AiStructuredDocumentExtract = { schemaVersion: 2, document: {}, items: [item('B', 'Beta'), item('A', 'Alpha')], summary: {}, conditions: {}, conflicts: [], requiresReview: true };
  const result = reconcileStructuredDocument({ local: localDocument, ai: aiDocument, ocrText: 'A Alpha B Beta' });
  assert.deepEqual(result.items.map((entry) => [entry.localIndex, entry.aiIndex]), [[0, 1], [1, 0]]);
  assert.equal(result.items[0].description.status, 'agreed');
  assert.equal(result.items[1].description.status, 'agreed');
});

test('riga AI aggiunta resta separata e non sovrascrive la riga locale', () => {
  const localDocument: StructuredDocumentExtraction = { schemaVersion: 1, metadata: {}, items: [{ itemCode: local('A'), description: local('Alpha'), quantity: local(1), unitPrice: local(10), lineTotal: local(10), pageIndex: 0, sourceLineIds: [], sourceLines: ['A Alpha'], requiresReview: false }], summary: { taxSummaries: [], conflicts: [], requiresReview: false }, conditions: {}, pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [] };
  const aiDocument: AiStructuredDocumentExtract = { schemaVersion: 2, document: {}, items: [{ itemCode: ai('X'), description: ai('Extra'), quantity: ai(3), unitPrice: ai(5), lineTotal: ai(15), pageIndex: 0, evidenceText: 'X Extra 3 5 15', requiresReview: true }], summary: {}, conditions: {}, conflicts: [], requiresReview: true };
  const result = reconcileStructuredDocument({ local: localDocument, ai: aiDocument, ocrText: 'A Alpha X Extra 3 5 15' });
  assert.deepEqual(result.items.map((entry) => [entry.localIndex, entry.aiIndex]), [[0, undefined], [undefined, 0]]);
});

test('riepiloghi IVA diversi non risultano agreed per coercizione object', () => {
  const localDocument: StructuredDocumentExtraction = { schemaVersion: 1, metadata: {}, items: [], summary: { taxSummaries: [{ vatRate: local(10), taxableAmount: local(100), vatAmount: local(10), pageIndex: 0, requiresReview: false }], conflicts: [], requiresReview: false }, conditions: {}, pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [] };
  const aiDocument: AiStructuredDocumentExtract = { schemaVersion: 2, document: {}, items: [], summary: { taxSummaries: [{ vatRate: ai(22), taxableAmount: ai(100), vatAmount: ai(22), pageIndex: 0, requiresReview: true }] }, conditions: {}, conflicts: [], requiresReview: true };
  const result = reconcileStructuredDocument({ local: localDocument, ai: aiDocument, ocrText: '10 100 10 22 100 22' });
  assert.equal(result.fields.taxSummaries.status, 'conflict');
  assert.equal(result.fields.taxSummaries.requiresReview, true);
});

test('riconcilia ogni sezione completa mantenendo VIN IBAN e importi distinti', () => {
  const localDocument: StructuredDocumentExtraction = {
    schemaVersion: 1, metadata: { documentNumber: local('812/Z') },
    vehicle: { vin: local('VF12RAJ1D56655103'), plate: local('FG826MZ'), requiresReview: false },
    bank: { iban: local('IT60X0542811101000000123456'), ownerRole: 'issuer', requiresReview: false },
    items: [], summary: { materialTotal: local(978.61), taxSummaries: [], conflicts: [], requiresReview: false },
    conditions: {}, pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [],
  };
  const aiDocument: AiStructuredDocumentExtract = {
    schemaVersion: 2,
    document: { documentNumber: ai('812/Z'), internalReference: ai('FG826MZ') },
    recipient: { name: ai('CHIOZZA TOMMASO') },
    vehicle: { vin: ai('VF12RAJ1D56655103'), plate: ai('FG826MZ'), kilometers: ai(197000), requiresReview: true },
    project: { name: ai('MARMED'), requiresReview: true },
    delivery: { recipient: ai('Magazzino'), requiresReview: true },
    shipping: { carrier: ai('BARTOLINI SPA'), cost: ai(15), requiresReview: true },
    bank: { iban: ai('IT60X0542811101000000123456'), ownerRole: 'issuer', requiresReview: true },
    publicAdministrationData: { cup: ai('G61B22002400006'), requiresReview: true },
    items: [], summary: { materialTotal: ai(978.61), shippingCost: ai(15) }, conditions: { notes: ai('Nota') }, conflicts: [], requiresReview: true,
  };
  const result = reconcileStructuredDocument({
    local: localDocument, ai: aiDocument,
    ocrText: '812/Z FG826MZ VF12RAJ1D56655103 IT60X0542811101000000123456 CHIOZZA TOMMASO MARMED BARTOLINI SPA 15 G61B22002400006 Nota',
  });

  assert.equal(result.fields.vehicleVin.status, 'agreed');
  assert.equal(result.fields.bankIban.status, 'agreed');
  assert.equal(result.fields.vehicleKilometers.status, 'ai_only');
  assert.equal(result.fields.shippingCarrier.aiValue, 'BARTOLINI SPA');
  assert.equal(result.fields.materialTotal.status, 'agreed');
  assert.equal(result.fields.paCup.status, 'ai_only');
  assert.notEqual(result.fields.vehicleVin.aiValue, result.fields.bankIban.aiValue);
});
