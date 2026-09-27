import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeminiDocumentExtract } from '../lib/gemini-document-extract';
import type { AiField } from '../lib/document-ai-contract';
import {
  deriveIssuerName,
  deriveSubject,
  hardenPdfExtract,
  isUnusableCompanyName,
  looksLikeLegalEntityName,
} from '../lib/pdf-party-subject';

const RAW_TEXT = [
  'Proposal AN-1002 Allegra Software Maintenance Contract Renewal',
  'Alltena GmbH - Schwalbenweg 16 - 71404 Korb',
  'CIRA SCpA',
  'Via Maiorise snc',
  '81043 Capua (CE)',
  'Italy',
  'Proposal no. AN-1002',
  'Date Feb 6, 2025',
  'Your customer no. 1021',
  'Your VAT-ID VAT 01908170614',
  'Your contact Christoph Friedrich',
  'sales@alltena.com',
  '+49 7151 123456',
  'https://alltena.com',
  'Allegra Software Maintenance for 100 Allegra Task Users',
  'Total net 3,250.00 EUR',
  'Reverse Charge 0%',
  'Total gross 3,250.00 EUR',
].join('\n');

function baseExtract(overrides: Partial<GeminiDocumentExtract> = {}): GeminiDocumentExtract {
  return {
    rawText: RAW_TEXT,
    documentNumber: 'AN-1002',
    customerName: 'CIRA SCPA',
    date: '2025-02-06',
    subtotal: 3250,
    vatAmount: 0,
    total: 3250,
    items: [{ description: 'Allegra Software Maintenance', quantity: 1, unitPrice: 3250, total: 3250 }],
    ...overrides,
  };
}

function field(value: string): AiField<string> {
  return {
    value,
    pageIndex: 0,
    evidenceText: value,
    confidenceType: 'heuristic',
    requiresReview: false,
    alternatives: [],
  };
}

test('riconosce le forme societarie senza elencare aziende', () => {
  assert.equal(looksLikeLegalEntityName('Alltena GmbH'), true);
  assert.equal(looksLikeLegalEntityName('CIRA SCpA'), true);
  assert.equal(looksLikeLegalEntityName('Rossi S.r.l.'), true);
  assert.equal(looksLikeLegalEntityName('Acme Ltd'), true);
  assert.equal(looksLikeLegalEntityName('Schwalbenweg 16'), false);
  assert.equal(looksLikeLegalEntityName('Christoph Friedrich'), false);
});

test('recapiti ed etichette non sono nomi di azienda', () => {
  assert.equal(isUnusableCompanyName('sales@alltena.com'), true);
  assert.equal(isUnusableCompanyName('+49 7151 123456'), true);
  assert.equal(isUnusableCompanyName('https://alltena.com'), true);
  assert.equal(isUnusableCompanyName('Email'), true);
  assert.equal(isUnusableCompanyName('Managing Director'), true);
  assert.equal(isUnusableCompanyName('Alltena GmbH'), false);
});

test('l emittente viene dalla carta intestata, non dai contatti', () => {
  const issuer = deriveIssuerName(RAW_TEXT, 'CIRA SCPA');
  assert.equal(issuer, 'Alltena GmbH');
});

test('l oggetto nasce dal titolo senza tipo documento e numero', () => {
  assert.equal(
    deriveSubject(RAW_TEXT, { documentNumber: 'AN-1002', issuerName: 'Alltena GmbH', customerName: 'CIRA SCPA' }),
    'Allegra Software Maintenance Contract Renewal'
  );
});

test('un oggetto esplicito ha la precedenza sul titolo', () => {
  const rawText = ['Offerta 2025/0042', 'Oggetto: Fornitura arredi per uffici', 'Totale 1.000,00'].join('\n');
  assert.equal(deriveSubject(rawText, { documentNumber: '2025/0042' }), 'Fornitura arredi per uffici');
});

test('etichette in altre lingue introducono l oggetto', () => {
  const betreff = ['Angebot AN-7', 'Betreff: Wartungsvertrag Verlängerung', 'Summe 100,00'].join('\n');
  assert.equal(deriveSubject(betreff, { documentNumber: 'AN-7' }), 'Wartungsvertrag Verlängerung');
  const objet = ['Devis D-9', 'Objet : Contrat de maintenance annuel', 'Total 100,00'].join('\n');
  assert.equal(deriveSubject(objet, { documentNumber: 'D-9' }), 'Contrat de maintenance annuel');
});

test('l indirizzo dell emittente non diventa mai l oggetto', () => {
  const rawText = [
    'Alltena GmbH - Schwalbenweg 16 - 71404 Korb',
    'CIRA SCpA',
    'Via Maiorise snc',
    'Proposal no. AN-1002',
  ].join('\n');
  assert.equal(
    deriveSubject(rawText, { documentNumber: 'AN-1002', issuerName: 'Alltena GmbH' }),
    undefined
  );
});

test('il nome delle parti non diventa l oggetto', () => {
  const rawText = ['Preventivo 2025/1 Alltena GmbH', 'Totale 10,00'].join('\n');
  assert.equal(
    deriveSubject(rawText, { documentNumber: '2025/1', issuerName: 'Alltena GmbH' }),
    undefined
  );
});

test('recapiti e dati fiscali non diventano l oggetto', () => {
  const rawText = [
    'Offerta 2025/3 sales@alltena.com',
    'Offerta 2025/3 VAT ID IT01908170614',
    'Totale 10,00',
  ].join('\n');
  assert.equal(deriveSubject(rawText, { documentNumber: '2025/3' }), undefined);
});

test('la riga più lunga non vince sul titolo del documento', () => {
  const rawText = [
    'Preventivo PR-5 Manutenzione impianti elettrici',
    'Idee Business Srl - Via Giuseppe Garibaldi 128 - 20099 Sesto San Giovanni',
    'Totale 10,00',
  ].join('\n');
  assert.equal(
    deriveSubject(rawText, { documentNumber: 'PR-5', issuerName: 'Idee Business Srl' }),
    'Manutenzione impianti elettrici'
  );
});

test('senza evidenza chiara l oggetto resta vuoto', () => {
  const rawText = ['Fattura', 'n. 12', '01/2025', 'Totale 10,00'].join('\n');
  assert.equal(deriveSubject(rawText, { documentNumber: '12' }), undefined);
});

test('AN-1002: emittente, cliente e oggetto sono corretti e i campi buoni restano', () => {
  const hardened = hardenPdfExtract(baseExtract());
  const structured = hardened.structured;

  assert.equal(structured?.issuer?.name?.value, 'Alltena GmbH');
  assert.notEqual(structured?.issuer?.name?.value, 'sales@alltena.com');
  assert.notEqual(structured?.issuer?.name?.value, 'Christoph Friedrich');
  assert.notEqual(structured?.issuer?.name?.value, '+49 7151 123456');
  assert.notEqual(structured?.issuer?.name?.value, 'https://alltena.com');
  assert.equal(structured?.customer?.name?.value, 'CIRA SCPA');
  assert.notEqual(structured?.issuer?.name?.value, structured?.customer?.name?.value);
  assert.equal(structured?.document.subject?.value, 'Allegra Software Maintenance Contract Renewal');

  assert.equal(hardened.documentNumber, 'AN-1002');
  assert.equal(hardened.items?.length, 1);
  assert.equal(hardened.subtotal, 3250);
  assert.equal(hardened.vatAmount, 0);
  assert.equal(hardened.total, 3250);
  assert.equal(hardened.date, '2025-02-06');
});

test('un emittente valido del servizio AI non viene sostituito', () => {
  const hardened = hardenPdfExtract(baseExtract({
    structured: {
      schemaVersion: 2,
      document: {},
      items: [],
      summary: {},
      conditions: {},
      conflicts: [],
      requiresReview: false,
      issuer: { name: field('Alltena Software GmbH') },
    },
  }));
  assert.equal(hardened.structured?.issuer?.name?.value, 'Alltena Software GmbH');
});

test('un emittente che è un recapito viene sostituito dalla ragione sociale', () => {
  const hardened = hardenPdfExtract(baseExtract({
    structured: {
      schemaVersion: 2,
      document: {},
      items: [],
      summary: {},
      conditions: {},
      conflicts: [],
      requiresReview: false,
      issuer: { name: field('sales@alltena.com') },
    },
  }));
  assert.equal(hardened.structured?.issuer?.name?.value, 'Alltena GmbH');
});

test('senza testo non viene inventato nulla', () => {
  const hardened = hardenPdfExtract({ rawText: '   ' });
  assert.equal(hardened.structured, undefined);
});
