import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractBusinessCardV5 } from '../lib/parser-v5';
import type { CardPageV5 } from '../lib/parser-v5/engine';
import { shouldRejectPersonCandidate } from '../lib/parser-v5/semantic-class';

interface PageOptions {
  confidence?: number;
  measuredConfidence?: number;
  heuristicQuality?: number;
  confidenceType?: OcrLine['confidenceType'];
}

function page(
  textLines: readonly string[],
  options: PageOptions = {}
): CardPageV5 {
  return {
    lines: textLines.map(
      (text, index): OcrLine => ({
        text,
        confidence: options.confidence ?? 0.94,
        measuredConfidence: options.measuredConfidence,
        heuristicQuality: options.heuristicQuality,
        confidenceType: options.confidenceType,
        boundingBox: {
          x: 4,
          y: index * 28,
          width: Math.max(90, text.length * 7),
          height: 20,
        },
      })
    ),
    rawText: textLines.join('\n'),
  };
}

test('etichette generiche di unità o servizio non sono persone', () => {
  assert.equal(shouldRejectPersonCandidate('Management Consultants'), true);
  assert.equal(shouldRejectPersonCandidate('Strategic Advisory Services'), true);
  assert.equal(shouldRejectPersonCandidate('Technology Division'), true);
  assert.equal(shouldRejectPersonCandidate('Luca Bianchi'), false);
});

test('una località isolata non è un componente del nome persona', () => {
  assert.equal(shouldRejectPersonCandidate('MILANO'), true);
  assert.equal(shouldRejectPersonCandidate('Luca Bianchi'), false);
});

test('layout nome-località-cognome non produce identità istituzionali o geografiche', () => {
  const result = extractBusinessCardV5([
    page([
      'School of Management',
      'POLUTECNICO DI MILANO',
      'UX',
      'Luca',
      'MILANO',
      'Bianchi',
      'DIPARTIMENTO',
      'DI INGEGNERIA',
      'GESTIONALE',
      'Via Aurora 10, 20100 Milano',
      'MBA',
      'luca bianchi@polytechnic it',
    ]),
  ]);
  const emittedPerson = [result.firstName.value, result.lastName.value]
    .filter(Boolean)
    .join(' ');

  assert.ok(
    emittedPerson === '' || emittedPerson === 'Luca Bianchi',
    `persona non supportata: ${emittedPerson}`
  );
  assert.doesNotMatch(
    emittedPerson,
    /milano|pol[iu]tecnico|school|management|dipartimento|ingegneria/i
  );
  if (!emittedPerson) {
    assert.equal(result.needsReview, true);
    assert.ok(result.reviewFields.includes('firstName'));
    assert.ok(result.reviewFields.includes('lastName'));
  }
});

test('onorifico con OCR euristico e nome non corroborato richiede review persona', () => {
  const result = extractBusinessCardV5([
    page(
      [
        'dr. Aurelio Vardinl',
        'Independent Advisor',
        'Tel: +39 02 5555 0188',
      ],
      {
        confidence: 0.75,
        heuristicQuality: 0.75,
        confidenceType: 'heuristic',
      }
    ),
  ]);

  assert.equal(result.firstName.value, 'Aurelio');
  assert.equal(result.lastName.value, 'Vardinl');
  assert.equal(result.needsReview, true);
  assert.ok(result.reviewFields.includes('firstName'));
  assert.ok(result.reviewFields.includes('lastName'));
});

test('nome comune con onorifico, OCR misurato ed email osservata non riceve review artificiale', () => {
  const result = extractBusinessCardV5([
    page(
      [
        'dr. Marco Bianchi',
        'Managing Director',
        'marco.bianchi@north-labs.example',
      ],
      {
        confidence: 0.97,
        measuredConfidence: 0.97,
        confidenceType: 'measured',
      }
    ),
  ]);

  assert.equal(result.firstName.value, 'Marco');
  assert.equal(result.lastName.value, 'Bianchi');
  assert.equal(result.reviewFields.includes('firstName'), false);
  assert.equal(result.reviewFields.includes('lastName'), false);
});


test('onorifico + nome separato dal cognome da una riga strutturata', () => {
  const result = extractBusinessCardV5([
    page([
      'Tel: +39 333 1234567',
      'marco.bianchi@north-labs.example',
      'Dott. Marco',
      'www.north-labs.example',
      'Bianchi',
      'Via Roma 10, 20100 Milano',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Marco');
  assert.equal(result.lastName.value, 'Bianchi');
});
