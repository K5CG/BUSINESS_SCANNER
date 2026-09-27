import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLayoutLineForDisplay,
  formatOcrPageTextForDisplay,
  splitGluedContactSegment,
} from '../lib/ocr-display-format';

test('splitGluedContactSegment separa telefono ed email sulla stessa riga', () => {
  assert.deepEqual(
    splitGluedContactSegment('O445 602514 malo@pendingomme.com'),
    ['O445 602514', 'malo@pendingomme.com']
  );
  assert.deepEqual(
    splitGluedContactSegment('0444 1787736Opendingomme.com'),
    ['0444 1787736', 'Opendingomme.com']
  );
});

test('formatLayoutLineForDisplay usa elementi ML Kit per separare contatti', () => {
  assert.deepEqual(
    formatLayoutLineForDisplay({
      text: 'O445 602514 malo@pendingomme.com',
      elements: [
        { text: 'O445' },
        { text: '602514' },
        { text: 'malo@pendingomme.com' },
      ],
    }),
    ['O445 602514', 'malo@pendingomme.com']
  );

  assert.deepEqual(
    formatLayoutLineForDisplay({
      text: '0444 1787736Opendingomme.com',
      elements: [{ text: '0444' }, { text: '1787736Opendingomme.com' }],
    }),
    ['0444 1787736', 'Opendingomme.com']
  );
});

test('formatOcrPageTextForDisplay mantiene righe normali intatte', () => {
  const outcome = formatOcrPageTextForDisplay('PENDIN GOMME S.N.C.\n812/Z');
  assert.equal(outcome.reformatted, false);
  assert.equal(outcome.text, 'PENDIN GOMME S.N.C.\n812/Z');
});
