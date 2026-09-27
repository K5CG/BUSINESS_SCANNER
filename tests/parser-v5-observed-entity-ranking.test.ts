import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: { x: 4, y: index * 28, width: 300, height: 20 },
      })
    ),
    rawText: lines.join('\n'),
  };
}

test('una riga email corrotta non diventa azienda primaria', () => {
  const result = extractCardV5([
    page(['B-mail: annaCnorth-srl.it', 'NORTH', 'Anna Vale', 'Director']),
  ]);
  assert.doesNotMatch(result.company.value ?? '', /mail:/i);
  assert.match(result.company.value ?? '', /^North(?:\s+S\.r\.l\.)?$/i);
});

test('ragione sociale esplicita prevale su local-part e dominio email', () => {
  const result = extractCardV5([
    page(['MERIDIAN WORKS S.R.L.', 'Nora Vale', 'nora@meridian.example']),
  ]);
  assert.match(result.company.value ?? '', /Meridian Works S\.r\.l\./i);
  assert.equal(result.company.lineIds?.length, 1);
});

test('istituzione esplicita prevale sul reparto', () => {
  const result = extractCardV5([
    page(['School of Management', 'NORTH POLYTECHNIC', 'Filippo Vale', 'Researcher']),
  ]);
  assert.match(result.company.value ?? '', /^North Polytechnic$/i);
  assert.ok(result.entityAlternatives?.company.some((item) => /School of Management/i.test(item.rawValue)));
});

test('persona esplicita non viene sostituita dalla grafia del local-part', () => {
  const result = extractCardV5([
    page(['NORTH LAB', 'fabio.deverchi@north.test', 'FABIO DE VECCHI', 'Area Manager']),
  ]);
  assert.equal(result.firstName.value, 'Fabio');
  assert.equal(result.lastName.value, 'De Vecchi');
  assert.equal(result.firstName.source, 'observed');
});

test('slogan non prevale su ragione sociale osservata', () => {
  const result = extractCardV5([
    page(['INNOVATION FOR EVERYONE', 'NORTH SYSTEMS LTD.', 'Nora Vale']),
  ]);
  assert.match(result.company.value ?? '', /North Systems Ltd\./i);
});

test('riga fiscale non compete come persona o azienda', () => {
  const result = extractCardV5([
    page(['NORTH LAB S.R.L.', 'Nora Vale', 'P. IVA e CF 03481480238']),
  ]);
  assert.equal(result.firstName.value, 'Nora');
  assert.doesNotMatch(result.company.value ?? '', /03481480238/);
});

test('tra due ragioni sociali vince quella corroborata dal dominio osservato', () => {
  const result = extractCardV5([
    page([
      'G&H INTERNATIONAL CO., LTD.',
      'G&N INTERNATIONAL CO., LTD.',
      'Deana Vale',
      'deana@gandh.co.kr',
      'www.gandh.co.kr',
    ]),
  ]);
  assert.match(result.company.value ?? '', /G&H International/i);
  assert.ok(result.entityAlternatives?.company.filter((item) => /INTERNATIONAL/i.test(item.rawValue)).length === 2);
});

test('persona sul fronte e reparto sul retro restano entita distinte', () => {
  const result = extractCardV5([
    page(['NORTH UNIVERSITY', 'Nora Vale', 'nora@north.example']),
    page(['NORTH UNIVERSITY', 'Department of Engineering', 'nora@north.example']),
  ]);
  assert.equal(result.firstName.value, 'Nora');
  assert.doesNotMatch(result.company.value ?? '', /Department/i);
});

test('organizzazione Associates osservata resta candidata anche senza forma legale', () => {
  const result = extractCardV5([
    page(['Management Consultants', 'Dr. Remiglio Vale', 'Price North Associates']),
  ]);
  assert.equal(result.company.value, 'Price North Associates');
  assert.match(result.company.reasons.join(' '), /osservat/i);
});

test('logo ambiguo resta alternativa quando una istituzione esplicita e disponibile', () => {
  const result = extractCardV5([
    page(['NORTH', 'NORTH UNIVERSITY', 'Nora Vale', 'Director']),
  ]);
  assert.match(result.company.value ?? '', /^North University$/i);
  const alternatives = result.entityAlternatives?.company ?? [];
  assert.ok(alternatives.some((item) => item.evidenceType === 'logo' && !item.selected));
  assert.ok(alternatives.some((item) => item.evidenceType === 'institution' && item.selected));
});
