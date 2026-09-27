import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEmailEvidence,
  observedEmailScore,
  observedEmailValues,
  parserEmailValues,
  type EmailEvidenceLine,
} from '../lib/parser-v5/email-evidence';

function emailLine(
  rawOcr: string,
  overrides: Partial<EmailEvidenceLine> = {}
): EmailEvidenceLine {
  return {
    lineId: 7,
    pageIndex: 2,
    rawOcr,
    confidence: 0.88,
    ...overrides,
  };
}

function onlyEvidence(
  rawOcr: string,
  overrides: Partial<EmailEvidenceLine> = {}
) {
  const evidence = collectEmailEvidence([emailLine(rawOcr, overrides)]);
  assert.equal(evidence.length, 1, JSON.stringify(evidence));
  return evidence[0]!;
}

test('3B-01 email completa osservata resta OBSERVED', () => {
  const evidence = onlyEvidence('mario.rossi@example.com');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.rawValue, 'mario.rossi@example.com');
  assert.equal(evidence.origin, 'observed');
  assert.equal(evidence.validationStatus, 'valid');
  assert.equal(evidence.requiresReview, false);
  assert.equal(evidence.confirmed, true);
  assert.deepEqual(evidence.transformations, []);
});

test('3B-02 email osservata con maiuscole viene normalizzata senza perdere il raw', () => {
  const evidence = onlyEvidence('Mario.Rossi@EXAMPLE.COM');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.rawValue, 'Mario.Rossi@EXAMPLE.COM');
  assert.equal(evidence.rawOcr, 'Mario.Rossi@EXAMPLE.COM');
  assert.equal(evidence.origin, 'observed');
  assert.deepEqual(evidence.transformations, ['lowercase']);
  assert.equal(evidence.requiresReview, false);
});

test('3B-03 spazio attorno a @ produce REPAIRED tracciata', () => {
  const evidence = onlyEvidence('mario.rossi @ example.com');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.origin, 'repaired');
  assert.equal(evidence.repairedValue, 'mario.rossi@example.com');
  assert.ok(evidence.transformations.includes('remove_spaces_around_at'));
  assert.equal(evidence.requiresReview, true);
  assert.equal(evidence.confirmed, false);
});

test('3B-04 spazio nel dominio produce REPAIRED tracciata', () => {
  const evidence = onlyEvidence('mario.rossi@example com');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.origin, 'repaired');
  assert.ok(
    evidence.transformations.includes('replace_domain_space_with_dot')
  );
  assert.equal(evidence.requiresReview, true);
});

test('3B-05 punteggiatura terminale viene rimossa come repair', () => {
  const evidence = onlyEvidence('mario.rossi@example.com,');
  const sentenceEvidence = onlyEvidence('mario.rossi@example.com.');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.rawValue, 'mario.rossi@example.com,');
  assert.equal(evidence.origin, 'repaired');
  assert.deepEqual(evidence.transformations, [
    'trim_trailing_punctuation',
  ]);
  assert.equal(evidence.requiresReview, true);
  assert.equal(sentenceEvidence.value, 'mario.rossi@example.com');
  assert.equal(sentenceEvidence.rawValue, 'mario.rossi@example.com.');
  assert.equal(sentenceEvidence.origin, 'repaired');
  assert.equal(sentenceEvidence.requiresReview, true);
});

test('3B-06 token OCR confuso al posto di @ richiede review', () => {
  const evidence = onlyEvidence('mario.rossi (at) example.com');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.origin, 'repaired');
  assert.ok(evidence.transformations.includes('replace_confused_at'));
  assert.equal(evidence.requiresReview, true);
  assert.equal(evidence.confirmed, false);
});

test('3B-07 separatore OCR confuso al posto del punto dominio viene riparato', () => {
  const evidence = onlyEvidence('mario.rossi@example,com');

  assert.equal(evidence.value, 'mario.rossi@example.com');
  assert.equal(evidence.origin, 'repaired');
  assert.ok(
    evidence.transformations.includes('replace_confused_domain_dot')
  );
  assert.equal(evidence.requiresReview, true);
});

test('3B-08 email incompleta senza dominio viene rifiutata fail-closed', () => {
  assert.deepEqual(
    collectEmailEvidence([emailLine('Email: mario.rossi@')]),
    []
  );
});

test('3B-12 mailbox generica info@ osservata è valida e non personale inventata', () => {
  const evidence = onlyEvidence('info@example.com');

  assert.equal(evidence.value, 'info@example.com');
  assert.equal(evidence.origin, 'observed');
  assert.equal(evidence.confirmed, true);
});

test('3B-13 mailbox generica sales@ osservata è valida', () => {
  const evidence = onlyEvidence('sales@example.com');

  assert.equal(evidence.value, 'sales@example.com');
  assert.equal(evidence.origin, 'observed');
  assert.equal(evidence.requiresReview, false);
});

test('3B-14 due email osservate mantengono due provenance indipendenti', () => {
  const evidence = collectEmailEvidence([
    emailLine('mario.rossi@example.com', {
      lineId: 2,
      pageIndex: 0,
      confidence: 0.91,
    }),
    emailLine('info@example.com', {
      lineId: 8,
      pageIndex: 1,
      confidence: 0.83,
    }),
  ]);

  assert.deepEqual(
    evidence.map((item) => item.value),
    ['mario.rossi@example.com', 'info@example.com']
  );
  assert.deepEqual(
    evidence.map((item) => [item.pageIndex, item.lineId]),
    [
      [0, 2],
      [1, 8],
    ]
  );
  assert.ok(evidence.every((item) => item.origin === 'observed'));
});

test('3B-19 repair conservativo conserva raw, valore e trasformazioni', () => {
  const rawOcr = 'MARIO.ROSSI @ EXAMPLE . COM';
  const evidence = onlyEvidence(rawOcr, {
    lineId: 19,
    pageIndex: 3,
    confidence: 0.9,
  });

  assert.equal(evidence.rawValue, rawOcr);
  assert.equal(evidence.rawOcr, rawOcr);
  assert.equal(evidence.repairedValue, 'mario.rossi@example.com');
  assert.equal(evidence.origin, 'repaired');
  assert.ok(evidence.transformations.includes('remove_spaces_around_at'));
  assert.ok(evidence.transformations.includes('remove_spaces_around_dot'));
  assert.ok(evidence.transformations.includes('lowercase'));
  assert.equal(evidence.pageIndex, 3);
  assert.equal(evidence.lineId, 19);
});

test('3B-20 repair non sicuro non costruisce un indirizzo', () => {
  const evidence = collectEmailEvidence([
    emailLine('Mario Rossi'),
    emailLine('mario.rossi at example'),
    emailLine('www.example.com'),
  ]);

  assert.deepEqual(evidence, []);
});

test('3B-22 nessuna email riceve confidence automatica 0.95', () => {
  const observed = onlyEvidence('mario.rossi@example.com', {
    confidence: 0.91,
  });
  const repaired = onlyEvidence('mario.rossi @ example.com', {
    confidence: 0.91,
  });

  assert.equal(observed.confidence, 0.91);
  assert.ok(repaired.confidence < observed.confidence);
  assert.notEqual(observed.confidence, 0.95);
  assert.notEqual(repaired.confidence, 0.95);
  assert.equal(observedEmailScore([observed]), 0.91);
  assert.equal(observedEmailScore([repaired]), 0);
});

test('3B-23 origin, pageIndex, lineId e raw OCR sono sempre ricostruibili', () => {
  const rawOcr = 'Email: mario.rossi @ example.com';
  const evidence = onlyEvidence(rawOcr, {
    lineId: 42,
    pageIndex: 4,
    confidence: 0.84,
  });

  assert.equal(evidence.origin, 'repaired');
  assert.equal(evidence.pageIndex, 4);
  assert.equal(evidence.lineId, 42);
  assert.equal(evidence.rawOcr, rawOcr);
  assert.ok(evidence.rawValue.length > 0);
  assert.ok(evidence.transformations.length > 0);
});

test('3B-27 nomi, domini e aziende storiche non attivano hardcode email', () => {
  const historicalSpecificInputs = [
    ['Katie Pasciucco', 'Boston University', 'www.bu.edu'],
    ['Filippo Renga', 'POLIMI', 'www.som.polimi.it'],
    ['Kiveracing', 'Web: www.kiveracing.com'],
    ['Deana', 'G&H INTERNATIONAL', 'www.gandh.co.kr'],
    ['Marco Tagliabue', 'CORIUM', 'www.dcorium-srl.it'],
    ['Mario Rossi', 'ISISWARE', 'www.isisware.com'],
  ];

  for (const [caseIndex, input] of historicalSpecificInputs.entries()) {
    const evidence = collectEmailEvidence(
      input.map((rawOcr, lineIndex) =>
        emailLine(rawOcr, {
          lineId: caseIndex * 10 + lineIndex,
          pageIndex: 0,
        })
      )
    );
    assert.deepEqual(evidence, [], input.join(' | '));
  }
});

test('3B-28 email realmente osservate restano disponibili al parser', () => {
  const evidence = collectEmailEvidence([
    emailLine('info@ecosabbiatura.it', {
      lineId: 1,
      pageIndex: 0,
    }),
    emailLine('filippo.renga@polimi.it', {
      lineId: 2,
      pageIndex: 0,
    }),
  ]);

  assert.deepEqual(parserEmailValues(evidence), [
    'info@ecosabbiatura.it',
    'filippo.renga@polimi.it',
  ]);
  assert.deepEqual(observedEmailValues(evidence), [
    'info@ecosabbiatura.it',
    'filippo.renga@polimi.it',
  ]);
});
