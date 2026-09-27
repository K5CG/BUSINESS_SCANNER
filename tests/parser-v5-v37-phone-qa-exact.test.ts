import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCardFromPages } from '../lib/parser';

function parse(rawText: string) {
  return parseCardFromPages([{
    rawText,
    lines: rawText.split('\n').map((text, index) => ({
      text,
      confidence: 0.9,
      boundingBox: { x: 10, y: index * 28, width: Math.max(120, text.length * 8), height: 22 },
    })),
  }]);
}

test('V37 QA reale: email e sito concatenati vengono separati senza perdere la email', () => {
  const result = parse(`TECHNICAL TOUCH byba
IZ Kristalpark - Ondernemersstraat 20 - 3920 Lommel (Belgium)
Tel. 0032-11-54.96.96 - Fax 0032-11-54.96.97
e-mail: info@technical-touch.com-www.technical-touch.com
BTW BE 0446.450.220 - RPR Hasselt`);
  assert.deepEqual(result.emails, ['info@technical-touch.com']);
  assert.equal(result.website, 'www.technical-touch.com');
});

test('V37 QA reale: email con a e TLD separato usa il sito esplicito come prova', () => {
  const result = parse(`DERGAE
C0N S ULTING
Account Manager
Fabrizio Lorigiola
fabrizio.lorigiola a derga it
+39 346 4730515
Via Frischin,3 - 39100 Bolzano
www.derga.it`);
  assert.ok(result.emails.includes('fabrizio.lorigiola@derga.it'), JSON.stringify(result.emails));
});

test('V37 QA reale: suffisso geografico del dominio non viene fuso nel brand', () => {
  const result = parse(`ORIUM
Roberto Manzoni
Presidente
Via Correggio, 19 - 20149 Milano
Via Savoia, 78- 00198 Roma
Tel. 0248014317
Tel. 068413222
B-mail: manzoni@corium-mi.it`);
  assert.equal(result.company, 'CORIUM');
});

test('V37 QA reale: dominio sito a un glifo viene allineato alla email osservata', () => {
  const result = parse(`Scuola ltaliana Design
Giorgio Pellizzaro
Sede didattica: 35127 PADOVA - Z.I. Sud - Corso Stati Uniti, 14 bis
pellizzaro@scuolaitalianadesign.com - www.scuolaitlianadesign.com`);
  assert.equal(result.website, 'www.scuolaitalianadesign.com');
});

test('V37 QA reale: telefono personale internazionale sceglie il paese osservato corretto', () => {
  const result = parse(`Evanna Kearins
Director Marketing, EMEA
JASPERSOFT
ekearins@jaspersoft.com
Mob
+353 87 289 6579
Fax +353 1 686 5249
Jaspersoft Ltd
Jaspersoft Corporation
Digital Court
350 Rhode lsland St. - Ste #250
Rainsford Street
San Francisco
Dublin 8
CA 94103
Ireland
USA
www.jaspersoft.com
Jaspersoft SARL
Jaspersoft GmbH
3 rue du Colonel Moll
An der Welle 4
75017 PARIS
60322 Frankfurt
France
Germany`);
  assert.equal(result.address?.city, 'Dublin', JSON.stringify(result.address));
  assert.match(result.address?.full ?? '', /Ireland/i);
  assert.doesNotMatch(result.address?.full ?? '', /Paris|France/i);
});

test('V37 QA reale: email ISIS viene ricostruita solo dal dominio esplicito osservato', () => {
  const result = parse(`ISIS
For Industry
AlesSIO GIullano
GartUIODICKINSon GrOupCIO
alesSIO.gILullanoOISISware.Com
Mobile 39 35S2951OW
Via E. Azzl. l - B1038 Paese (TV) ITALY
PL
-O3527130267
Tel
-39 O4224B3685
Fax39 OW2 176O595
Www.ISISware.com`);
  assert.ok(result.emails.includes('alessio.giullano@isisware.com'), JSON.stringify(result.emails));
  assert.ok(result.phones.every((phone) => !/3527130267/.test(phone.number)));
});
