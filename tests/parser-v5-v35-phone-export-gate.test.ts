import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { parseCardFromPages } from '../lib/parser';
import type { CardPage } from '../lib/parser-engine/pipeline';

function page(rawText: string): CardPage {
  const lines = rawText.split('\n').map((text, index): OcrLine => ({
    text,
    confidence: 0.96,
    boundingBox: {
      x: 8,
      y: index * 28,
      width: Math.max(100, text.length * 7),
      height: 22,
    },
  }));
  return { lines, rawText };
}

function parse(rawText: string) {
  return parseCardFromPages([page(rawText)]);
}

test('V35 final pipeline: attivita e professione non diventano una azienda', () => {
  const result = parse(`TURETTA GIANCARLO
Pavimenti e Rivestimenti
POSATORE
328.21.92.117
36015 SCHIO VI
via E. Gregori 7
Tel/Fax 0445.50.00.46
E-mail: interbus66@tin.it
P.l. 03011170242`);
  assert.equal(result.firstName, 'Giancarlo');
  assert.equal(result.lastName, 'Turetta');
  assert.equal(result.company, '');
});

test('V35 final pipeline: proprietario cognome-nome e brand confermato restano distinti', () => {
  const result = parse(`U86324
di Vendramin Miraldo
ACCESSORI • RICAMBI-RIPARAZIONI
Via S. M. Kolbe, 2 -36016 Thiene (VI)
Tel. 0445 386324
Cell. 377 9882916
aresthiene@libero.it
Facebook: Ares di Vendramin Miraldo`);
  assert.equal(result.firstName, 'Miraldo');
  assert.equal(result.lastName, 'Vendramin');
  assert.equal(result.company, 'Ares');
});

test('V35 final pipeline: ruolo adiacente non contamina il brand aziendale', () => {
  const result = parse(`manufacturer, Importer & Exporter
TUGIAK
TMI
MOTORBIKE IND.
m.ASHRAr TUGLAK
Managing partner
sales / marketing
www.tuglakmotorbike.com
tuglakmotorbike@gmail.com
Cell No. +92 3216150001
info@tuglakmotorbike.com
PH No.+92 52 3611780
1Km Aimanabad Road, Tuglak Street, Sialkot-51310 Pakistan.`);
  assert.match(result.company, /Tuglak.*Motorbike/i);
  assert.doesNotMatch(result.company, /sales|marketing/i);
});

test('V35 final pipeline: dominio personale corregge un singolo glifo del nome e del brand', () => {
  const result = parse(`Irtan Asghar
TTOF SIYLE
BO5 LEDERWAREN HANDELS GMBH
KRUPESTRASSE 138
F0g88 ERANKFURT,AM MAIN Germany
Tel.: 0049 69 24 24 9218
Fax: 0049 69 24 24 9220
E-MAIL: Irfan.bosmoto@gmail.com
web:www.bosmotoshop.de`);
  assert.equal(result.firstName, 'Irfan');
  assert.equal(result.lastName, 'Asghar');
  assert.match(result.company, /^BOS\b.*GmbH$/i);
});

test('V35 final pipeline: indirizzo italiano su riga successiva non perde CAP e citta', () => {
  const result = parse(`Avv. Monica Pimpinato
Via Cunizza da Romano, 27
I-36061 Bassano del Grappa (VI) Italy
Tel. +39 0424 1946622 - fax +39 0424 194 6621
cell. +39 348 958 2580
e-mail: mpimpinato@gmail.com
pec: monica.pimpinato@avvocatibassanopec.it`);
  assert.equal(result.address?.postalCode, '36061');
  assert.match(result.address?.city ?? '', /Bassano del Grappa/i);
  assert.equal(result.address?.region, 'VI');
});

test('V35 final pipeline: separa email e sito uniti dal trattino OCR', () => {
  const result = parse(`TECHNICAL TOUCH bvba
IZ Kristalpark - Ondernemersstraat 20 - 3920 Lommel (Belgium)
Tel. 0032-11-54.96.96 - Fax 0032-11-54.96.97
e-mail: info@technical-touch.com-www.technical-touch.com
BTW BE 0446.450.220 - RPR Hasselt`);
  assert.deepEqual(result.emails, ['info@technical-touch.com']);
  assert.equal(result.website, 'www.technical-touch.com');
});

test('V35 final pipeline: uffici globali scelgono il cluster coerente col recapito personale', () => {
  const result = parse(`Evanna Kearins
Director Marketing, EMEA
ekearins@jaspersoft.com
Mob +353 87 289 6579
Fax +353 1 686 5249
Jaspersoft Ltd
Digital Court
Rainsford Street
Dublin 8
Ireland
Jaspersoft Corporation
350 Rhode Island St. - Ste #250
San Francisco CA 94103 USA
Jaspersoft SARL
3 rue du Colonel Moll
75017 PARIS France
Jaspersoft GmbH
An der Welle 4
60322 Frankfurt Germany
www.jaspersoft.com`);
  assert.match(result.address?.full ?? '', /Dublin/i);
  assert.doesNotMatch(result.address?.full ?? '', /Paris/i);
});

test('V35 final pipeline: rumore isolato dopo un indirizzo completo non diventa localita', () => {
  const result = parse(`WOLFIN ENTERPRISE COMPANY LIMITED
Jennifer Lin
Tel : +886(0)4 2238 5668
General Manager
jennifer@lougawa.com
www.lougawa.com
5F-1, No. 631,Sec. 1,Chongde Rd., North Dist., Taichung City 40452, Taiwan
LOLIGNU`);
  assert.match(result.address?.full ?? '', /Taichung City 40452/i);
  assert.doesNotMatch(result.address?.full ?? '', /Lolignu/i);
});

test('V35 final pipeline: una riga ruolo corrotta non diventa una persona', () => {
  const result = parse(`Iniernational Slns Department & Trcde Department
Genu.l Manuger
KOMINE CO.,!TD.
2F, 1-38-16, Machiya, Arakawa-Ku, Tokyo, 116-0001 Japan
Tel:+81-3-5901-7770
PHONE:070-3980-8344
HP:https://www.komine.ac/ E-mail:michael@komine.ac`);
  assert.equal(result.firstName, '');
  assert.equal(result.lastName, '');
  assert.match(result.company, /^Komine Co\.,? Ltd\.?$/i);
});

test('V35 final pipeline: un dipartimento non viene accodato al nome istituzionale', () => {
  const result = parse(`School of Management
POLITECNICO DI MILANO
OSSERVATORI.NET
ICT & Management
Filippo
Renga
DIPARTIMENTO DI INGEGNERIA GESTIONALE
Via Lambruschini, 4b ed. 26B - 20156 Milano
Tel. +39 02 2399 4801
filippo.renga@polimi.it
www.som.polimi.it`);
  assert.equal(result.company, 'POLITECNICO DI MILANO');
});

test('V35 final pipeline: un prefisso telefono non puo diventare indirizzo', () => {
  const result = parse(`"Only Type"
di Balduzzo Raimondo
Sede: S.S. Pasubio,9-Costabissara (VI)
Tel. 0444 557031 - Cell. 371 4437185
onlytype@libero.it
P. IVA 02310100249 - C.F. BLDRND69A13L840W`);
  assert.match(result.address?.full ?? '', /Pasubio/i);
  assert.match(result.address?.full ?? '', /Costabissara/i);
  assert.notEqual(result.address?.full, 'Tel.');
});

test('V35 final pipeline: dominio e sito correggono il logo OCR senza hard-code', () => {
  const result = parse(`Asim Nayyer
ATAOK
(CEO)
+92-333-8609110
+92-52-6523488 / 6523499
asim@atrox.pk
www.atrox-gear.com
P.O. Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan`);
  assert.equal(result.company, 'ATROX');
});

test('V35 final pipeline: persona, azienda e numeri etichettati non si contaminano', () => {
  const result = parse(`ISIS
For Industry
AlesSIO GIullano
GartUIODICKINSon GrOupCIO
alesSIO.gILullanoOISISware.Com
Mobile 39 35S2951OW
Via E. Azzl. l - B1038 Paese (TV) ITALY
P.I. -O3527130267
Tel -39 O4224B3685
Fax39 OW2 176O595
Www.ISISware.com`);
  assert.equal(result.firstName, 'Alessio');
  assert.equal(result.lastName, 'Giullano');
  assert.equal(result.company, 'ISIS');
  assert.ok(result.emails.includes('alessio.giullano@isisware.com'));
  assert.ok(result.phones.every((phone) => !phone.number.includes('3527130267')));
});

test('V35 final pipeline: la ragione sociale osservata conserva la forma giuridica', () => {
  const result = parse(`Wise Ingegneria
e Soluzioni Software S.r.l.
Alessandro Pesenti
Software Solutions Manager
pesenti.alessandro@wiseingegneria.it
via Artigiani, 22
24060 Brusaporto (BG) Italy`);
  assert.match(result.company, /Wise Ingegneria e Soluzioni Software S\.r\.l\.$/i);
});

test('V35 final pipeline: email con separatori OCR espliciti viene recuperata dal dominio osservato', () => {
  const result = parse(`DERGA CONSULTING
Account Manager
Fabrizio Lorigiola
fabrizio.lorigiola a derga it
+39 346 4730515
Via Frischin,3 - 39100 Bolzano
www.derga.it`);
  assert.ok(result.emails.includes('fabrizio.lorigiola@derga.it'));
});

test('V35 final pipeline: Phase 2 non viene trasformato in numero civico', () => {
  const result = parse(`NAMSHI
Alessandro Nadalin
Head of Development
www.namshi.com
alex.nadalin@namshi.com
P.O.Box 500435, Unit 3219, Bldg 3, Phase 2
Emaar Gold & Diamond Park, Dubai, UAE`);
  assert.match(result.address?.full ?? '', /Phase 2/i);
  assert.doesNotMatch(result.address?.full ?? '', /Phase, Nr\. 2/i);
});

test('V35 final pipeline: parole del brand osservato non vengono fuse', () => {
  const result = parse(`Scuola Italiana Design
Giorgio Pellizzaro
Scuola Italiana Design è un dipartimento Galileo
Sede didattica: 35127 PADOVA - Z.I. Sud - Corso Stati Uniti, 14 bis
pellizzaro@scuolaitalianadesign.com
www.scuolaitalianadesign.com`);
  assert.equal(result.company, 'Scuola Italiana Design');
});

test('V35 final pipeline: azienda internazionale esplicita non resta vuota', () => {
  const result = parse(`OEKO-TEXO
G&INTERNATIONAL CO, LTD.
Overseas Sales Dept. / General Manager
Deana
82-107396 3837
Head Office / 2F, 629, Cheonho-daero, Gwangjin-gu, Seoul 04931, Korea
Web. www.gandh.co.kr
E deana@gandh.co.kr`);
  assert.match(result.company, /^G&H International Co\.,? Ltd\.?$/i);
});
