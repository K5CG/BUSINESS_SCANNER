import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateDocumentField,
  isApplicableDocumentField,
  isMissingDocumentValue,
  strictDocumentDateToDate,
  validateDocumentAmount,
  validateStrictDocumentDate,
} from '../lib/document-field-reliability';

function assertLocalDate(
  date: Date | undefined,
  year: number,
  month: number,
  day: number
): void {
  assert.ok(date);
  assert.equal(date.getFullYear(), year);
  assert.equal(date.getMonth(), month - 1);
  assert.equal(date.getDate(), day);
  assert.equal(date.getHours(), 0);
  assert.equal(date.getMinutes(), 0);
}

test('tutti i sentinel richiesti restano missing', () => {
  const values = [
    null,
    undefined,
    '',
    '   ',
    'N/A',
    'NA',
    'n.d.',
    'non disponibile',
    'unknown',
    'not found',
    'null',
    'undefined',
    '-',
    '—',
  ];

  for (const value of values) {
    assert.equal(isMissingDocumentValue(value), true, String(value));
  }
  assert.equal(isMissingDocumentValue('0'), false);
  assert.equal(isMissingDocumentValue(0), false);
});

test('data N/A e data vuota sono missing, non oggi', () => {
  for (const value of ['N/A', '']) {
    const result = validateStrictDocumentDate(value);
    assert.equal(result.validationStatus, 'missing');
    assert.equal(result.value, undefined);
    assert.equal(result.date, undefined);
  }
});

test('31/02 è invalid senza rollover', () => {
  const result = validateStrictDocumentDate('31/02/2026');
  assert.equal(result.validationStatus, 'invalid');
  assert.equal(result.value, undefined);
  assert.equal(result.date, undefined);
  assert.deepEqual(result.validationReasons, ['invalid_calendar_date']);
});

test('29/02 in anno non bisestile è invalid senza rollover', () => {
  const result = validateStrictDocumentDate('29/02/2025');
  assert.equal(result.validationStatus, 'invalid');
  assert.equal(result.value, undefined);
  assert.equal(result.date, undefined);
  assert.deepEqual(result.validationReasons, ['invalid_calendar_date']);
});

test('29/02 in anno bisestile è valida', () => {
  const result = validateStrictDocumentDate('29/02/2024');

  assert.equal(result.validationStatus, 'valid');
  assert.equal(result.value, '2024-02-29');
  assertLocalDate(result.date, 2024, 2, 29);
});

test('data giorno/mese ambigua conserva rawValue e richiede review', () => {
  const result = validateStrictDocumentDate('03/04/2026');

  assert.equal(result.validationStatus, 'ambiguous');
  assert.equal(result.rawValue, '03/04/2026');
  assert.equal(result.value, '2026-04-03');
  assert.equal(result.date, undefined);
  assert.equal(result.requiresReview, true);
});

test('una data ambigua confermata manualmente diventa valida', () => {
  const result = validateStrictDocumentDate('03/04/2026', {
    userConfirmed: true,
  });

  assert.equal(result.validationStatus, 'valid');
  assert.equal(result.value, '2026-04-03');
  assertLocalDate(result.date, 2026, 4, 3);
});

test('strictDocumentDateToDate non usa Date come validatore permissivo', () => {
  assert.equal(strictDocumentDateToDate('31/02/2026'), undefined);
  assertLocalDate(strictDocumentDateToDate('31/01/2026'), 2026, 1, 31);
});

test('la data validata conserva il giorno locale anche in un fuso UTC-negativo', () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assertLocalDate(strictDocumentDateToDate('2026-04-13'), 2026, 4, 13);
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test('un Date esistente conserva il calendario locale in un fuso UTC-positivo', () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    const result = validateStrictDocumentDate(new Date(2026, 0, 31));
    assert.equal(result.validationStatus, 'valid');
    assert.equal(result.value, '2026-01-31');
    assert.equal(result.rawValue, '2026-01-31');
    assertLocalDate(result.date, 2026, 1, 31);
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test('importo mancante resta missing', () => {
  for (const value of [undefined, null, '', 'N/A']) {
    const result = validateDocumentAmount(value);
    assert.equal(result.validationStatus, 'missing');
    assert.equal(result.value, undefined);
  }
});

test('zero esplicito numerico e testuale è valido', () => {
  for (const value of [0, '0', '0,00', '€ 0,00']) {
    const result = validateDocumentAmount(value);
    assert.equal(result.validationStatus, 'valid', String(value));
    assert.equal(result.value, 0, String(value));
  }
});

test('un importo OCR malformato non viene ripulito fino a sembrare valido', () => {
  for (const value of ['1O0,00', '12abc34', 'EUR N/A 0', '1.2.3']) {
    const result = validateDocumentAmount(value);
    assert.equal(result.validationStatus, 'invalid', value);
    assert.equal(result.value, undefined, value);
    assert.equal(result.requiresReview, true, value);
  }
  for (const [value, expected] of [
    ['€ 1.234,56', 1234.56],
    ['USD 1,234.56', 1234.56],
    ['1 234,56 EUR', 1234.56],
  ] as const) {
    const result = validateDocumentAmount(value);
    assert.equal(result.validationStatus, 'valid', value);
    assert.equal(result.value, expected, value);
  }
});

test('confidence cloud assente è unknown e non diventa 0.95', () => {
  const evidence = evaluateDocumentField('total', 100, {
    source: 'cloud_ai',
    pageIndex: 1,
  });

  assert.equal(evidence.confidence, undefined);
  assert.equal(evidence.confidenceType, 'unknown');
  assert.equal(evidence.requiresReview, true);
  assert.equal(
    evidence.validationReasons.includes('provider_confidence_unavailable'),
    true
  );
});

test('confidence euristica resta distinta da una misura', () => {
  const heuristic = evaluateDocumentField('total', 100, {
    source: 'local_ocr',
    confidence: 0.7,
    confidenceType: 'heuristic',
  });
  const measured = evaluateDocumentField('total', 100, {
    source: 'local_ocr',
    confidence: 0.7,
    confidenceType: 'measured',
  });

  assert.equal(heuristic.confidenceType, 'heuristic');
  assert.equal(measured.confidenceType, 'measured');
});

test('array assente resta missing', () => {
  const absent = evaluateDocumentField('items', undefined, {
    source: 'cloud_ai',
  });
  assert.equal(absent.validationStatus, 'missing');
});

test('array vuoto resta missing e non aumenta la qualità', () => {
  const empty = evaluateDocumentField('items', [], {
    source: 'cloud_ai',
  });
  assert.equal(empty.validationStatus, 'missing');
  assert.deepEqual(empty.value, []);
});

test('quantità mancante richiede review e quantità zero esplicita è valida', () => {
  const missing = evaluateDocumentField(
    'items',
    [{ description: 'Riga', unitPrice: 10, total: 10 }],
    { source: 'cloud_ai' }
  );
  const zero = evaluateDocumentField(
    'items',
    [{ description: 'Omaggio', quantity: 0, unitPrice: 0, total: 0 }],
    { source: 'cloud_ai' }
  );

  assert.equal(missing.validationStatus, 'unverified');
  assert.equal(missing.requiresReview, true);
  assert.equal(zero.validationStatus, 'valid');
  assert.deepEqual(zero.value, [
    { description: 'Omaggio', quantity: 0, unitPrice: 0, total: 0 },
  ]);
});

test('invalid e missing non sono applicabili', () => {
  const invalid = evaluateDocumentField('date', '31/02/2026', {
    source: 'cloud_ai',
  });
  const missing = evaluateDocumentField('total', undefined, {
    source: 'cloud_ai',
  });

  assert.equal(isApplicableDocumentField(invalid), false);
  assert.equal(isApplicableDocumentField(missing), false);
});

test('modifica manuale ha source user e precedenza semantica', () => {
  const evidence = evaluateDocumentField('documentNumber', 'Q-USER', {
    source: 'user',
    userConfirmed: true,
  });

  assert.equal(evidence.source, 'user');
  assert.equal(evidence.validationStatus, 'valid');
  assert.equal(evidence.requiresReview, false);
  assert.equal(isApplicableDocumentField(evidence), true);
});
