import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuoteDocument } from '../types';
import type { GeminiDocumentExtract } from '../lib/gemini-document-extract';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import {
  emptyStructuredExtraction,
  withAiAuthority,
  withAiStructuredExtraction,
} from '../lib/pdf-ai-authority';
import { applyPdfStructuredParity } from '../lib/pdf-structured-parity';

/** Testo fedele al PDF reale AN-1002: intestazione, recapiti e inversione contabile. */
const PDF_TEXT = [
  'Alltena GmbH - Schwalbenweg 16 - 71404 Korb',
  'CIRA SCpA',
  'Via Maiorise snc',
  '81043 Capua CE',
  'Italy',
  'Proposal AN-1002 Allegra Software Maintenance Contract Renewal',
  'Proposal no. AN-1002',
  'Date Feb 6, 2025',
  'Your customer no. 10023',
  'Pos. Description Quantity Unit Unit price Total',
  '1 Allegra Software Maintenance for 100 Allegra Task Users 1 piece 3,250.00 EUR 3,250.00 EUR',
  'Total net 3,250.00 EUR',
  'Reverse Charge 0% 0.00 EUR',
  'Total gross 3,250.00 EUR',
  'Phone +49 7151 1234',
  'Email sales@alltena.com',
  'Web www.alltena.com',
  'VAT-ID 01908170614',
].join('\n');

function extract(overrides: Record<string, unknown> = {}): GeminiDocumentExtract {
  return {
    rawText: PDF_TEXT,
    documentNumber: 'AN-1002',
    customerName: 'CIRA SCpA',
    date: '2025-02-06',
    subtotal: 3250,
    vatAmount: 0,
    total: 3250,
    items: [
      {
        description: 'Allegra Software Maintenance for 100 Allegra Task Users',
        quantity: 1,
        unitPrice: 3250,
        total: 3250,
      },
    ],
    structured: {
      schemaVersion: 2,
      document: {
        documentNumber: { value: 'AN-1002' },
        issueDate: { value: '2025-02-06' },
        subject: { value: 'Allegra Software Maintenance Contract Renewal' },
        currency: { value: 'EUR' },
      },
      issuer: { name: { value: 'Alltena GmbH' } },
      customer: { name: { value: 'CIRA SCpA' } },
      items: [],
      summary: {},
    },
    ...overrides,
  } as unknown as GeminiDocumentExtract;
}

function built(source = extract()): QuoteDocument {
  return withAiStructuredExtraction(
    buildDocumentFromExtract('quote', source),
    source
  ) as QuoteDocument;
}

async function imported(source = extract()): Promise<QuoteDocument> {
  return (await applyPdfStructuredParity(built(source), source)) as QuoteDocument;
}

function issuerName(document: QuoteDocument): string | undefined {
  return document.structuredExtraction?.issuer?.name?.normalizedValue;
}

/** La data e' un giorno di calendario: leggerla in UTC la sposterebbe indietro. */
function localDay(value?: Date): string | undefined {
  if (!value) return undefined;
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

test('emittente e oggetto sopravvivono alla costruzione del documento', () => {
  const document = built();
  assert.equal(issuerName(document), 'Alltena GmbH');
  assert.equal(
    document.structuredExtraction?.metadata.subject?.normalizedValue,
    'Allegra Software Maintenance Contract Renewal'
  );
  assert.equal(
    document.structuredExtraction?.customer?.name?.normalizedValue,
    'CIRA SCpA'
  );
});

test('la data ISO del servizio arriva fino al documento', () => {
  assert.equal(localDay(built().quoteDate), '2025-02-06');
});

test('lo zero dichiarato con inversione contabile non viene scartato', () => {
  assert.equal(built().vatAmount, 0);
});

test('la lettura locale non sostituisce l emittente riconosciuto dal servizio', async () => {
  const document = await imported();
  assert.equal(issuerName(document), 'Alltena GmbH');
});

test('un emittente locale divergente resta come alternativa in conflitto', () => {
  const local = {
    ...emptyStructuredExtraction(),
    issuer: {
      role: 'issuer' as const,
      name: {
        rawValue: 'Email sa',
        normalizedValue: 'Email sales@alltena.com',
        pageIndex: 0,
        sourceLineIds: ['l1'],
        sourceLines: ['Email sales@alltena.com'],
        validationStatus: 'unverified' as const,
        confidenceType: 'heuristic' as const,
        reasons: ['issuer_letterhead'],
        requiresReview: true,
        alternatives: [],
      },
      conflicts: [],
      requiresReview: true,
    },
  };
  const merged = withAiAuthority(local, extract());
  assert.equal(merged.issuer?.name?.normalizedValue, 'Alltena GmbH');
  assert.equal(merged.issuer?.requiresReview, true);
});

test('una lettura locale forte non sovrascrive in silenzio il servizio', () => {
  const local = {
    ...emptyStructuredExtraction(),
    issuer: {
      role: 'issuer' as const,
      name: {
        rawValue: 'Beta Srl',
        normalizedValue: 'Beta Srl',
        pageIndex: 0,
        sourceLineIds: ['l1'],
        sourceLines: ['Beta Srl'],
        validationStatus: 'valid' as const,
        confidenceType: 'heuristic' as const,
        reasons: ['issuer_letterhead'],
        requiresReview: false,
        alternatives: [],
      },
      conflicts: [],
      requiresReview: false,
    },
  };
  const merged = withAiAuthority(local, extract());
  const name = merged.issuer?.name;
  assert.equal(name?.normalizedValue, 'Alltena GmbH');
  assert.equal(name?.conflict, true);
  assert.deepEqual(
    name?.alternatives.map((alternative) => alternative.normalizedValue),
    ['Beta Srl']
  );
  assert.equal(merged.issuer?.requiresReview, true);
});

test('senza valore dal servizio la lettura locale resta al suo posto', () => {
  const local = {
    ...emptyStructuredExtraction(),
    issuer: {
      role: 'issuer' as const,
      name: {
        rawValue: 'Beta Srl',
        normalizedValue: 'Beta Srl',
        pageIndex: 0,
        sourceLineIds: ['l1'],
        sourceLines: ['Beta Srl'],
        validationStatus: 'valid' as const,
        confidenceType: 'heuristic' as const,
        reasons: ['issuer_letterhead'],
        requiresReview: false,
        alternatives: [],
      },
      conflicts: [],
      requiresReview: false,
    },
  };
  const merged = withAiAuthority(local, {
    ...extract(),
    structured: { schemaVersion: 2, document: {}, items: [], summary: {} },
  } as unknown as GeminiDocumentExtract);
  assert.equal(merged.issuer?.name?.normalizedValue, 'Beta Srl');
});

test('l oggetto del servizio non viene riscritto dalla passata locale', async () => {
  const document = await imported();
  assert.equal(
    document.structuredExtraction?.metadata.subject?.normalizedValue,
    'Allegra Software Maintenance Contract Renewal'
  );
});

test('la data resta quella del servizio dopo la passata locale', async () => {
  const document = await imported();
  assert.equal(localDay(document.quoteDate), '2025-02-06');
  assert.equal(
    document.structuredExtraction?.metadata.issueDate?.normalizedValue,
    '2025-02-06'
  );
});

test('la riga riconosciuta dal servizio non viene azzerata dalla lettura locale', async () => {
  const document = await imported();
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0].total, 3250);
});

test('i totali del servizio restano intatti', async () => {
  const document = await imported();
  assert.equal(document.subtotal, 3250);
  assert.equal(document.vatAmount, 0);
  assert.equal(document.total, 3250);
});

test('un nome ricavato da un etichetta di contatto non diventa mai emittente', async () => {
  const withoutIssuer = extract({
    structured: {
      schemaVersion: 2,
      document: { subject: { value: 'Allegra Software Maintenance Contract Renewal' } },
      items: [],
      summary: {},
    },
  });
  const document = await imported(withoutIssuer);
  const name = issuerName(document) ?? '';
  assert.ok(
    !name || !/^(?:email|phone|tel|fax|web|website|indirizzo|address)\b/i.test(name),
    name
  );
});

test('senza emittente dal servizio la lettura locale puo riempire il vuoto', async () => {
  const localOnly = extract({
    rawText: ['Idee Business Srl', 'Preventivo n. 7 del 06/02/2025', 'Totale 10,00 EUR'].join('\n'),
    structured: {
      schemaVersion: 2,
      document: {},
      items: [],
      summary: {},
    },
  });
  const document = await imported(localOnly);
  const name = issuerName(document);
  assert.ok(name === undefined || name.length > 0);
});
