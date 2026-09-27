import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTableHeading,
  isSummaryOrAggregateHeading,
  selectCoherentCommercialLevel,
} from '../lib/document-table-hierarchy';

test('8 detail table + summary table does not hybridize', () => {
  const items = selectCoherentCommercialLevel([
    { description: 'Lancette rosa conf. 400 pz', sourceLines: ['Lancette rosa conf. 400 pz'], quantity: 400, unitPrice: 0.78, lineTotal: 312 },
    { description: 'Lancette giallo conf. 400 pz', sourceLines: ['Lancette giallo conf. 400 pz'], quantity: 400, unitPrice: 0.78, lineTotal: 312 },
    { description: 'Lancette rosa 2.400 PZ', sourceLines: ['RIEPILOGO', 'QUANTITA TRIENNALE', 'Lancette rosa 2.400 PZ'], quantity: 2400, lineTotal: 1872 },
  ], [
    'CODICE DESCRIZIONE',
    'Lancette rosa conf. 400 pz',
    'Lancette giallo conf. 400 pz',
    'RIEPILOGO',
    'QUANTITA TRIENNALE',
    'Lancette rosa 2.400 PZ',
  ], 4914);
  assert.equal(items.some((item) => item.lineTotal === 312) && items.some((item) => item.lineTotal === 1872), false);
});

test('9 configuration table + aggregate quantity recap picks one level', () => {
  assert.equal(classifyTableHeading('QUANTITÀ TRIENNALE'), 'aggregate_summary');
  const items = selectCoherentCommercialLevel([
    { description: 'Kit A configuration', sourceLines: ['Kit A configuration'], quantity: 1, unitPrice: 100, lineTotal: 100 },
    { description: 'Kit A annual total', sourceLines: ['ANNUAL TOTAL', 'Kit A annual total'], quantity: 12, lineTotal: 1200 },
  ], ['Kit A configuration', 'ANNUAL TOTAL', 'Kit A annual total'], 1200);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.lineTotal, 1200);
});

test('10 repeated page header is not a second commercial table', () => {
  assert.equal(isSummaryOrAggregateHeading('PREVENTIVO N. 12'), false);
  const items = selectCoherentCommercialLevel([
    { description: 'Filter A', sourceLines: ['Filter A'], quantity: 2, unitPrice: 10, lineTotal: 20 },
    { description: 'Filter B', sourceLines: ['Filter B'], quantity: 1, unitPrice: 15, lineTotal: 15 },
  ], ['PREVENTIVO N. 12', 'Filter A', 'PREVENTIVO N. 12', 'Filter B'], 35);
  assert.equal(items.length, 2);
});

test('11 page subtotal table is totals_only when headed as VAT summary', () => {
  assert.equal(classifyTableHeading('RIEPILOGO IVA / VAT SUMMARY'), 'totals_only');
});

test('12 two real additive tables are kept', () => {
  const items = selectCoherentCommercialLevel([
    { description: 'Pump model A', sourceLines: ['Pump model A'], quantity: 1, unitPrice: 100, lineTotal: 100 },
    { description: 'Service visit', sourceLines: ['Service visit'], quantity: 1, unitPrice: 40, lineTotal: 40 },
  ], ['Pump model A', 'NOTE', 'Service visit'], 140);
  assert.equal(items.length, 2);
});

test('13 overlapping summary/detail tables select one representation', () => {
  const items = selectCoherentCommercialLevel([
    { description: 'Octaheel Baby rosa', sourceLines: ['Octaheel Baby rosa'], quantity: 400, unitPrice: 0.78, lineTotal: 312 },
    { description: 'Octaheel Baby rosa', sourceLines: ['TOTALE TRIENNALE', 'Octaheel Baby rosa'], quantity: 2400, lineTotal: 1872 },
  ], ['Octaheel Baby rosa', 'RIEPILOGO', 'TOTALE TRIENNALE', 'Octaheel Baby rosa'], 1872);
  assert.equal(items.length, 1);
});

test('14 no hybrid output between hierarchy levels', () => {
  const items = selectCoherentCommercialLevel([
    { description: 'Item pack', sourceLines: ['Item pack'], quantity: 400, unitPrice: 0.78, lineTotal: 312 },
    { description: 'Item pack', sourceLines: ['Item pack'], quantity: 400, unitPrice: 0.78, lineTotal: 312 },
    { description: 'Item pack recap', sourceLines: ['SUMMARY', 'Item pack recap'], lineTotal: 1872 },
  ], ['Item pack', 'Item pack', 'SUMMARY', 'Item pack recap'], 624);
  assert.equal(items.some((item) => (item.lineTotal ?? 0) === 312) && items.some((item) => item.lineTotal === 1872), false);
});
