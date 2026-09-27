import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCardFromPages } from '../lib/parser';
import { initializeParsedContactReviewState, recordAiApplication } from '../lib/contact-review-state';

function page(rawText: string) {
  return {
    rawText,
    lines: rawText.split('\n').map((text, index) => ({
      text, confidence: 0.96,
      boundingBox: { x: 8, y: index * 25, width: 480, height: 20 },
    })),
  };
}

test('V96: due email aziendali osservate prevalgono su una lettura logo non affidabile', () => {
  const rawText = `SPEGDARIK\nPiero\npiero@speedmark.it\ninfo@speedmark.it\nViale Venezia 28/A\n36067 Cassola (VI)`;
  const card = parseCardFromPages([page(rawText)]);
  assert.equal(card.company, 'Speedmark');
  assert.deepEqual(card.emails, ['piero@speedmark.it', 'info@speedmark.it']);
});

test('V96: una coda tecnica OCR non viene concatenata a un acronimo aziendale corroborato', () => {
  const rawText = `TMRC tbitAdd: IbXGA10\nEmail:sale1@tmrc.net\nNancy Chen\nWeb:www.tmrcmotor.com`;
  const card = parseCardFromPages([page(rawText)]);
  assert.equal(card.company, 'TMRC');
  assert.equal(card.firstName, 'Nancy');
  assert.equal(card.lastName, 'Chen');
});

test('V96: una modifica AI applicata resta leggibile nel QA del contatto', () => {
  const initial = initializeParsedContactReviewState({
    id: 'v96-ai', type: 'business_card' as const, title: 'SERRAMENTI', images: [], rawText: 'SERRAMENTI',
    firstName: '', lastName: '', role: '', company: 'SERRAMENTI', emails: [], phones: [],
    confidence: {}, createdAt: new Date(), updatedAt: new Date(),
  });
  const updated = recordAiApplication({ ...initial, company: 'Bf Di Fleaca Serramenti' }, ['company']);
  assert.deepEqual(updated.contactReviewState?.aiApplications?.[0]?.fields, ['company']);
});
