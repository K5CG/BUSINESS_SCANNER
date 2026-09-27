import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCardV5 } from '../lib/parser-v5/engine';
import { chooseFocusedEmail, isPotentialEmailRow } from '../lib/ocr-email-refinement';

function parse(rawText: string) {
  const lines = rawText.split(/\n/).map((text, index) => ({
    text,
    confidence: 0.9,
    boundingBox: { x: 0, y: index * 20, width: 220, height: 18 },
  }));
  return extractCardV5([{ rawText, lines }]);
}

test('company osservata non viene persa se corroborata da descrittore organizzativo adiacente', () => {
  const r = parse([
    'DANTE CHIERICO',
    'PERITO INDUSTRIALE',
    'S.A.GE. MA, s. n.e.',
    'SISTEMI AUTOMATICI GENERALI E MACCHINE',
    '(0445) 671155',
  ].join('\n'));
  assert.equal(r.role.value, 'PERITO INDUSTRIALE');
  assert.match(r.company.value ?? '', /S\.A\.GE\. MA/i);
  assert.ok(r.company.score < 0.7);
});

test('ruolo low senza evidenza semantica resta vuoto', () => {
  const r = parse([
    'Christian Pezzin',
    'Scout S.r.l.',
    'bcas ILAN O',
    'christian.pezzin@scout. it',
    'www.scout.it',
  ].join('\n'));
  assert.equal(r.role.value, null);
  // Il parser non deve promuovere da solo una email con dominio spezzato:
  // serve il focused OCR sui pixel. La repair resta evidenza/review.
  assert.deepEqual(r.emails.value, []);
  const focused = chooseFocusedEmail('christian.pezzin@scout. it', 'christian.pezzin@scout.it');
  assert.equal(focused.selected, 'christian.pezzin@scout.it');
  assert.equal(focused.changed, true);
});

test('duplicato OCR con una cifra prefissa spuria non duplica telefono internazionale', () => {
  const r = parse([
    'Asim Nayyer',
    'CEO',
    'Atrox',
    '+923338609110',
    '9923338609110',
    '+92-52-6523488',
    '+92526523499',
  ].join('\n'));
  const phones = r.phones.value ?? [];
  assert.ok(phones.some((p) => p.number.replace(/\D/g, '') === '923338609110'));
  assert.ok(!phones.some((p) => p.number.replace(/\D/g, '') === '9923338609110'));
  assert.equal(phones.length, 3);
});

test('REA non diventa indirizzo e P.O. Box non diventa postal code', () => {
  const intercasa = parse([
    'Filippo Faccin',
    'Intercasa S.r.l.u',
    'Iscr. REA n. VI-402403',
    '36015 Schio VI',
    'Via Campo Sportivo 30',
  ].join('\n'));
  assert.doesNotMatch(intercasa.address.value?.full ?? '', /REA|402403/i);
  assert.equal(intercasa.address.value?.postalCode, '36015');

  const atrox = parse([
    'Asim Nayyer',
    'Atrox',
    'P.O. Box 2671',
    'Sialkot - 51310-Pakistan',
  ].join('\n'));
  assert.equal(atrox.address.value?.postalCode, '51310');
  assert.match(atrox.address.value?.full ?? '', /P\.O\. Box 2671/i);
});

test('ruolo forte su due righe conserva la continuazione semantica', () => {
  const r = parse([
    'Markus Roithmeier',
    'Vice President',
    'Global Alliances & Channel',
    'Jedox AG',
    'markus.roithmeier@jedox.com',
    'www.jedox.com',
  ].join('\n'));
  assert.equal(r.company.value, 'Jedox AG');
  assert.equal(r.role.value, 'Vice President Global Alliances & Channel');
});

test('secondo OCR email può recuperare prefisso locale solo dai pixel', () => {
  assert.equal(isPotentialEmailRow('fabrizio.lorigiolaaderga.it'), true);
  const fused = chooseFocusedEmail('fabrizio.lorigiolaaderga.it', 'fabrizio.lorigiola@derga.it');
  assert.equal(fused.selected, 'fabrizio.lorigiola@derga.it');
  assert.equal(fused.changed, true);

  const extended = chooseFocusedEmail('demichieli@ptqs.it', 'luigi.demichieli@ptqs.it');
  assert.equal(extended.selected, 'luigi.demichieli@ptqs.it');
  assert.equal(extended.changed, true);
});
