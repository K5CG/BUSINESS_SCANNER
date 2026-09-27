import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function page(text: string): CardPageV5 {
  const lines = text.split('\n').map((value, index): OcrLine => ({
    text: value,
    confidence: 0.96,
    boundingBox: { x: 8, y: index * 28, width: Math.max(100, value.length * 7), height: 22 },
  }));
  return { lines, rawText: text };
}

test('V34 device exact: Only Type conserva brand, proprietario e due fiscali distinti', () => {
  const result = extractCardV5([page(`“Only Type"
di Balduzzo Raimondo
Sede: S.S. Pasubio, 9 - Costabissara (VI)
Tel. 0444 557031 - Cell. 371 4437185
onlytype@libero.it
P. IVA 02310100249 - C.F. BLDRND69A1 3L840W
CENTRO REVISIONI AUTORIZZATO
Concessionario Ufficiale Kawasaki per Vicenza e Provincia
Kawasaki`)]);
  assert.equal(result.company.value, 'Only Type');
  assert.equal(result.firstName.value, 'Raimondo');
  assert.equal(result.lastName.value, 'Balduzzo');
  assert.equal(result.vatNumber.value, '02310100249');
  assert.equal(result.taxCode.value, 'BLDRND69A13L840W');
});

test('V34 device exact: Domofacile conserva ragione sociale e indirizzo osservato', () => {
  const result = extractCardV5([page(`IL MERCATO IMMOBILIA
facile
É DOMO/acile
IL RESTOE DIFFICILE.
348.2655838
DANIELA
dgavasso@domofacile.com
GAVASSo
www.domofacile.it
Domofacle sri. Societa Unipersonale
Sede Legale 36040 Torridi Quartesolo (VD Via Roma 137
czioneniolo mediator n3365 C CiAA di Vicenza`)]);
  assert.match(result.company.value ?? '', /^Domofacile S\.r\.l\. Societ[aà] Unipersonale$/i);
  assert.equal(result.address.value?.postalCode, '36040');
  assert.match(result.address.value?.city ?? '', /Torri di Quartesolo/i);
  assert.match(result.address.value?.street ?? '', /Via Roma/i);
  assert.equal(result.address.value?.civicNumber, '137');
});

test('V34 device exact: Intercasa unisce CAP citta e via su righe consecutive', () => {
  const result = extractCardV5([page(`intercasa
f.faccin@intercasanet.it
cell_345.004,53,48
Tel_0445.51 2.360
Iscr. REAn. VI-402403
Filippo Faccin
www.intercasanet. it
Intercasa s.r.I.u.
36015_Schio_VI
Via Campo Sportivo_30
Fax_0445.512.391
P.I. 02817290246`)]);
  assert.equal(result.address.value?.postalCode, '36015');
  assert.match(result.address.value?.city ?? '', /Schio/i);
  assert.match(result.address.value?.street ?? '', /Via Campo Sportivo/i);
});

test('V34 device exact: ATROX non usa il numero della P.O. Box come CAP', () => {
  const result = extractCardV5([
    page(`Asim Nayyer
(CEO)
D+92-333-8609110
+92-52-6523488 / 6523499
asim@atrox.pk
www.atrox-gear.com`),
    page(`Inspire the Next
2 P.0. Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan
www.atrox-gear.com`),
  ]);
  assert.equal(result.address.value?.postalCode, '51310');
  assert.match(result.address.value?.full ?? '', /P\.0\. Box-2671/i);
});

test('V34 device exact: ORIUM viene riconciliato con il dominio CORIUM osservato', () => {
  const result = extractCardV5([page(`ORIUM
Roberto Manzoni
Presidente
Via Correggio, 19- 20149 Milano
Via Savoia, 78 - 00198 Roma
Tel. 0248014317
Tel. 068413222
B-mail: manzoni@corium-mi.it
arbora
Global Career Partners`)]);
  assert.match(result.company.value ?? '', /^CORIUM(?:\s+S\.r\.l\.)?$/i);
});

test('V34 device exact: ISIS recupera email e persona ma non inventa cifre OCR ambigue', () => {
  const result = extractCardV5([page(`ISIS
For Industry
AlesSID GIullano
GarbUIODICKINSon GrOUp IO
alessIO.giullanoOISISware.Com
Mobile 39 335 S2951OY
Via E. Azz. l - BI03e Paese (TV) ITALY
PL -O35271BO257
Tel
39 O4224B3685
Fax9 O422 1760595
Www.ISISware.com`)]);
  assert.equal(result.firstName.value, 'Alessio');
  assert.equal(result.lastName.value, 'Giullano');
  assert.ok(result.emails.value.includes('alessio.giullano@isisware.com'));
  assert.ok(result.phones.score < 0.9, 'recapiti con glifi OCR ambigui non possono essere alta confidenza');
  assert.ok(result.vatNumber.score < 0.9, 'una P.IVA con glifi OCR ambigui non puo essere inventata');
});

test('V34 device exact: strada OCR sospetta non puo avere confidenza alta senza conferma', () => {
  const result = extractCardV5([page(`DANTE CHIERICO
PERITO INDUSTRIALE
S. A.GE. MA, s.n.c.
36015 SCHIO (Vicenza) ITALY
Via Mollse, 12 - Z. I.
Codice Fiscale 00255760241
Telefono (0445) 671155
Partita IVA 00255760241`)]);
  assert.ok(result.address.score < 0.75, `score indirizzo ingiustificato: ${result.address.score}`);
});
