import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, OcrLine, Phone } from '../types';
import {
  extractCardV5,
  type CardPageV5,
  type V5Field,
  type V5Result,
} from '../lib/parser-v5/engine';
import { extractBusinessCardV5 } from '../lib/parser-v5';
import { attachExtractionReviewToCard } from '../lib/extraction-review';
import {
  createIncludedPagesContext,
  pageDisposition,
  setIncludedStructuredCandidates,
} from '../lib/parser-v5/included-pages-context';
import type { PageCoherenceResult } from '../lib/parser-v5/page-coherence';

interface TestLine {
  page: number;
  text: string;
  marker?: string;
}

interface PageOptions {
  rawText?: string;
  height?: number;
  yStep?: number;
}

const PRIMARY_LINES = [
  'ALPHA ISOLATION S.R.L.',
  'Mario Rossi',
  'Direttore Commerciale',
  'mario.rossi@alpha-isolation.it',
  'www.alpha-isolation.it',
  'P.IVA 12345678901',
  'Tel: +39 02 1234 5678',
  'Via Roma 10',
  '20100 Milano (MI)',
];

const EXCLUDED_BASE_LINES = [
  'OMEGA SENTINEL S.R.L.',
  'Giulia Bianchi',
  'Chief Executive Officer',
  'giulia.bianchi@omega-sentinel.com',
  'www.omega-sentinel.com',
];

function ocrLine(
  text: string,
  index: number,
  height = 20,
  yStep = 24
): OcrLine {
  return {
    text,
    confidence: 0.95,
    boundingBox: {
      x: 4,
      y: index * yStep,
      width: Math.max(80, text.length * 7),
      height,
    },
  };
}

function cardPage(
  textLines: readonly string[],
  options: PageOptions = {}
): CardPageV5 {
  const height = options.height ?? 20;
  const yStep = options.yStep ?? 24;
  return {
    lines: textLines.map((text, index) =>
      ocrLine(text, index, height, yStep)
    ),
    rawText:
      options.rawText === undefined
        ? textLines.join('\n')
        : options.rawText,
  };
}

function allContextLines(pages: readonly CardPageV5[]): TestLine[] {
  return pages.flatMap((page, pageIndex) =>
    page.lines.map((line, lineIndex) => ({
      page: pageIndex,
      text: line.text,
      marker: `${pageIndex}:${lineIndex}`,
    }))
  );
}

function syntheticCoherence(
  decision: PageCoherenceResult['decision'],
  overrides: Partial<PageCoherenceResult> = {}
): PageCoherenceResult {
  const mismatch = decision === 'mismatch';
  const ambiguous = decision === 'ambiguous';
  const decisionReasons = ambiguous
    ? ['evidenze identita insufficienti']
    : mismatch
      ? ['domini aziendali incompatibili']
      : ['evidenze convergenti'];
  return {
    pageMismatch: mismatch,
    primaryPage: 0,
    activePages: ambiguous ? [] : [0],
    reasons: decisionReasons,
    decision,
    includedPages: ambiguous ? [] : [0],
    excludedPages: mismatch ? [1] : [],
    pendingPages: ambiguous ? [0, 1] : [],
    confidence: ambiguous ? 0.4 : mismatch ? 0.85 : 0.9,
    decisionReasons,
    requiresReview: mismatch || ambiguous,
    ...overrides,
  };
}

function fieldSnapshot<T>(field: V5Field<T>) {
  return {
    value: field.value,
    score: field.score,
    reasons: field.reasons,
    lineIds: field.lineIds,
  };
}

function semanticSnapshot(result: V5Result) {
  return {
    firstName: fieldSnapshot(result.firstName),
    lastName: fieldSnapshot(result.lastName),
    company: fieldSnapshot(result.company),
    role: fieldSnapshot(result.role),
    emails: fieldSnapshot(result.emails),
    phones: fieldSnapshot(result.phones),
    website: fieldSnapshot(result.website),
    address: fieldSnapshot(result.address),
    vatNumber: fieldSnapshot(result.vatNumber),
    taxCode: fieldSnapshot(result.taxCode),
    rawText: result.rawText,
    emailDomainOcrMismatch: result.emailDomainOcrMismatch,
  };
}

function semanticValues(result: V5Result): string {
  return JSON.stringify({
    firstName: result.firstName.value,
    lastName: result.lastName.value,
    company: result.company.value,
    role: result.role.value,
    emails: result.emails.value,
    phones: result.phones.value,
    website: result.website.value,
    address: result.address.value,
    vatNumber: result.vatNumber.value,
    taxCode: result.taxCode.value,
  }).toLowerCase();
}

function assertExcludedPageIsInert(extraLines: readonly string[]): V5Result {
  const primary = cardPage(PRIMARY_LINES);
  const excluded = cardPage([...EXCLUDED_BASE_LINES, ...extraLines]);
  const primaryOnly = extractCardV5([primary]);
  const withExcluded = extractCardV5([primary, excluded]);

  assert.equal(withExcluded.pageCoherence.decision, 'mismatch');
  assert.deepEqual(
    semanticSnapshot(withExcluded),
    semanticSnapshot(primaryOnly)
  );
  return withExcluded;
}

test('context mismatch mantiene solo pagine e righe incluse', () => {
  const pages = [
    cardPage(['PRIMARY RAW']),
    cardPage(['EXCLUDED RAW']),
    cardPage(['SECOND INCLUDED RAW']),
  ];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('mismatch', {
      activePages: [2, 0, 2, 99, -1],
      includedPages: [2, 0, 2, 99, -1],
      excludedPages: [1, 1, 2],
    })
  );

  assert.deepEqual(context.includedPageIndexes, [0, 2]);
  assert.deepEqual(context.excludedPageIndexes, [1]);
  assert.deepEqual(context.pendingPageIndexes, []);
  assert.deepEqual(
    context.includedLines.map((line) => line.marker),
    ['0:0', '2:0']
  );
  assert.equal(
    context.includedRawText,
    'PRIMARY RAW\n\nSECOND INCLUDED RAW'
  );
});

test('context usa le righe come raw fallback quando il raw incluso è vuoto', () => {
  const pages = [
    cardPage(['FALLBACK ONE', 'FALLBACK TWO'], { rawText: '' }),
  ];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('match', {
      activePages: [0],
      includedPages: [0],
      excludedPages: [],
    })
  );

  assert.equal(context.includedRawText, 'FALLBACK ONE\nFALLBACK TWO');
});

test('raw fallback è calcolato per pagina anche se un’altra pagina ha rawText', () => {
  const pages = [
    cardPage(['LINEA NON USATA'], { rawText: 'RAW PAGE ONE' }),
    cardPage(['FALLBACK PAGE TWO'], { rawText: '' }),
  ];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('match', {
      activePages: [0, 1],
      includedPages: [0, 1],
      excludedPages: [],
    })
  );

  assert.equal(
    context.includedRawText,
    'RAW PAGE ONE\n\nFALLBACK PAGE TWO'
  );
});

test('context ambiguous è fail-closed e lascia tutte le pagine pending', () => {
  const pages = [
    cardPage(['PERSONA UNO']),
    cardPage(['PERSONA DUE']),
  ];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('ambiguous', {
      activePages: [0, 1],
      includedPages: [0, 1],
      excludedPages: [1],
      pendingPages: [],
    })
  );

  assert.deepEqual(context.includedPageIndexes, []);
  assert.deepEqual(context.excludedPageIndexes, []);
  assert.deepEqual(context.pendingPageIndexes, [0, 1]);
  assert.deepEqual(context.includedLines, []);
  assert.deepEqual(context.includedPages, []);
  assert.equal(context.includedRawText, '');
  assert.equal(context.requiresReview, true);
  assert.equal(context.decision, 'ambiguous');
  assert.ok(context.decisionReasons.length > 0);
});

test('due colleghi della stessa azienda restano pending con decisione sintetica ambiguous', () => {
  const pages = [
    cardPage(['Mario Rossi', 'mario.rossi@alpha-isolation.it']),
    cardPage(['Giulia Bianchi', 'giulia.bianchi@alpha-isolation.it']),
  ];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('ambiguous')
  );

  assert.equal(context.includedRawText, '');
  assert.deepEqual(context.pendingPageIndexes, [0, 1]);
  assert.equal(pageDisposition(context, 0), 'pending');
  assert.equal(pageDisposition(context, 1), 'pending');
});

test('due freelance senza P.IVA restano pending con decisione sintetica ambiguous', () => {
  const pages = [
    cardPage(['Paolo Verdi', 'paolo.verdi@gmail.com']),
    cardPage(['Sara Neri', 'sara.neri@yahoo.com']),
  ];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('ambiguous')
  );

  assert.deepEqual(context.includedPageIndexes, []);
  assert.deepEqual(context.excludedPageIndexes, []);
  assert.deepEqual(context.pendingPageIndexes, [0, 1]);
  assert.equal(context.requiresReview, true);
});

test('context conserva copie indipendenti dei candidati strutturati inclusi', () => {
  const pages = [cardPage(PRIMARY_LINES)];
  const context = createIncludedPagesContext(
    pages,
    allContextLines(pages),
    syntheticCoherence('match', {
      activePages: [0],
      includedPages: [0],
    })
  );
  const emails = ['mario.rossi@alpha-isolation.it'];
  const phones: Phone[] = [{ number: '+39 02 1234 5678', type: 'work' }];
  const websites = ['alpha-isolation.it'];
  const vatCandidates = ['12345678901'];
  const taxCodeCandidates = ['RSSMRA80A01F205X'];

  setIncludedStructuredCandidates(context, {
    emails,
    phones,
    websites,
    vatCandidates,
    taxCodeCandidates,
  });
  emails.push('mutated@example.com');
  phones[0] = { number: 'MUTATED' };
  websites.push('mutated.example');
  vatCandidates.push('00000000000');
  taxCodeCandidates.push('MUTATED');

  assert.deepEqual(context.includedEmails, [
    'mario.rossi@alpha-isolation.it',
  ]);
  assert.deepEqual(context.includedPhones, [
    { number: '+39 02 1234 5678', type: 'work' },
  ]);
  assert.deepEqual(context.includedWebsites, ['alpha-isolation.it']);
  assert.deepEqual(context.includedVatCandidates, ['12345678901']);
  assert.deepEqual(context.includedTaxCodeCandidates, [
    'RSSMRA80A01F205X',
  ]);
});

test('due persone di aziende diverse producono mismatch senza contatto ibrido', () => {
  const result = assertExcludedPageIsInert([]);

  assert.deepEqual(result.pageCoherence.includedPageIndexes, [0]);
  assert.deepEqual(result.pageCoherence.excludedPageIndexes, [1]);
  assert.equal(result.pageCoherence.requiresReview, true);
});

const EXCLUDED_SENTINEL_CASES: Array<{
  name: string;
  lines: string[];
  forbidden: string[];
}> = [
  {
    name: 'email',
    lines: ['Email: forbidden.email@forbidden-sentinel.com'],
    forbidden: ['forbidden.email@forbidden-sentinel.com'],
  },
  {
    name: 'sito',
    lines: ['Web: www.forbidden-website-sentinel.com'],
    forbidden: ['forbidden-website-sentinel.com'],
  },
  {
    name: 'azienda',
    lines: ['FORBIDDEN COMPANY SENTINEL HOLDING S.R.L.'],
    forbidden: ['forbidden company sentinel'],
  },
  {
    name: 'persona',
    lines: ['Xylophon Sentinel', 'Responsabile Vendite'],
    forbidden: ['xylophon', 'sentinel'],
  },
  {
    name: 'telefono',
    lines: ['Mobile: +44 7700 900 555'],
    forbidden: ['7700', '900 555'],
  },
  {
    name: 'indirizzo',
    lines: ['999 Sentinel Avenue', 'London SW1A 1AA'],
    forbidden: ['999 sentinel avenue', 'sw1a'],
  },
  {
    name: 'identificativi fiscali',
    lines: [
      'P.IVA 10987654321',
      'C.F. BNCGLI80A01H501Z',
    ],
    forbidden: ['10987654321', 'bncgli80a01h501z'],
  },
];

for (const scenario of EXCLUDED_SENTINEL_CASES) {
  test(`pagina esclusa non contamina ${scenario.name}`, () => {
    const result = assertExcludedPageIsInert(scenario.lines);
    const values = semanticValues(result);
    for (const forbidden of scenario.forbidden) {
      assert.doesNotMatch(values, new RegExp(forbidden, 'i'));
    }
  });
}

test('label esplicite presenti solo nella pagina esclusa restano isolate', () => {
  const result = assertExcludedPageIsInert([
    'Nome: Explicit',
    'Cognome: Forbidden',
    'Azienda: EXPLICIT FORBIDDEN S.R.L.',
    'Ruolo: Galactic Commander',
    'Email: explicit.forbidden@forbidden-sentinel.com',
    'Web: www.forbidden-sentinel.com',
  ]);
  const values = semanticValues(result);

  assert.doesNotMatch(values, /explicit forbidden|galactic commander/i);
  assert.doesNotMatch(values, /explicit\.forbidden|forbidden-sentinel/i);
});

test('recovery da raw globale non legge marchio o persona della pagina esclusa', () => {
  const result = assertExcludedPageIsInert([
    'RECOVERYONLYBRAND',
    'Recoveryonly Person',
    'recovery.person@recoveryonlybrand.com',
    'www.recoveryonlybrand.com',
  ]);
  const values = semanticValues(result);

  assert.doesNotMatch(values, /recoveryonly|recovery\.person/i);
});

test('geometria estrema esclusa non altera ranking o confidence inclusi', () => {
  const primary = cardPage(PRIMARY_LINES);
  const primaryOnly = extractCardV5([primary]);
  const excluded = cardPage(EXCLUDED_BASE_LINES, {
    height: 4000,
    yStep: 5000,
  });
  const withExcluded = extractCardV5([primary, excluded]);

  assert.deepEqual(
    semanticSnapshot(withExcluded),
    semanticSnapshot(primaryOnly)
  );
  assert.deepEqual(
    withExcluded.debugLines
      .filter((line) => line.page === 0)
      .map(({ text, masked, fontScale, scores, pageDisposition: disposition }) => ({
        text,
        masked,
        fontScale,
        scores,
        disposition,
      })),
    primaryOnly.debugLines.map(
      ({ text, masked, fontScale, scores, pageDisposition: disposition }) => ({
        text,
        masked,
        fontScale,
        scores,
        disposition,
      })
    )
  );
});

test('raw semantico contiene solo pagine incluse', () => {
  const primary = cardPage(PRIMARY_LINES);
  const excluded = cardPage([
    ...EXCLUDED_BASE_LINES,
    'RAW_FORBIDDEN_SENTINEL',
  ]);
  const result = extractCardV5([primary, excluded]);

  assert.equal(result.rawText, primary.rawText);
  assert.doesNotMatch(result.rawText, /RAW_FORBIDDEN_SENTINEL/);
});

test('metadata mismatch registra decisione, partizione, confidence e review', () => {
  const result = extractCardV5([
    cardPage(PRIMARY_LINES),
    cardPage(EXCLUDED_BASE_LINES),
  ]);

  assert.equal(result.pageMismatch, true);
  assert.equal(result.pageCoherence.decision, 'mismatch');
  assert.equal(result.pageCoherence.primaryPage, 0);
  assert.deepEqual(result.pageCoherence.includedPageIndexes, [0]);
  assert.deepEqual(result.pageCoherence.excludedPageIndexes, [1]);
  assert.deepEqual(result.pageCoherence.pendingPageIndexes, []);
  assert.equal(result.pageCoherence.requiresReview, true);
  assert.ok(result.pageCoherence.confidence > 0);
  assert.ok(result.pageCoherence.confidence <= 1);
  assert.ok(result.pageCoherence.decisionReasons.length > 0);
});

test('debug conserva le pagine escluse solo come diagnostica', () => {
  const result = extractCardV5([
    cardPage(PRIMARY_LINES),
    cardPage([...EXCLUDED_BASE_LINES, 'DEBUG_EXCLUDED_SENTINEL']),
  ]);
  const includedDebug = result.debugLines.filter((line) => line.page === 0);
  const excludedDebug = result.debugLines.filter((line) => line.page === 1);

  assert.ok(includedDebug.length > 0);
  assert.ok(excludedDebug.length > 0);
  assert.ok(
    includedDebug.every((line) => line.pageDisposition === 'included')
  );
  assert.ok(
    excludedDebug.every((line) => line.pageDisposition === 'excluded')
  );
  assert.ok(
    excludedDebug.every(
      (line) =>
        line.fontScale === 0 &&
        line.scores.person === 0 &&
        line.scores.company === 0 &&
        line.scores.role === 0
    )
  );
  assert.ok(
    excludedDebug.some((line) =>
      line.text.includes('DEBUG_EXCLUDED_SENTINEL')
    )
  );
});

test('nessun lineId finale proviene da una pagina esclusa', () => {
  const result = extractCardV5([
    cardPage(PRIMARY_LINES),
    cardPage(EXCLUDED_BASE_LINES),
  ]);
  const pageByLineId = new Map(
    result.debugLines.map((line) => [line.id, line.page])
  );
  const fields: Array<V5Field<unknown>> = [
    result.firstName,
    result.lastName,
    result.company,
    result.role,
    result.address,
    result.vatNumber,
    result.taxCode,
  ];
  const tracedIds = fields.flatMap((field) => field.lineIds ?? []);

  assert.ok(tracedIds.length > 0);
  for (const lineId of tracedIds) {
    assert.equal(pageByLineId.get(lineId), 0);
  }
});

test('adapter extraction review propaga metadata e review mismatch', () => {
  const primary = cardPage(PRIMARY_LINES);
  const result = extractBusinessCardV5([
    primary,
    cardPage(EXCLUDED_BASE_LINES),
  ]);

  assert.equal(result.pageCoherence?.decision, 'mismatch');
  assert.deepEqual(result.pageCoherence?.includedPageIndexes, [0]);
  assert.deepEqual(result.pageCoherence?.excludedPageIndexes, [1]);
  assert.equal(result.pageCoherence?.requiresReview, true);
  assert.equal(result.needsReview, true);
  assert.ok(result.reviewFields.includes('pageMismatch'));
  assert.equal(result.rawText, primary.rawText);
});

test('applicazione review non reintroduce fallback legacy della pagina esclusa', () => {
  const primary = cardPage(PRIMARY_LINES);
  const excluded = cardPage([
    ...EXCLUDED_BASE_LINES,
    'P.IVA 10987654321',
    'Tel: +44 7700 900 555',
    '999 Sentinel Avenue, London SW1A 1AA',
  ]);
  const now = new Date('2026-07-24T12:00:00.000Z');
  const legacyHybrid: BusinessCard = {
    id: 'phase2c-review',
    type: 'business_card',
    title: 'legacy hybrid',
    images: ['front.jpg', 'foreign.jpg'],
    rawText: `${primary.rawText}\n\n${excluded.rawText}`,
    confidence: {},
    createdAt: now,
    updatedAt: now,
    firstName: 'Giulia',
    lastName: 'Bianchi',
    company: 'Omega Sentinel S.r.l.',
    role: 'Chief Executive Officer',
    emails: ['giulia.bianchi@omega-sentinel.com'],
    phones: [{ number: '+44 7700 900 555', type: 'mobile' }],
    website: 'www.omega-sentinel.com',
    address: { full: '999 Sentinel Avenue, London SW1A 1AA' },
    vatNumber: '10987654321',
  };

  const result = attachExtractionReviewToCard(legacyHybrid, [
    primary,
    excluded,
  ]);
  const values = JSON.stringify({
    title: result.title,
    firstName: result.firstName,
    lastName: result.lastName,
    company: result.company,
    role: result.role,
    emails: result.emails,
    phones: result.phones,
    website: result.website,
    address: result.address,
    vatNumber: result.vatNumber,
    taxCode: result.taxCode,
    rawText: result.rawText,
  });

  assert.equal(result.extractionReview?.pageCoherence?.decision, 'mismatch');
  assert.equal(result.rawText, primary.rawText);
  assert.doesNotMatch(
    values,
    /legacy hybrid|omega-sentinel|giulia|bianchi|chief executive|7700|sentinel avenue|10987654321/i
  );
});

test('review con solo nome incluso non recupera il cognome legacy escluso', () => {
  const primary = cardPage([
    'ALPHA ISOLATION S.R.L.',
    'Nome: Mario',
    'mario@alpha-isolation.it',
    'www.alpha-isolation.it',
    'P.IVA 12345678901',
  ]);
  const excluded = cardPage([
    'OMEGA SENTINEL S.R.L.',
    'Giulia Bianchi',
    'giulia@omega-sentinel.com',
    'P.IVA 10987654321',
  ]);
  const now = new Date('2026-07-24T12:00:00.000Z');
  const legacyHybrid: BusinessCard = {
    id: 'phase2c-partial-name',
    type: 'business_card',
    title: 'legacy hybrid',
    images: ['front.jpg', 'foreign.jpg'],
    rawText: `${primary.rawText}\n\n${excluded.rawText}`,
    confidence: {},
    createdAt: now,
    updatedAt: now,
    firstName: 'Mario',
    lastName: 'Bianchi',
    company: 'Omega Sentinel S.r.l.',
    role: '',
    emails: ['giulia.bianchi@omega-sentinel.com'],
    phones: [],
  };

  const result = attachExtractionReviewToCard(legacyHybrid, [
    primary,
    excluded,
  ]);

  assert.equal(result.extractionReview?.pageCoherence?.decision, 'mismatch');
  assert.equal(result.firstName, 'Mario');
  assert.notEqual(result.lastName, 'Bianchi');
  assert.doesNotMatch(
    JSON.stringify({
      title: result.title,
      lastName: result.lastName,
      company: result.company,
      emails: result.emails,
      rawText: result.rawText,
    }),
    /legacy hybrid|bianchi|omega-sentinel/i
  );
});

test('fronte e retro convergenti restano entrambi inclusi', () => {
  const front = cardPage([
    'ALPHA ISOLATION S.R.L.',
    'Mario Rossi',
    'mario.rossi@alpha-isolation.it',
  ]);
  const back = cardPage([
    'ALPHA ISOLATION S.R.L.',
    'www.alpha-isolation.it',
    'Tel: +39 02 1234 5678',
    'Via Roma 10, 20100 Milano (MI)',
  ]);
  const result = extractCardV5([front, back]);

  assert.equal(result.pageCoherence.decision, 'match');
  assert.deepEqual(result.pageCoherence.includedPageIndexes, [0, 1]);
  assert.deepEqual(result.pageCoherence.excludedPageIndexes, []);
  assert.deepEqual(result.pageCoherence.pendingPageIndexes, []);
  assert.equal(result.pageCoherence.requiresReview, false);
  assert.match(result.rawText, /Mario Rossi/);
  assert.match(result.rawText, /Via Roma 10/);
});

test('tre pagine mantengono il cluster coerente ed escludono la terza', () => {
  const front = cardPage(PRIMARY_LINES);
  const back = cardPage([
    'ALPHA ISOLATION S.R.L.',
    'www.alpha-isolation.it',
    'Tel: +39 02 1234 5678',
    'Sede operativa: Via Verdi 20, Milano',
  ]);
  const foreignCard = cardPage([
    ...EXCLUDED_BASE_LINES,
    'THIRD_PAGE_FORBIDDEN_SENTINEL',
  ]);
  const result = extractCardV5([front, back, foreignCard]);

  assert.equal(result.pageCoherence.decision, 'mismatch');
  assert.deepEqual(result.pageCoherence.includedPageIndexes, [0, 1]);
  assert.deepEqual(result.pageCoherence.excludedPageIndexes, [2]);
  assert.match(result.rawText, /Mario Rossi/);
  assert.match(result.rawText, /Sede operativa/);
  assert.doesNotMatch(result.rawText, /THIRD_PAGE_FORBIDDEN_SENTINEL/);
  assert.ok(
    result.debugLines
      .filter((line) => line.page === 2)
      .every((line) => line.pageDisposition === 'excluded')
  );
});

test('il parser non muta pagine, righe o bounding box originali', () => {
  const pages = [
    cardPage(PRIMARY_LINES),
    cardPage(EXCLUDED_BASE_LINES),
  ];
  const before = JSON.parse(JSON.stringify(pages));

  extractCardV5(pages);

  assert.deepEqual(pages, before);
});

test('stesso input produce risultato e diagnostica deterministici', () => {
  const pages = [
    cardPage(PRIMARY_LINES),
    cardPage(EXCLUDED_BASE_LINES),
  ];

  assert.deepEqual(extractCardV5(pages), extractCardV5(pages));
});
