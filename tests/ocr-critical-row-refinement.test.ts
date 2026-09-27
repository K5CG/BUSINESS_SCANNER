import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFocusedCriticalRow, criticalBusinessCardRowKind } from '../lib/ocr-critical-row-refinement';

test('critical OCR: ambiguous civic glyph is eligible for focused reread', () => {
  assert.equal(criticalBusinessCardRowKind('Via Leida B, Verona'), 'address-civic');
  const decision = chooseFocusedCriticalRow('Via Leida B, Verona', 'Via Leida 8, Verona');
  assert.equal(decision.selected, 'Via Leida 8, Verona');
  assert.equal(decision.changed, true);
});

test('critical OCR: unrelated focused address is rejected', () => {
  const decision = chooseFocusedCriticalRow('Via Leida B, Verona', 'Corso Milano 55, Padova');
  assert.equal(decision.selected, null);
});

test('critical OCR: strongly labelled phone with glyph noise accepts pixel reread', () => {
  assert.equal(criticalBusinessCardRowKind('T +39 045 e1 O00 84'), 'phone');
  const decision = chooseFocusedCriticalRow('T +39 045 e1 O00 84', 'T +39 045 21 000 84');
  assert.equal(decision.selected, 'T +39 045 21 000 84');
});

test('critical OCR: qualsiasi lettera residua in una riga telefono numerica richiede rilettura', () => {
  assert.equal(criticalBusinessCardRowKind('Mobile 39 35S2951OW'), 'phone');
  const decision = chooseFocusedCriticalRow('Mobile 39 35S2951OW', '+39 335 5295104');
  assert.equal(decision.selected, '+39 335 5295104');
  assert.equal(decision.changed, true);
});

test('critical OCR: P.IVA con glifi alfabetici usa soltanto la rilettura dei pixel', () => {
  assert.equal(criticalBusinessCardRowKind('P.I. -O3527130267'), 'fiscal');
  const decision = chooseFocusedCriticalRow('P.I. -O3527130267', '03627130267');
  assert.equal(decision.selected, '03627130267');
  assert.equal(decision.changed, true);
});

test('critical OCR: ordinary rows are not reread by this gate', () => {
  assert.equal(criticalBusinessCardRowKind('Mario Rossi'), null);
  assert.equal(criticalBusinessCardRowKind('Via Roma 10, Milano'), null);
});

test('critical OCR: near-miss building qualifier is reread from pixels, not invented', () => {
  assert.equal(
    criticalBusinessCardRowKind('PO.Box 500435, Unit 3219, Bldg 3, Fhase 2'),
    'address-qualifier',
  );
  const decision = chooseFocusedCriticalRow(
    'PO.Box 500435, Unit 3219, Bldg 3, Fhase 2',
    'PO.Box 500435, Unit 3219, Bldg 3, Phase 2',
  );
  assert.equal(decision.selected, 'PO.Box 500435, Unit 3219, Bldg 3, Phase 2');
  assert.equal(decision.changed, true);
});
