import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';
import { finalizeRoleValue } from '../lib/parser-v5/finalize';

function page(text: string): CardPageV5 {
  const rows = text.split('\n');
  const lines = rows.map((value, index): OcrLine => ({
    text: value,
    confidence: 0.96,
    boundingBox: { x: 8, y: index * 28, width: Math.max(100, value.length * 7), height: 22 },
  }));
  return { lines, rawText: text };
}

test('V33 reale: S.A.GE.MA. conserva forma, fiscali e telefono distinti', () => {
  const result = extractCardV5([page(`DANTE CHIERICO
PERITO INDUSTRIALE
S.A.GE. MA, s. n.c.
36015 SCHIO (Vicenza) ITALY
Via Molise 12 Z.I.
Codice Fiscale 00255760241
Telefono (0445) 671155
Partita IVA 00255760241`)]);
  assert.match(result.company.value ?? '', /S\.A\.GE\.MA\.\s+S\.n\.c\./i);
  assert.equal(result.vatNumber.value, '00255760241');
  assert.equal(result.taxCode.value, '00255760241');
  assert.deepEqual(result.phones.value.map((p) => p.number.replace(/\D/g, '')), ['0445671155']);
});

test('V33 reale: plain Sede non diventa indirizzo Tel', () => {
  const result = extractCardV5([page(`ONLY TYPE
Sede: Via Roma 12, 20121 Milano MI
Tel. -
onlytype@libero.it`)]);
  assert.match(result.address.value?.full ?? '', /Via Roma(?:, Nr\.)? 12/i);
  assert.doesNotMatch(result.address.value?.full ?? '', /^Tel\.?\s*-?$/i);
});

test('V33 reale: CORIUM conserva entrambe le sedi osservate', () => {
  const result = extractCardV5([page(`CORIUM
Dott. Marco Tagliabue
Amministratore Delegato
Via Correggio, 19 - 20149 Milano Via Savoia, 78 - 00198 Roma
Tel. 0248014317
Tel. 068413222
E-mail: tagliabue@corium-srl.it`)]);
  const all = [result.address.value, ...(result.addressAlternatives ?? [])]
    .map((address) => address?.full ?? '')
    .join(' | ');
  assert.match(all, /Via Correggio/i);
  assert.match(all, /Via Savoia/i);
  assert.match(all, /00198/);
});

test('V33 reale: host email con un glifo errato viene corretto solo dal brand osservato forte', () => {
  const result = extractCardV5([page(`CORIUM
Dott. Marco Tagliabue
Amministratore Delegato
E-mail: tagliabue@eorium-srl.it`)]);
  assert.deepEqual(result.emails.value, ['tagliabue@corium-srl.it']);
  assert.ok(result.emails.score <= 0.69);
  assert.match(result.emails.reasons.join(' '), /verifica richiesta/i);
});

test('V33 open-set: brand non coerente non riscrive il dominio email', () => {
  const result = extractCardV5([page(`NEBULA
Ada Verdi
E-mail: ada@orion-srl.example`)]);
  assert.deepEqual(result.emails.value, ['ada@orion-srl.example']);
});

test('V33 reale: elimina il duplicato con cifra prefissa e conserva il + internazionale osservato', () => {
  const result = extractCardV5([page(`ATROX
Asim Nayyer
(CEO )
992-333-8609110
O+92-333-8609 110`)]);
  assert.equal(result.role.value, 'CEO');
  assert.deepEqual(result.phones.value.map((p) => p.number), ['+923338609110']);
});

test('V33 reale: Intercasa recupera la forma italiana S.r.l.u.', () => {
  const result = extractCardV5([page(`www.intercasanet.it
Intercasa s.r.l.u.
36015 Schio VI
Via Campo Sportivo 30
P.I. 02817290246
Filippo Faccin
f.faccin@intercasanet.it`)]);
  assert.match(result.company.value ?? '', /Intercasa\s+S\.r\.l\.u\./i);
  assert.equal(result.vatNumber.value, '02817290246');
});

test('V33 reale: Domofacile usa dominio osservato e normalizza la forma unipersonale', () => {
  const result = extractCardV5([page(`crzioneruolo mediator n3365C CiAA di Vicenza
Sede Legale 36040Tor dQuartesoio (Vh Via Roma 137
Domofacle sri Societa Unipersonale
www.domofacile.it
GAVASSO
dgavasso@domofacile.com
DANIELA
348.2655838`)]);
  assert.match(result.company.value ?? '', /^Domofacile\s+S\.r\.l\.\s+Societ[aà]\s+Unipersonale$/i);
  assert.equal(result.firstName.value, 'Daniela');
  assert.equal(result.lastName.value, 'Gavasso');
});

test('V33 reale: Intercasa conserva CAP, citta, forma ed email personale punteggiata', () => {
  const result = extractCardV5([page(`www.intercasanet.it
Intercasa s.r.l.u.
36015 Schio VI
Via Campo Sportivo 30
Tel 0445.512.360
P.I. 02817290246
Filippo Faccin
f.faccin@intercasanet.it`)]);
  assert.match(result.company.value ?? '', /S\.r\.l\.u\./i);
  assert.equal(result.address.value?.postalCode, '36015');
  assert.match(result.address.value?.city ?? '', /Schio/i);
  assert.ok(result.emails.value.includes('f.faccin@intercasanet.it'));
});

test('V33 open-set: la forma S.r.l.u. funziona su brand mai visto', () => {
  const result = extractCardV5([page(`NEBULA SYSTEMS s.r.l.u.
Ada Verdi
Direttrice
ada.verdi@nebulasystems.example`)]);
  assert.match(result.company.value ?? '', /Nebula Systems\s+S\.r\.l\.u\./i);
});

test('V33 ruolo: rimuove solo parentesi esterne complete', () => {
  assert.equal(finalizeRoleValue('(CEO )'), 'CEO');
  assert.equal(finalizeRoleValue('Director (EMEA)'), 'Director (EMEA)');
});
