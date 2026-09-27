import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';

function line(text: string, x: number, y: number): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 700, height: 24 } };
}

function identity(lines: OcrLine[], type: 'quote' | 'order' | 'free_document' = 'quote') {
  const pages = classifyDocumentLayoutPages([{ pageIndex: 0, width: 1000, height: 1400, lines, rawText: lines.map((entry) => entry.text).join('\n') }]);
  return extractDocumentIdentity(pages, type);
}

test('emittente e cliente restano distinti', () => {
  const result = identity([
    line('Fornitore Alfa S.p.A. - P.IVA 00112233445', 40, 80),
    line('Preventivo n. P-42 Data 18/07/2026', 40, 250),
    line('Spett.le Cliente Beta S.r.l.', 40, 360),
    line('P.IVA 99887766554', 40, 410),
  ]);
  assert.equal(result.issuer?.name?.normalizedValue, 'Fornitore Alfa S.p.A.');
  assert.equal(result.customer?.name?.normalizedValue, 'Cliente Beta S.r.l.');
  assert.notEqual(result.issuer?.name?.normalizedValue, result.customer?.name?.normalizedValue);
});

test('testo esterno al foglio non diventa emittente senza identità corroborata', () => {
  const result = identity([
    line('Caraca', 40, 10),
    line('GUYAN', 300, 20),
    line('VENEZUELA', 40, 55),
    line('Spett.le Cliente Beta S.r.l.', 40, 360),
  ], 'order');
  assert.equal(result.issuer?.name, undefined);
  assert.ok(result.reasons.includes('issuer_missing_or_ambiguous'));
});

test('logo OCR con iniziale duplicata richiede conferma dal dominio del documento', () => {
  const result = identity([
    line('Caraca', 40, 10),
    line('KKÜNZI', 40, 80),
    line('Spettabile', 500, 360),
    line('Associazione Amici Trafor', 500, 400),
    line('www.kunzigroup.com', 40, 1300),
  ], 'order');
  assert.equal(result.issuer?.name?.normalizedValue, 'KÜNZI');
  assert.notEqual(result.issuer?.name?.normalizedValue, 'Caraca');
});

test('indirizzi emittente e cliente sono associati alle rispettive zone', () => {
  const result = identity([
    line('Fornitore Alfa S.p.A.', 40, 70),
    line('Via Roma 1, 20100 Milano (MI)', 40, 110),
    line('Spett.le Cliente Beta S.r.l.', 40, 360),
    line('Via Torino 2, 10100 Torino (TO)', 40, 410),
  ]);
  assert.match(result.issuer?.address?.full?.normalizedValue ?? '', /Roma/);
  assert.match(result.customer?.address?.full?.normalizedValue ?? '', /Torino/);
});

test('VAT emittente e cliente non vengono fuse', () => {
  const result = identity([
    line('Fornitore Alfa S.p.A. P.IVA 00112233445', 40, 70),
    line('Spett.le Cliente Beta S.r.l.', 40, 360),
    line('P.IVA 99887766554', 40, 410),
  ]);
  assert.equal(result.issuer?.vatNumber?.normalizedValue, '00112233445');
  assert.equal(result.customer?.vatNumber?.normalizedValue, '99887766554');
});

test('numero e data documento provengono dall header metadata', () => {
  const result = identity([line('Preventivo n. P-42 Data 18/07/2026', 40, 220)]);
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'P-42');
  assert.equal(result.metadata.issueDate?.normalizedValue, '2026-07-18');
});

test('una data nel footer normativo non diventa data documento', () => {
  const result = identity([
    line('Preventivo n. P-42', 40, 220),
    line('Regolamento approvato il 02/07/2018', 40, 1280),
  ]);
  assert.equal(result.metadata.issueDate, undefined);
});

test('una data naturale di consegna non diventa data documento', () => {
  const result = identity([
    line('Preventivo n. P-42', 40, 180),
    line('Consegna prevista 15 settembre 2026', 40, 260),
  ]);
  assert.equal(result.metadata.issueDate, undefined);
});

test('cliente senza VAT resta valido come parte ma senza valore inventato', () => {
  const result = identity([line('Spett.le Comune di Esempio', 40, 360)]);
  assert.equal(result.customer?.name?.normalizedValue, 'Comune di Esempio');
  assert.equal(result.customer?.vatNumber, undefined);
});

test('ente pubblico viene conservato come cliente', () => {
  const result = identity([line('Committente: ISTITUTO NAZIONALE DI RICERCA', 40, 360)]);
  assert.equal(result.customer?.name?.normalizedValue, 'ISTITUTO NAZIONALE DI RICERCA');
});

test('ordine esplicito prevale nel tipo documento', () => {
  const result = identity([line('Ordine n. O-77 Data 18/07/2026', 40, 220)], 'order');
  assert.equal(result.metadata.documentType?.normalizedValue, 'order');
  assert.equal(result.metadata.documentNumber?.normalizedValue, 'O-77');
});

test('documento libero conserva il tipo dichiarato senza inventare numero', () => {
  const result = identity([line('Verbale della riunione', 40, 220)], 'free_document');
  assert.equal(result.metadata.documentType?.normalizedValue, 'free_document');
  assert.equal(result.metadata.documentNumber, undefined);
});

test('IBAN resta associato all emittente', () => {
  const result = identity([
    line('Fornitore Alfa S.p.A.', 40, 70),
    line('IBAN IT60X0542811101000000123456', 40, 1100),
  ]);
  assert.equal(result.issuer?.iban?.normalizedValue, 'IT60X0542811101000000123456');
});

test('CUP CIG scadenza validita e riferimento sono separati', () => {
  const result = identity([
    line('Preventivo n. P-42 Data 18/07/2026', 40, 220),
    line('Scadenza 31/08/2026 Validita offerta 30/09/2026', 40, 260),
    line('CUP ABC12345 CIG Z123456789 Riferimento: Gara luci', 40, 300),
  ]);
  assert.equal(result.metadata.dueDate?.normalizedValue, '2026-08-31');
  assert.equal(result.metadata.validityDate?.normalizedValue, '2026-09-30');
  assert.equal(result.metadata.cup?.normalizedValue, 'ABC12345');
  assert.equal(result.metadata.cig?.normalizedValue, 'Z123456789');
  assert.deepEqual(result.metadata.references?.normalizedValue, ['Gara luci']);
});

test('destinatario e prospect mantengono il ruolo esplicito', () => {
  const recipient = identity([line('Destinatario: Magazzino Centrale', 40, 360)]);
  const prospect = identity([line('Prospect: Azienda Futuro S.r.l.', 40, 360)]);
  assert.equal(recipient.recipient?.role, 'recipient');
  assert.equal(prospect.prospect?.role, 'prospect');
});

test('una città OCR terminante in st resta osservata e non viene inventata', () => {
  const result = identity([
    line('Fornitore Alfa S.p.A.', 40, 70),
    line('Via Roma 1', 40, 110),
    line('Triest TS, 34121', 40, 145),
  ]);
  assert.equal(result.issuer?.address?.city?.normalizedValue, 'Triest');
});

test('nome cliente usa solo righe contigue prima di indirizzo o metadata', () => {
  const result = identity([
    line('Fornitore Alfa S.p.A.', 40, 70),
    line('CLIENTE:', 40, 300),
    line('ISTITUTO NAZIONALE DI RICERCA', 40, 340),
    line('DIPARTIMENTO SPERIMENTALE', 40, 375),
    line('Borgo Prova, 42/C', 40, 410),
    line('Oggetto: servizio estraneo', 40, 445),
  ]);
  assert.equal(result.customer?.name?.normalizedValue, 'ISTITUTO NAZIONALE DI RICERCA DIPARTIMENTO SPERIMENTALE');
  assert.doesNotMatch(result.customer?.name?.normalizedValue ?? '', /Oggetto|Borgo/);
});

test('coordinate multipagina restano locali alla pagina del cliente', () => {
  const pages = classifyDocumentLayoutPages([
    { pageIndex: 0, width: 1000, height: 1400, rawText: '', lines: [line('Fornitore Alfa S.p.A.', 40, 70)] },
    { pageIndex: 1, width: 1000, height: 1400, rawText: '', lines: [line('CLIENTE:', 40, 300), line('Cliente Beta S.r.l.', 40, 340), line('Via Torino 2', 40, 380), line('Descrizione Qta Prezzo Totale', 40, 500)] },
  ]);
  const result = extractDocumentIdentity(pages, 'quote');
  assert.equal(result.issuer?.name?.normalizedValue, 'Fornitore Alfa S.p.A.');
  assert.equal(result.customer?.name?.normalizedValue, 'Beta S.r.l.');
});
