import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine, OcrQualityMetadata } from '../types';
import {
  aggregateOcrQuality,
  assessOcrQuality,
  createProviderOcrLine,
  emptyOcrQuality,
  legacyOcrQualityMetadata,
  normalizeMeasuredConfidence,
  ocrParserCompatibilityConfidence,
  reconcileOcrQualityMetadata,
} from '../lib/ocr-quality';
import { buildOcrQualityViewModel } from '../lib/ocr-quality-view-model';
import {
  pageResultFromCloudExtract,
  pageResultFromLocalSnapshot,
} from '../lib/document-page-extraction';
import { evaluateDocumentField } from '../lib/document-field-reliability';
import { getSafeContactEmails } from '../lib/email-evidence';

function box(y = 0) {
  return { x: 0, y, width: 180, height: 22 };
}

function providerLine(
  text: string,
  confidence?: number,
  y = 0
): OcrLine {
  return createProviderOcrLine({
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    boundingBox: box(y),
  });
}

function completeMeasuredQuality(
  measuredConfidence: number,
  heuristicQuality = 0.8
): OcrQualityMetadata {
  return {
    measuredConfidence,
    heuristicQuality,
    confidenceType: 'measured',
    qualityReasons: ['provider_confidence_available'],
    requiresReview: measuredConfidence < 0.6 || heuristicQuality < 0.55,
  };
}

test('4C-01 provider con confidence reale conserva una misura reale', () => {
  const line = providerLine('Mario Rossi', 0.91);
  const quality = assessOcrQuality([line], line.text, { source: 'local' });

  assert.equal(line.confidenceType, 'measured');
  assert.equal(line.measuredConfidence, 0.91);
  assert.equal(quality.confidenceType, 'measured');
  assert.equal(quality.measuredConfidence, 0.91);
});

test('4C-02 provider senza confidence resta unknown e senza misura', () => {
  const line = providerLine('Mario Rossi');
  const quality = assessOcrQuality([line], line.text, { source: 'local' });

  assert.equal(line.confidenceType, 'unknown');
  assert.equal(line.measuredConfidence, undefined);
  assert.equal(quality.confidenceType, 'unknown');
  assert.equal(quality.measuredConfidence, undefined);
});

test('4C-03 valori provider non finiti o fuori scala non diventano measured', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
    assert.equal(normalizeMeasuredConfidence(value), undefined);
    const line = createProviderOcrLine({ text: 'Test', confidence: value });
    assert.equal(line.confidenceType, 'unknown');
    assert.equal(line.measuredConfidence, undefined);
  }
});

test('4C-04 OCR vuoto ha quality zero e richiede review', () => {
  const quality = assessOcrQuality([], '', { source: 'local' });

  assert.equal(quality.heuristicQuality, 0);
  assert.equal(quality.requiresReview, true);
  assert.ok(quality.qualityReasons.includes('empty_text'));
});

test('4C-05 OCR molto corto resta sotto la soglia di review', () => {
  const line = providerLine('AB');
  const quality = assessOcrQuality([line], 'AB', { source: 'local' });

  assert.ok((quality.heuristicQuality ?? 1) < 0.55);
  assert.equal(quality.requiresReview, true);
  assert.ok(quality.qualityReasons.includes('very_short_text'));
});

test('4C-06 molti caratteri anomali abbassano la qualità', () => {
  const cleanText = 'Mario Rossi mario@example.com +39 333 1234567';
  const noisyText = 'Mario \ufffd\ufffd\ufffd\u0001\u0002 \ufffd\ufffd\ufffd \u007f Rossi';
  const clean = assessOcrQuality(
    [providerLine(cleanText)],
    cleanText,
    { source: 'local' }
  );
  const noisy = assessOcrQuality(
    [providerLine(noisyText)],
    noisyText,
    { source: 'local' }
  );

  assert.ok(
    (noisy.heuristicQuality ?? 1) < (clean.heuristicQuality ?? 0)
  );
  assert.ok(noisy.qualityReasons.includes('anomalous_characters'));
});

test('4C-07 testo e campi coerenti producono quality alta ma non measured', () => {
  const lines = [
    providerLine('Mario Rossi - Direttore commerciale', undefined, 0),
    providerLine('mario.rossi@example.com', undefined, 25),
    providerLine('+39 333 1234567 - www.example.com', undefined, 50),
  ];
  const quality = assessOcrQuality(
    lines,
    lines.map((line) => line.text).join('\n'),
    { source: 'local' }
  );

  assert.ok((quality.heuristicQuality ?? 0) >= 0.7);
  assert.equal(quality.confidenceType, 'unknown');
  assert.equal(quality.measuredConfidence, undefined);
  assert.ok(quality.qualityReasons.includes('recognized_contact_fields'));
});

test('4C-08 quality alta non rende valida una data impossibile', () => {
  const lines = [
    providerLine('Preventivo 2026 per Cliente Example Srl', undefined, 0),
    providerLine('Data 31/02/2026 - Totale EUR 1.250,00', undefined, 25),
    providerLine('amministrazione@example.com +39 0444 123456', undefined, 50),
  ];
  const result = pageResultFromLocalSnapshot(
    'quote',
    0,
    'file:///quote.jpg',
    {
      lines,
      rawText: lines.map((line) => line.text).join('\n'),
      completed: true,
    },
    'local',
    undefined,
    () => ({ date: '31/02/2026', total: 1250 })
  );

  assert.ok((result.ocrQuality?.heuristicQuality ?? 0) >= 0.7);
  assert.equal(result.fieldReliability?.date?.validationStatus, 'invalid');
  assert.equal(result.fieldReliability?.date?.requiresReview, true);
  assert.equal(result.requiresReview, true);
});

test('4C-09 quality bassa non cancella una email valida osservata', () => {
  const email = 'a@b.co';
  const noisyOcr = `${email} \ufffd\ufffd\ufffd\u0001\ufffd\ufffd`;
  const quality = assessOcrQuality(
    [providerLine(noisyOcr)],
    noisyOcr,
    { source: 'local' }
  );
  const safe = getSafeContactEmails({
    emails: [email],
    emailEvidence: [
      {
        value: email,
        rawValue: email,
        origin: 'observed',
        pageIndex: 0,
        lineId: 0,
        rawOcr: email,
        transformations: [],
        confidence: 0.45,
        validationStatus: 'valid',
        requiresReview: false,
        confirmed: true,
      },
    ],
  });

  assert.ok((quality.heuristicQuality ?? 1) < 0.55);
  assert.deepEqual(safe, [email]);
});

test('4C-10 righe locali senza misura non ricevono tutte 0.85', () => {
  const values = [
    providerLine('A').confidence,
    providerLine('Mario Rossi').confidence,
    providerLine('mario@example.com', undefined, 20).confidence,
  ];

  assert.ok(values.some((value) => value !== 0.85));
  assert.ok(new Set(values).size > 1);
});

test('4C-11 un valore reale pari a 0.85 resta measured', () => {
  const line = providerLine('Misura reale del provider', 0.85);

  assert.equal(line.measuredConfidence, 0.85);
  assert.equal(line.confidence, 0.85);
  assert.equal(line.confidenceType, 'measured');
});

test('4C-12 una derivazione esplicita resta heuristic e mai measured', () => {
  const line: OcrLine = {
    text: 'Testo derivato da record legacy',
    confidence: 0.72,
    heuristicQuality: 0.72,
    confidenceType: 'heuristic',
  };
  const quality = assessOcrQuality([line], line.text, {
    confidenceType: 'heuristic',
    source: 'derived',
  });

  assert.equal(quality.confidenceType, 'heuristic');
  assert.equal(quality.measuredConfidence, undefined);
  assert.equal(typeof quality.heuristicQuality, 'number');
});

test('4C-13 UI mostra esplicitamente affidabilità misurata', () => {
  const view = buildOcrQualityViewModel(
    completeMeasuredQuality(0.923),
    'it'
  );

  assert.equal(view.confidenceKind, 'measured');
  assert.equal(view.confidenceLabel, 'Affidabilità OCR misurata');
  assert.equal(view.confidenceValue, '92%');
});

test('4C-14 UI chiama la derivazione qualità stimata', () => {
  const view = buildOcrQualityViewModel(
    {
      heuristicQuality: 0.72,
      confidenceType: 'heuristic',
      qualityReasons: ['legacy_quality_estimate'],
      requiresReview: false,
    },
    'it'
  );

  assert.equal(view.confidenceKind, 'estimated');
  assert.equal(view.confidenceLabel, 'Qualità OCR stimata');
  assert.equal(view.confidenceValue, '72%');
  assert.doesNotMatch(view.confidenceLabel.toLowerCase(), /probabil/);
});

test('4C-15 UI unknown mostra dato non disponibile e stima separata', () => {
  const view = buildOcrQualityViewModel(
    {
      heuristicQuality: 0.66,
      confidenceType: 'unknown',
      qualityReasons: ['provider_confidence_unavailable'],
      requiresReview: false,
    },
    'it'
  );

  assert.equal(view.confidenceKind, 'unavailable');
  assert.equal(view.confidenceLabel, 'Affidabilità OCR non disponibile');
  assert.equal(view.confidenceValue, undefined);
  assert.equal(view.estimatedQualityLabel, 'Qualità OCR stimata');
  assert.equal(view.estimatedQualityValue, '66%');
});

test('4C-16 measured bassa forza requiresReview anche con testo leggibile', () => {
  const line = providerLine(
    'Mario Rossi mario.rossi@example.com +39 333 1234567',
    0.4
  );
  const quality = assessOcrQuality([line], line.text, { source: 'local' });

  assert.ok((quality.heuristicQuality ?? 0) >= 0.55);
  assert.equal(quality.measuredConfidence, 0.4);
  assert.equal(quality.requiresReview, true);
});

test('4C-17 campo manuale resta user e indipendente dalla qualità OCR', () => {
  const lowQuality = emptyOcrQuality();
  const manual = evaluateDocumentField('customerName', 'Cliente corretto', {
    source: 'user',
    confidenceType: 'unknown',
    userConfirmed: true,
  });

  assert.equal(lowQuality.requiresReview, true);
  assert.equal(manual.source, 'user');
  assert.equal(manual.validationStatus, 'valid');
  assert.equal(manual.requiresReview, false);
  assert.equal(manual.confidenceType, 'unknown');
});

test('4C-18 risultato cloud senza confidence resta unknown', () => {
  const result = pageResultFromCloudExtract(0, 'file:///cloud.jpg', {
    rawText: 'Preventivo 12 Data 24/07/2026 Totale EUR 100,00',
    documentNumber: '12',
    date: '24/07/2026',
    total: 100,
  });

  assert.equal(result.processingMethod, 'cloud');
  assert.equal(result.ocrQuality?.confidenceType, 'unknown');
  assert.equal(result.ocrQuality?.measuredConfidence, undefined);
  assert.ok(result.ocrQuality?.qualityReasons.includes('cloud_result'));
});

test('4C-19 risultato locale conserva unknown e quality separata', () => {
  const lines = [
    providerLine('Ordine 42', undefined, 0),
    providerLine('Totale EUR 250,00', undefined, 25),
  ];
  const result = pageResultFromLocalSnapshot(
    'order',
    0,
    'file:///local.jpg',
    {
      lines,
      rawText: lines.map((line) => line.text).join('\n'),
      completed: true,
    },
    'local',
    undefined,
    () => ({ documentNumber: '42', total: 250 })
  );

  assert.equal(result.processingMethod, 'local');
  assert.equal(result.ocrQuality?.confidenceType, 'unknown');
  assert.equal(result.ocrQuality?.measuredConfidence, undefined);
  assert.equal(typeof result.ocrQuality?.heuristicQuality, 'number');
});

test('4C-20 merge multipagina tutto measured aggrega le misure', () => {
  const aggregate = aggregateOcrQuality([
    completeMeasuredQuality(0.8, 0.7),
    completeMeasuredQuality(0.9, 0.9),
  ]);

  assert.equal(aggregate.confidenceType, 'measured');
  assert.equal(aggregate.measuredConfidence, 0.85);
  assert.equal(aggregate.heuristicQuality, 0.8);
  assert.ok(aggregate.qualityReasons.includes('multipage_aggregate'));
});

test('4C-21 merge multipagina misto non promuove una misura parziale', () => {
  const aggregate = aggregateOcrQuality([
    completeMeasuredQuality(0.9),
    {
      heuristicQuality: 0.75,
      confidenceType: 'unknown',
      qualityReasons: ['provider_confidence_unavailable'],
      requiresReview: false,
    },
  ]);

  assert.equal(aggregate.confidenceType, 'unknown');
  assert.equal(aggregate.measuredConfidence, undefined);
});

test('4C-22 conflitto multipagina abbassa quality e forza review', () => {
  const text =
    'Preventivo 42 Data 24/07/2026 Totale EUR 100,00 cliente@example.com';
  const withoutConflict = assessOcrQuality(
    [providerLine(text)],
    text,
    { source: 'local' }
  );
  const withConflict = assessOcrQuality(
    [providerLine(text)],
    text,
    { source: 'local', conflictCount: 1 }
  );

  assert.ok(
    (withConflict.heuristicQuality ?? 1) <
      (withoutConflict.heuristicQuality ?? 0)
  );
  assert.equal(withConflict.requiresReview, true);
  assert.ok(withConflict.qualityReasons.includes('page_conflict'));
});

test('4C-23 aggregazione senza pagine resta unknown e review', () => {
  const aggregate = aggregateOcrQuality([]);

  assert.equal(aggregate.confidenceType, 'unknown');
  assert.equal(aggregate.measuredConfidence, undefined);
  assert.equal(aggregate.requiresReview, true);
});

test('4C-24 valore legacy è etichettato heuristic, non measured', () => {
  const legacy = legacyOcrQualityMetadata(0.49);

  assert.equal(legacy?.confidenceType, 'heuristic');
  assert.equal(legacy?.heuristicQuality, 0.49);
  assert.equal(legacy?.measuredConfidence, undefined);
  assert.equal(legacy?.requiresReview, true);
  assert.ok(legacy?.qualityReasons.includes('legacy_quality_estimate'));
});

test('4C-25 pagina senza metadata degrada aggregato mixed a unknown', () => {
  const aggregate = aggregateOcrQuality([
    completeMeasuredQuality(0.94),
    undefined,
  ]);

  assert.equal(aggregate.confidenceType, 'unknown');
  assert.equal(aggregate.measuredConfidence, undefined);
  assert.equal(aggregate.requiresReview, true);
  assert.ok(
    aggregate.qualityReasons.includes('provider_confidence_unavailable')
  );

  const heuristicWithMissing = aggregateOcrQuality([
    legacyOcrQualityMetadata(0.8),
    undefined,
  ]);
  assert.equal(heuristicWithMissing.confidenceType, 'unknown');
  assert.equal(heuristicWithMissing.requiresReview, true);
});

test('4C-26 metadata measured del page extractor non viene degradato', () => {
  const supplied = completeMeasuredQuality(0.93, 0.82);
  const result = pageResultFromLocalSnapshot(
    'quote',
    0,
    'file:///measured.jpg',
    {
      lines: [
        {
          text: 'Preventivo 42 Totale EUR 250,00',
          confidence: 0.72,
          heuristicQuality: 0.72,
          confidenceType: 'heuristic',
          boundingBox: box(),
        },
      ],
      rawText: 'Preventivo 42 Totale EUR 250,00',
      ocrQuality: supplied,
      completed: true,
    },
    'local',
    undefined,
    () => ({ documentNumber: '42', total: 250 })
  );

  assert.equal(result.ocrQuality?.confidenceType, 'measured');
  assert.equal(result.ocrQuality?.measuredConfidence, 0.93);
});

test('4C-27 prior parser storico è separato dai metadata mostrabili', () => {
  const unknown = providerLine('Mario Rossi');
  const measured = providerLine('Mario Rossi', 0.91);
  const heuristic: OcrLine = {
    text: 'Testo sintetico',
    confidence: 0.72,
    heuristicQuality: 0.72,
    confidenceType: 'heuristic',
  };
  const legacy: OcrLine = {
    text: 'Dataset legacy',
    confidence: 0.77,
  };

  assert.notEqual(unknown.confidence, 0.85);
  assert.equal(ocrParserCompatibilityConfidence(unknown), 0.85);
  assert.equal(ocrParserCompatibilityConfidence(measured), 0.85);
  assert.equal(ocrParserCompatibilityConfidence(heuristic), 0.72);
  assert.equal(ocrParserCompatibilityConfidence(legacy), 0.77);
});

test('4C-28 review OCR resta separata dal contratto field-merge', () => {
  const line = providerLine('10');
  const result = pageResultFromLocalSnapshot(
    'quote',
    0,
    'file:///short-but-valid-total.jpg',
    {
      lines: [line],
      rawText: '10',
      completed: true,
    },
    'local',
    undefined,
    () => ({ total: 10 })
  );

  assert.equal(result.ocrQuality?.requiresReview, true);
  assert.equal(result.fieldReliability?.total?.validationStatus, 'valid');
  assert.equal(result.requiresReview, false);
});

test('4C-29 reconcile degrada una misura dichiarata ma malformata', () => {
  const supplied: OcrQualityMetadata = {
    measuredConfidence: 2,
    heuristicQuality: 0.9,
    confidenceType: 'measured',
    qualityReasons: ['provider_confidence_available'],
    requiresReview: false,
  };
  const reconciled = reconcileOcrQualityMetadata(
    supplied,
    assessOcrQuality([providerLine('Testo OCR leggibile')], 'Testo OCR leggibile')
  );

  assert.equal(reconciled.confidenceType, 'unknown');
  assert.equal(reconciled.measuredConfidence, undefined);
  assert.equal(reconciled.requiresReview, true);
  assert.ok(
    reconciled.qualityReasons.includes('provider_confidence_unavailable')
  );
});

test('4C-30 errore di strutturazione non conserva una falsa misura', () => {
  const result = pageResultFromLocalSnapshot(
    'quote',
    0,
    'file:///failed-structure.jpg',
    {
      lines: [providerLine('Preventivo leggibile')],
      rawText: 'Preventivo leggibile',
      ocrQuality: {
        measuredConfidence: 2,
        heuristicQuality: 0.9,
        confidenceType: 'measured',
        qualityReasons: ['provider_confidence_available'],
        requiresReview: false,
      },
      completed: true,
    },
    'local',
    undefined,
    () => {
      throw new Error('struttura non valida');
    }
  );

  assert.equal(result.processingMethod, 'failed');
  assert.equal(result.ocrQuality?.confidenceType, 'unknown');
  assert.equal(result.ocrQuality?.measuredConfidence, undefined);
  assert.equal(result.ocrQuality?.requiresReview, true);
});

test('4C-31 UI rifiuta confidence measured persistita fuori scala', () => {
  const view = buildOcrQualityViewModel(
    {
      measuredConfidence: 2,
      confidenceType: 'measured',
      qualityReasons: ['provider_confidence_available'],
      requiresReview: true,
    },
    'it'
  );

  assert.equal(view.confidenceKind, 'unavailable');
  assert.equal(view.confidenceValue, undefined);
  assert.equal(view.confidenceLabel, 'Affidabilità OCR non disponibile');
});
