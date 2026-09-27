import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';
import { createIncludedPagesContext } from '../lib/parser-v5/included-pages-context';
import type { PageCoherenceResult } from '../lib/parser-v5/page-coherence';

function page(lines: string[]): CardPageV5 {
  return {
    rawText: lines.join('\n'),
    lines: lines.map((text, index) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 12, y: 20 + index * 28, width: Math.max(180, text.length * 8), height: 22 },
    })),
  };
}

function semanticText(result: ReturnType<typeof extractCardV5>): string {
  return JSON.stringify({
    firstName: result.firstName.value,
    lastName: result.lastName.value,
    company: result.company.value,
    role: result.role.value,
    emails: result.emails.value,
    phones: result.phones.value,
    website: result.website.value,
    address: result.address.value,
  });
}

test('V12 generic: identity observed next to role beats a conflicting person reconstructed only from email', () => {
  const result = extractCardV5([page([
    'Jennifer Lin',
    'General Manager',
    'WOLFIN ENTERPRISE CO., LTD.',
    'louga.wa@wolfin.example',
  ])]);

  assert.equal(result.firstName.value, 'Jennifer');
  assert.equal(result.lastName.value, 'Lin');
  assert.match(result.role.value ?? '', /General Manager/i);
});

test('V12 generic: owner formula resolves surname-first order without a card-specific name rule', () => {
  const result = extractCardV5([page([
    'ONLY TYPE',
    'di ROSSI MARCO',
    'onlytype@libero.it',
    'P. IVA 02310100249 - C.F. RSSMRC80A01H501Z',
    'Tel. 0445 123456',
  ])]);

  assert.equal(result.firstName.value, 'Marco');
  assert.equal(result.lastName.value, 'Rossi');
  assert.match(result.company.value ?? '', /Only Type/i);
});

test('V12 generic: professional-firm header is company and multiple offices stay separate', () => {
  const result = extractCardV5([page([
    'STUDIO',
    'LEGALE ASSOCIATO',
    'ALFA: BETA: GAMMA',
    'Avv. Mario Rossi',
    'Via Roma 10, 20100 Milano',
    'Tel. 02 111111',
    'Corso Italia 20, 10100 Torino',
    'Tel. 011 222222',
    'Piazza Europa 3, 35100 Padova',
  ])]);

  assert.match(result.company.value ?? '', /Studio Legale Associato/i);
  assert.match(result.role.value ?? '', /Avv|Avvocato/i);
  const allAddresses = [result.address.value, ...(result.addressAlternatives ?? [])].filter(Boolean);
  assert.ok(allAddresses.length >= 2, 'independent offices must not be fused into one address');
});

test('V12 generic: role line with qualification level is preserved and graphic noise is not promoted to company', () => {
  const result = extractCardV5([page([
    'Stefano Bianchi',
    'ISTRUTTORE CSEN 1° LIVELLO',
    'stefano.bianchi@ymail.com',
    'PICIES',
  ])]);

  assert.match(result.role.value ?? '', /Istruttore CSEN 1° Livello/i);
  assert.equal(result.company.value, null);
});

test('V12 generic: observed multipart surname and nearest slightly-corrupted role survive email corroboration', () => {
  const result = extractCardV5([page([
    'FABID DE VECCHI',
    'Area narketing',
    'Web & marketing',
    'Gruppovolta',
    'fabio.devecchi@gruppovolta.it',
    'www.gruppovolta.it',
  ])]);

  assert.equal(result.firstName.value, 'Fabio');
  assert.equal(result.lastName.value, 'De Vecchi');
  assert.match(result.role.value ?? '', /Area Marketing/i);
});

test('V12 generic: structural organization prefix is separated only with corroborating business domain', () => {
  const result = extractCardV5([page([
    'Fabio De Vecchi',
    'Area Marketing',
    'Gruppovolta',
    'fabio.devecchi@gruppovolta.it',
    'www.gruppovolta.it',
  ])]);

  assert.equal(result.company.value, 'Gruppo Volta');
});

test('V12 generic: strongly labeled phone and fax repair digit-like OCR glyphs without touching unlabeled prose', () => {
  const result = extractCardV5([page([
    'Jane Doe',
    'Marketing Manager',
    'T39 045 e1 O00 84',
    'F 39 045 21 O00 BS',
    'Via Leida 8, Verona',
  ])]);

  const digits = (result.phones.value ?? []).map((phone) => phone.number.replace(/\D/g, ''));
  assert.ok(digits.some((value) => value.endsWith('390452100084')));
  assert.ok(digits.some((value) => value.endsWith('390452100085')));
  assert.doesNotMatch(result.address.value?.full ?? '', /T39|F\s*39/i);
  assert.ok(result.phones.score <= 0.69, 'OCR glyph repair must not be presented as high-confidence phone data');
});

test('V12 generic: Japanese postal code is never emitted as a phone', () => {
  const result = extractCardV5([page([
    'Michael Chang',
    'General Manager',
    'KOMINE CO., LTD.',
    '2F, 1-38-16, Machiya, Arakawa-Ku, Tokyo, 116-0001 Japan',
    'Tel: +81 3 5901 7770',
  ])]);
  const digits = (result.phones.value ?? []).map((phone) => phone.number.replace(/\D/g, ''));
  assert.ok(!digits.includes('1160001'));
});

test('V12 generic: CJK address with explicit address label is retained as partial instead of disappearing', () => {
  const result = extractCardV5([page([
    'TMRC',
    'Nancy Chen',
    'General Manager',
    '地址: 中国上海市浦东新区世纪大道100号',
    'nancy@tmrc.example',
  ])]);

  assert.ok(result.address.value, 'explicitly labelled CJK address must remain available');
  assert.match(result.address.value?.full ?? '', /上海|浦东|世纪大道/u);
  assert.equal(result.address.value?.partial, true);
});

test('V12 generic: ambiguous multipage with only insufficient-link evidence may use two substantive complementary pages', () => {
  const pages = [
    page(['NAMSHI', 'Alessandro Nadalin', 'Head of Development', 'www.namshi.example']),
    page(['alex.nadalin@namshi.example', 'Tel: +971 4 123 4567', 'Dubai, UAE']),
  ];
  const allLines = pages.flatMap((p, pageIndex) => (p.lines ?? []).map((line, indexInPage) => ({
    id: pageIndex * 100 + indexInPage,
    page: pageIndex,
    indexInPage,
    text: line.text,
  })));
  const coherence: PageCoherenceResult = {
    pageMismatch: false,
    primaryPage: 1,
    activePages: [],
    reasons: ['evidenze insufficienti'],
    decision: 'ambiguous',
    includedPages: [],
    excludedPages: [],
    pendingPages: [0, 1],
    confidence: 0.4,
    decisionReasons: ['evidenze insufficienti (solo continuità logo/azienda)'],
    requiresReview: true,
  };

  const context = createIncludedPagesContext(pages, allLines, coherence);
  assert.deepEqual(context.extractionPageIndexes, [0, 1]);
  assert.match(context.extractionRawText, /Alessandro Nadalin/);
  assert.match(context.extractionRawText, /alex\.nadalin@namshi\.example/);
  assert.equal(context.requiresReview, true);
});

test('V12 generic: ambiguous multipage with conflicting identities still stays on one primary page', () => {
  const pages = [
    page(['ALPHA SRL', 'Mario Rossi', 'Sales Director']),
    page(['ALPHA SRL', 'Giulia Bianchi', 'Finance Director']),
  ];
  const allLines = pages.flatMap((p, pageIndex) => (p.lines ?? []).map((line, indexInPage) => ({
    id: pageIndex * 100 + indexInPage,
    page: pageIndex,
    indexInPage,
    text: line.text,
  })));
  const coherence: PageCoherenceResult = {
    pageMismatch: false,
    primaryPage: 0,
    activePages: [],
    reasons: ['identità personali incompatibili'],
    decision: 'ambiguous',
    includedPages: [],
    excludedPages: [],
    pendingPages: [0, 1],
    confidence: 0.3,
    decisionReasons: ['identità personali incompatibili'],
    requiresReview: true,
  };

  const context = createIncludedPagesContext(pages, allLines, coherence);
  assert.deepEqual(context.extractionPageIndexes, [0]);
  assert.doesNotMatch(context.extractionRawText, /Giulia Bianchi/);
});

// Guardrail: this file intentionally tests structural classes, not the 12 contact names as hardcoded fixes.
test('V12 generic: no structural repair may silently erase all observed semantic fields', () => {
  const result = extractCardV5([page([
    'ORBIT WORKS LTD.',
    'Mina Lane',
    'Industrial Designer',
    'mina.lane@orbitworks.example',
    'Room B7',
    '10 Sakura-dori',
    'Tokyo 100-0001',
  ])]);
  assert.match(semanticText(result), /Mina/);
  assert.match(semanticText(result), /Lane/);
  assert.match(semanticText(result), /Industrial Designer/);
});

test('V17 generic: owner formula plus fiscal evidence beats a brand accidentally parsed as identity', () => {
  const result = extractCardV5([page([
    'ONLY TYPE',
    'di BALDUZZO RAIMONDO',
    'onlytype@libero.it',
    'P. IVA 02310100249 - C.F. BLDRND69A13L840W',
    'Tel. 0444 557031',
  ])]);

  assert.equal(result.firstName.value, 'Raimondo');
  assert.equal(result.lastName.value, 'Balduzzo');
  assert.match(result.company.value ?? '', /Only Type/i);
});

test('V17 generic: PO Box/building fragment reconnects to same-page facility city and country', () => {
  const result = extractCardV5([page([
    'Alessandro Nadalin',
    'Head of Development',
    'NAMSHI',
    'M +971 55 762 7451',
    'PO.Box 500435, Unit 3219, Bldg 3, Phase 2',
    'alex.nadalin@namshi.com',
    'Emaar Gold & Diamond Park, Dubai, UAE',
    'T +971 4 870 7483',
    'www.namshi.com',
  ])]);

  assert.match(result.address.value?.full ?? '', /Phase 2/i);
  assert.match(result.address.value?.full ?? '', /Dubai/i);
  assert.match(result.address.value?.full ?? '', /UAE/i);
});


test('V18 generic: building address qualifier at edit distance one is normalized only in structured numeric context', () => {
  const card = extractCardV5([page([
    'Alex Morgan',
    'Head of Development',
    'Example Labs',
    'PO.Box 500435, Unit 3219, Bldg 3, Fhase 2',
    'Emaar Gold & Diamond Park, Dubai, UAE',
  ])]);
  const addressText = JSON.stringify(card.address.value ?? '');
  assert.match(addressText, /Phase 2/i);
  assert.match(addressText, /Dubai/i);
});


test('V20 generic: person-page explicit country locality beats an unrelated office on another page', () => {
  const front = page([
    'Elena Rossi',
    'Regional Director',
    'elena.rossi@example.com',
    'Harbour Court',
    'River Street',
    'Galway 4, Ireland',
  ]);
  const back = page([
    'Example GmbH',
    '3 rue du Centre',
    '60322 Frankfurt',
    'San Francisco CA 94103 USA',
  ]);
  const result = extractCardV5([front, back]);

  assert.equal(result.address.value?.city, 'Galway');
  assert.equal(result.address.value?.country, 'Ireland');
  assert.doesNotMatch(result.address.value?.full ?? '', /Frankfurt|San Francisco|60322/i);
});

test('V20 generic: interleaved same-page international offices do not fuse into the personal locality', () => {
  const result = extractCardV5([page([
    'Elena Rossi',
    'Regional Director',
    'elena.rossi@example.com',
    'Example Group',
    'Harbour Court',
    '350 Market Street',
    'River Street',
    'San Francisco',
    'Galway 4',
    'CA 94103',
    'Ireland',
    'USA',
    'Example GmbH',
    '3 rue du Centre',
    '60322 Frankfurt',
  ])]);

  assert.equal(result.address.value?.city, 'Galway');
  assert.equal(result.address.value?.country, 'Ireland');
  assert.doesNotMatch(result.address.value?.full ?? '', /Frankfurt|San Francisco|60322|USA/i);
});
