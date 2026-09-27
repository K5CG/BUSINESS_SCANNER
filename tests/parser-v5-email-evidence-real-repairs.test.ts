import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEmailEvidence,
  type EmailEvidenceLine,
} from '../lib/parser-v5/email-evidence';

function line(rawOcr: string, lineId = 0): EmailEvidenceLine {
  return {
    lineId,
    pageIndex: 0,
    rawOcr,
    confidence: 0.91,
  };
}

function repaired(rawOcr: string) {
  const evidence = collectEmailEvidence([line(rawOcr)]);
  assert.equal(evidence.length, 1, JSON.stringify(evidence));
  assert.equal(evidence[0]!.origin, 'repaired');
  assert.equal(evidence[0]!.requiresReview, true);
  assert.equal(evidence[0]!.confirmed, false);
  assert.equal(evidence[0]!.rawOcr, rawOcr);
  assert.equal(evidence[0]!.rawValue, rawOcr);
  return evidence[0]!;
}

test('simbolo registrato al posto di @ viene riparato solo con etichetta email', () => {
  const evidence = repaired('e-mail: skoda®autovega.com');

  assert.equal(evidence.value, 'skoda@autovega.com');
  assert.equal(evidence.repairedValue, 'skoda@autovega.com');
  assert.ok(
    evidence.transformations.includes('replace_registered_symbol_with_at')
  );
  assert.deepEqual(
    collectEmailEvidence([line('skoda®autovega.com')]),
    []
  );
});

test('o OCR al posto di @ usa un solo split completo osservato sulla riga', () => {
  const evidence = repaired('E-mail: katiepobu. edu');
  const uppercaseEvidence = repaired('Email: katiepObu.edu');

  assert.equal(evidence.value, 'katiep@bu.edu');
  assert.equal(evidence.repairedValue, 'katiep@bu.edu');
  assert.ok(evidence.transformations.includes('replace_ocr_o_with_at'));
  assert.ok(evidence.transformations.includes('remove_spaces_around_dot'));
  assert.equal(uppercaseEvidence.value, 'katiep@bu.edu');
  assert.ok(
    uppercaseEvidence.transformations.includes('replace_ocr_o_with_at')
  );
});

test('repair o/O resta fail-closed senza etichetta, dominio o split univoco', () => {
  const evidence = collectEmailEvidence([
    line('katiepobu. edu', 1),
    line('E-mail: katiepobu edu', 2),
    line('E-mail: katiepo', 3),
    line('E-mail: fooobar.com', 4),
    line('E-mail: katiep', 5),
    line('bu.edu', 6),
  ]);

  assert.deepEqual(evidence, []);
});
