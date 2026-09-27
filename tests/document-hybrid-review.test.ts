import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAcceptedHybridField, createHybridDocumentReview, decideHybridReview, hybridFieldCanAccept, hybridReviewCanSave, materializeAcceptedHybridDocument } from '../lib/document-hybrid-review';
import type { HybridDocumentReconciliation } from '../lib/document-ai-reconciler';

const field = (status: 'agreed' | 'ai_only' | 'conflict', requiresReview: boolean) => ({ status, requiresReview, reasons: [] });

test('review obbligatoria blocca il salvataggio finché le decisioni sono pendenti', () => {
  const reconciliation = { fields: { total: field('agreed', false), documentNumber: field('ai_only', true) }, items: [], requiresReview: true, conflicts: [] } as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [], blocking: false, requiresReview: false });
  assert.equal(hybridReviewCanSave(state), false);
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'documentNumber', 'accepted')), true);
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'documentNumber', 'rejected')), true);
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'documentNumber', 'manual')), true);
});

test('campo aritmeticamente bloccante non può essere accettato', () => {
  const reconciliation = { fields: { total: field('conflict', true) }, items: [], requiresReview: true, conflicts: ['total'] } as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [{ fieldPath: 'total', code: 'mismatch', status: 'conflict', blocking: true }], blocking: true, requiresReview: true });
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'total', 'accepted')), false);
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'total', 'rejected')), true);
});

test('errore bloccante di una proprietà riga blocca l accettazione dell intera riga', () => {
  const item = { index: 2, itemCode: field('ai_only', true), description: field('ai_only', true), quantity: field('conflict', true), unit: field('ai_only', true), unitPrice: field('ai_only', true), discount: field('ai_only', true), taxableAmount: field('ai_only', true), vatRate: field('ai_only', true), lineTotal: field('conflict', true), requiresReview: true };
  const reconciliation = { fields: {}, items: [item], requiresReview: true, conflicts: ['items.2'] } as unknown as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [{ fieldPath: 'items.2.quantity', code: 'evidence', status: 'conflict', blocking: true }], blocking: true, requiresReview: true });
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'items.2', 'accepted')), false);
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'items.2', 'rejected')), true);
});

test('local_only valido non crea una decisione pendente', () => {
  const reconciliation = { fields: { customerName: { ...field('ai_only', false), status: 'local_only' } }, items: [], requiresReview: false, conflicts: [] } as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [], blocking: false, requiresReview: false });
  assert.deepEqual(state.decisions, {});
  assert.equal(hybridReviewCanSave(state), true);
});

test('una validazione bloccante senza path mappato resta fail closed', () => {
  const reconciliation = { fields: {}, items: [], requiresReview: false, conflicts: [] } as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [{ fieldPath: 'summary.balance', code: 'mismatch', status: 'conflict', blocking: true }], blocking: true, requiresReview: true });
  assert.equal(hybridReviewCanSave(state), false);
});

test('accetta applica il valore AI riconciliato e non una proposta legacy', () => {
  const reconciliation = {
    fields: { total: { ...field('ai_only', true), aiValue: 680.7, pageIndex: 0, aiEvidence: 'Totale 680,70' } },
    items: [], requiresReview: true, conflicts: [],
  } as HybridDocumentReconciliation;
  const current = { id: 'q', type: 'quote' as const, title: 'Q', images: [], rawText: '', confidence: {}, items: [], total: 12, createdAt: new Date(0), updatedAt: new Date(0) };
  const applied = applyAcceptedHybridField(current, reconciliation, 'total');
  assert.equal(applied.type === 'quote' ? applied.total : undefined, 680.7);
});

test('valore concorde ma invalido richiede una decisione esplicita', () => {
  const reconciliation = { fields: { issueDate: field('agreed', false) }, items: [], requiresReview: false, conflicts: [] } as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [{ fieldPath: 'document.issueDate', code: 'invalid_calendar_date', status: 'invalid', blocking: true }], blocking: true, requiresReview: true });
  assert.equal(state.decisions.issueDate, 'pending');
  assert.equal(hybridReviewCanSave(decideHybridReview(state, 'issueDate', 'rejected')), true);
});

test('accetta poi rifiuta ricalcola dal documento base e ripristina il locale', () => {
  const reconciliation = { fields: { total: { ...field('ai_only', true), aiValue: 99, pageIndex: 0, aiEvidence: '99' } }, items: [], requiresReview: true, conflicts: [] } as HybridDocumentReconciliation;
  const base = { id: 'q', type: 'quote' as const, title: 'Q', images: [], rawText: '', confidence: {}, items: [], total: 12, createdAt: new Date(0), updatedAt: new Date(0) };
  const initial = createHybridDocumentReview(reconciliation, { issues: [], blocking: false, requiresReview: false });
  const accepted = decideHybridReview(initial, 'total', 'accepted');
  assert.equal((materializeAcceptedHybridDocument(base, accepted) as typeof base).total, 99);
  const rejected = decideHybridReview(accepted, 'total', 'rejected');
  assert.equal((materializeAcceptedHybridDocument(base, rejected) as typeof base).total, 12);
});

test('tipo documento dichiarato non è applicabile come modifica AI', () => {
  const reconciliation = { fields: { documentType: { ...field('ai_only', true), aiValue: 'order' } }, items: [], requiresReview: true, conflicts: [] } as HybridDocumentReconciliation;
  const state = createHybridDocumentReview(reconciliation, { issues: [], blocking: false, requiresReview: false });
  assert.equal(hybridFieldCanAccept(state, 'documentType'), false);
});

test('campi non legacy accettati restano nel record strutturato senza sovrascrivere banca', () => {
  const ai = <T>(value: T) => ({ status: 'ai_only' as const, aiValue: value, pageIndex: 0, aiEvidence: String(value), requiresReview: true, reasons: [] });
  const reconciliation = {
    fields: {
      conditionsIban: ai('IT60X0542811101000000123456'),
      validityDate: ai('2026-12-31'),
      taxSummaries: ai([{ vatRate: 22, taxableAmount: 100, vatAmount: 22, pageIndex: 0 }]),
    },
    items: [], requiresReview: true, conflicts: [],
  } as HybridDocumentReconciliation;
  const structuredExtraction = {
    schemaVersion: 1 as const, metadata: {}, items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: false },
    conditions: { bankDetails: { rawValue: 'Banca esistente', normalizedValue: 'Banca esistente', pageIndex: 0, sourceLineIds: [], sourceLines: ['Banca esistente'], validationStatus: 'valid' as const, confidenceType: 'measured' as const, reasons: [], requiresReview: false, alternatives: [] } },
    pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [],
  };
  const base = { id: 'q', type: 'quote' as const, title: 'Q', images: [], rawText: '', confidence: {}, items: [], createdAt: new Date(0), updatedAt: new Date(0), structuredExtraction };
  const withIban = applyAcceptedHybridField(base, reconciliation, 'conditionsIban');
  const withDate = applyAcceptedHybridField(withIban, reconciliation, 'validityDate');
  const applied = applyAcceptedHybridField(withDate, reconciliation, 'taxSummaries');
  assert.equal(applied.structuredExtraction?.conditions.iban?.normalizedValue, 'IT60X0542811101000000123456');
  assert.equal(applied.structuredExtraction?.conditions.bankDetails?.normalizedValue, 'Banca esistente');
  assert.equal(applied.type === 'quote' ? applied.validUntil?.toISOString().slice(0, 10) : undefined, '2026-12-31');
  assert.equal(applied.structuredExtraction?.summary.taxSummaries[0].vatAmount?.normalizedValue, 22);
});

test('accettazione parziale salva solo le sezioni AI approvate nel modello strutturato', () => {
  const ai = <T>(value: T) => ({ status: 'ai_only' as const, aiValue: value, pageIndex: 0, aiEvidence: String(value), requiresReview: true, reasons: [] });
  const reconciliation = {
    fields: {
      vehicleVin: ai('VF12RAJ1D56655103'), vehicleKilometers: ai(197000),
      projectName: ai('MARMED'), deliveryRecipient: ai('Magazzino'),
      shippingCarrier: ai('BARTOLINI SPA'), bankIban: ai('IT60X0542811101000000123456'),
      paCup: ai('G61B22002400006'), materialTotal: ai(978.61), notes: ai('Nota controllata'),
    },
    items: [], requiresReview: true, conflicts: [],
  } as HybridDocumentReconciliation;
  const structuredExtraction = {
    schemaVersion: 1 as const, metadata: {}, items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: false }, conditions: {},
    pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [],
  };
  const base = { id: 'q', type: 'quote' as const, title: 'Q', images: [], rawText: '', confidence: {}, items: [], createdAt: new Date(0), updatedAt: new Date(0), structuredExtraction };
  const initial = createHybridDocumentReview(reconciliation, { issues: [], blocking: false, requiresReview: false });
  const accepted = ['vehicleVin', 'vehicleKilometers', 'projectName', 'deliveryRecipient', 'shippingCarrier', 'bankIban', 'paCup', 'materialTotal', 'notes']
    .reduce((state, path) => decideHybridReview(state, path, 'accepted'), initial);
  const applied = materializeAcceptedHybridDocument(base, accepted);

  assert.equal(applied.structuredExtraction?.vehicle?.vin?.normalizedValue, 'VF12RAJ1D56655103');
  assert.equal(applied.structuredExtraction?.vehicle?.kilometers?.normalizedValue, 197000);
  assert.equal(applied.structuredExtraction?.project?.name?.normalizedValue, 'MARMED');
  assert.equal(applied.structuredExtraction?.delivery?.recipient?.normalizedValue, 'Magazzino');
  assert.equal(applied.structuredExtraction?.shipping?.carrier?.normalizedValue, 'BARTOLINI SPA');
  assert.equal(applied.structuredExtraction?.bank?.iban?.normalizedValue, 'IT60X0542811101000000123456');
  assert.equal(applied.structuredExtraction?.publicAdministrationData?.cup?.normalizedValue, 'G61B22002400006');
  assert.equal(applied.structuredExtraction?.summary.materialTotal?.normalizedValue, 978.61);
  assert.equal(applied.structuredExtraction?.conditions.notes?.normalizedValue, 'Nota controllata');
  assert.equal(applied.structuredExtraction?.vehicle?.vin?.source, 'ai');
});
