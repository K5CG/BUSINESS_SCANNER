import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function card(rawText: string): CardPageV5 {
  return {
    rawText,
    lines: rawText.split('\n').map((text, index): OcrLine => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 4, y: index * 24, width: Math.max(100, text.length * 7), height: 20 },
    })),
  };
}

const digits = (value: string) => value.replace(/\D/g, '');

test('V46 batch: qualifica, brand e contatti generici non inventano una persona', () => {
  const sa = extractCardV5([card([
    'S.A. SOFTWARE srl', '36030 CALTRANC (VI)', 'Via Monte Ortigara, 15', 'P.IVA 03339340246',
    'www.sasoftware.eu', 'chiara@sasoftware.eu', 'Cell. 334 5402780', 'CHIARA ANGONESE',
    "Dott.ssa in Diritto dell'Economia", 'Sales Manager',
  ].join('\n'))]);
  assert.equal(sa.firstName.value, 'Chiara');
  assert.equal(sa.lastName.value, 'Angonese');

  const story = extractCardV5([card([
    'STORYTiME', 'In onda su RADIO', 'CANALE Italia', 'Assistenza ospiti Tel. 3519796925',
    'Via della Croce Rossa, 14 -35129 Padova', 'email: assistenzaospiti@story-time.it',
    'storytime_ufficiale', 'storytimeofficial', 'About Us Storytime Podcast',
  ].join('\n'))]);
  assert.equal(story.firstName.value, null);
  assert.equal(story.lastName.value, null);
});

test('V46 batch: un identificativo fiscale non diventa telefono', () => {
  const result = extractCardV5([card([
    'NICE TO MEET YOU', 'A Via Prà Bordoni, 67', '36010 Zanè, Vicenza',
    'T +39 0445 316000', 'F +39 0445 316090', 'P./RI 03264520242',
    'M info@fplarreda.com', 'W www.fplarreda.com',
  ].join('\n'))]);
  assert.ok((result.phones.value ?? []).every((phone) => digits(phone.number) !== '03264520242'));
});

test('V46 batch: rumore binario grafico non genera telefoni', () => {
  const result = extractCardV5([card([
    'ESOOGITO', '0010', 'D001001', '010000l', 'Filippo De Guio', 'CEO',
    'M. +39346 5012416', 'filippo.deguio@esqogito.com', 'www.esqogito.com',
    '0444 962535', 'T. 39 0444 962223', 'Esqogito S.rl.',
  ].join('\n'))]);
  const phones = (result.phones.value ?? []).map((phone) => digits(phone.number));
  assert.deepEqual(phones.sort(), ['0444962535', '390444962223', '393465012416'].sort());
});

test('V46 batch: email con TLD OCR incoerente viene riallineata solo al sito osservato', () => {
  const result = extractCardV5([card([
    'www.kblue.it', 'carlo', 'foletto', 'sales dept', '346.3984314',
    'carlo.foletto@kblue.ft', 'Kblue srl', 'Via prà bordoni, 12',
    '36010 zanè vi italy', 'tel +39 0445 315055', 'fax +39 0445 315424',
  ].join('\n'))]);
  assert.ok((result.emails.value ?? []).includes('carlo.foletto@kblue.it'));
});
