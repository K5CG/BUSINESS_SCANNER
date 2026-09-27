import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, OcrQualityMetadata } from '../types';
import {
  applyBusinessCardReocrProposal,
  buildBusinessCardReocrProposal,
} from '../lib/contact-reparse';
import { initializeParsedContactReviewState } from '../lib/contact-review-state';
import { parseCardFromPages } from '../lib/parser';

const QUALITY: OcrQualityMetadata = {
  heuristicQuality: 0.9,
  confidenceType: 'heuristic',
  qualityReasons: [],
  requiresReview: false,
};

function previousCard(overrides: Partial<BusinessCard>): BusinessCard {
  return initializeParsedContactReviewState({
    id: `v36-truth-${Math.random()}`,
    type: 'business_card',
    title: 'stato precedente errato',
    images: ['scan://front'],
    rawText: 'OLD OCR',
    confidence: {
      firstName: 0.99,
      lastName: 0.99,
      company: 0.99,
      role: 0.99,
      emails: 0.99,
      phones: 0.99,
      website: 0.99,
      address: 0.99,
    },
    createdAt: new Date('2026-09-17T08:00:00.000Z'),
    updatedAt: new Date('2026-09-17T08:00:00.000Z'),
    firstName: '',
    lastName: '',
    role: '',
    company: '',
    emails: [],
    phones: [],
    ...overrides,
  });
}

async function freshCandidate(previous: BusinessCard, rawText: string) {
  const lines = rawText.split('\n').map((text, index) => ({
    text,
    confidence: 0.96,
    boundingBox: {
      x: 8,
      y: index * 28,
      width: Math.max(100, text.length * 7),
      height: 22,
    },
  }));
  const result = await buildBusinessCardReocrProposal(previous, {
    resolveImage: (uri) => uri,
    scanImage: async () => ({
      text: rawText,
      lines,
      quality: QUALITY,
    }),
  });
  assert.equal(result.status, 'ready');
  assert.ok(result.proposal);
  return result.proposal.candidate;
}

async function freshCandidatePages(previous: BusinessCard, pageTexts: string[]) {
  const scans = new Map(pageTexts.map((text, index) => [
    `scan://page-${index}`,
    {
      text,
      lines: text.split('\n').map((line, lineIndex) => ({
        text: line,
        confidence: 0.96,
        boundingBox: { x: 8, y: lineIndex * 28, width: Math.max(100, line.length * 7), height: 22 },
      })),
      quality: QUALITY,
    },
  ]));
  const result = await buildBusinessCardReocrProposal(
    { ...previous, images: pageTexts.map((_, index) => `scan://page-${index}`) },
    {
      resolveImage: (uri) => uri,
      scanImage: async (uri) => scans.get(uri)!,
    },
  );
  assert.equal(result.status, 'ready');
  assert.ok(result.proposal);
  return result.proposal.candidate;
}

test('V36 truth gate: il vero ri-OCR non ripristina nome errato precedente', async () => {
  const candidate = await freshCandidate(
    previousCard({
      firstName: 'Irtan',
      lastName: 'Asghar',
      company: 'BOS Lederwaren Handels GmbH',
      emails: ['irfan.bosmoto@gmail.com'],
    }),
    `Irtan Asghar
TTOF SIYLE
BO5 LEDERWAREN HANDELS GMBH
KRUPESTRASSE 138
F0g88 ERANKFURT,AM MAIN Gemany
Tel.: 0049 69 24 24 9218
Fax: 0049 69 24 24 9220
E-MAIL: Irfan.bosmoto@gmail.com
web:www.bosmotoshop.de`
  );
  assert.equal(candidate.firstName, 'Irfan');
  assert.equal(candidate.lastName, 'Asghar');
});

test('V36 truth gate: email e sito nuovi non vengono contaminati dalla vecchia email', async () => {
  const rawText = `TECHNICAL TOUCH bvba
IZ Kristalpark - Ondernemersstraat 20 - 3920 Lommel (Belgium)
Tel. 0032-11-54.96.96 - Fax 0032-11-54.96.97
e-mail: info@technical-touch.com-www.technical-touch.com
BTW BE 0446.450.220 - RPR Hasselt`;
  const directLines = rawText.split('\n').map((text, index) => ({
    text,
    confidence: 0.96,
    boundingBox: { x: 8, y: index * 28, width: Math.max(100, text.length * 7), height: 22 },
  }));
  const direct = parseCardFromPages([{ rawText, lines: directLines }]);
  assert.deepEqual(direct.emails, ['info@technical-touch.com']);
  const candidate = await freshCandidate(
    previousCard({
      company: 'TECHNICAL TOUCH BVBA',
      emails: ['info@technical-touch.com-www.technical-touch.com'],
    }),
    rawText
  );
  assert.deepEqual(
    candidate.emails,
    ['info@technical-touch.com'],
    JSON.stringify(candidate.emailEvidence)
  );
  assert.equal(candidate.website, 'www.technical-touch.com');
  assert.match(candidate.address?.full ?? '', /Ondernemersstraat 20/i);
});

test('V38 ri-OCR: suffisso geografico del dominio non viene incollato al brand', async () => {
  const corium = await freshCandidate(
    previousCard({
      firstName: 'Roberto',
      lastName: 'Manzoni',
      company: 'CORIUMMI',
      emails: ['manzoni@corium-mi.it'],
    }),
    `ORIUM
Roberto Manzoni
Presidente
Via Correggio, 19 - 20149 Milano
Via Savoia, 78- 00198 Roma
Tel. 0248014317
Tel. 068413222
B-mail: manzoni@corium-mi.it`
  );
  assert.equal(corium.company, 'CORIUM');
});

test('V38 ri-OCR: civico estratto resta anche nell indirizzo visualizzato', async () => {
  const intercasa = await freshCandidate(
    previousCard({ firstName: 'Filippo', lastName: 'Faccin', company: 'Intercasa S.r.l.u.' }),
    `Filippo Faccin
f.faccin@intercasanet.it
Intercasa s.r.l.u.
36015 Schio VI
Via Campo Sportivo_30
P.I. 0 2817290246`
  );
  assert.equal(intercasa.address?.civicNumber, '30');
  assert.match(intercasa.address?.full ?? '', /Campo Sportivo, Nr\. 30/i);
});

test('V40 ri-OCR: email fuse reali restano recuperabili dal dominio osservato', async () => {
  const derga = await freshCandidate(
    previousCard({ company: 'DERGA Consulting' }),
    `DERGAE
CONSULTING
Fabrizio Lorigiola
fabrizio.lorigiola a derga it
www.derga.it`
  );
  assert.ok(derga.emails.includes('fabrizio.lorigiola@derga.it'));

  const isis = await freshCandidate(
    previousCard({ company: 'ISIS' }),
    `ISIS
AlesSIO GIullano
alesSIO.gILullanoOISISware.Com
Www.ISISware.com`
  );
  assert.ok(isis.emails.includes('alessio.giullano@isisware.com'));
});

test('V40 ri-OCR: il risultato applicato conserva il civico in address.full', async () => {
  const card = previousCard({
    firstName: 'Filippo',
    lastName: 'Faccin',
    company: 'Intercasa S.r.l.u.',
    address: {
      street: 'Via Campo Sportivo',
      civicNumber: '30',
      postalCode: '36015',
      city: 'Schio',
      region: 'VI',
      country: 'IT',
      full: 'Via Campo Sportivo - 36015 - Schio - (VI) - IT',
    },
  });
  const rawText = `Filippo Faccin
Intercasa s.r.l.u.
36015 Schio VI
Via Campo Sportivo_30`;
  const lines = rawText.split('\n').map((text, index) => ({
    text,
    confidence: 0.96,
    boundingBox: { x: 8, y: index * 28, width: 200, height: 22 },
  }));
  const reocr = await buildBusinessCardReocrProposal(card, {
    resolveImage: (uri) => uri,
    scanImage: async () => ({ text: rawText, lines, quality: QUALITY }),
  });
  assert.equal(reocr.status, 'ready');
  assert.ok(reocr.proposal);
  const applied = applyBusinessCardReocrProposal(
    card,
    reocr,
    reocr.proposal.fields.map((field) => field.field)
  );
  assert.match(applied.appliedResult.address?.full ?? '', /Campo Sportivo, Nr\. 30/i);
});

test('V36 truth gate: uffici globali non conservano il vecchio indirizzo fuso', async () => {
  const candidate = await freshCandidate(
    previousCard({
      firstName: 'Evanna',
      lastName: 'Kearins',
      company: 'Jaspersoft Ltd',
      address: {
        full: '3 rue du Colonel Moll, 75017 PARIS, 60322 Frankfurt, France, Germany',
      },
    }),
    `Evanna Kearins
Director Marketing, EMEA
ekearins@jaspersoft.com
Mob +353 87 289 6579
Fax +353 1 686 5249
Jaspersoft Ltd
Jaspersoft Corporation
Digital Court
350 Rhode Island St. - Ste #250
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
Germany`
  );
  assert.match(candidate.address?.full ?? '', /Dublin/i);
  assert.doesNotMatch(candidate.address?.full ?? '', /Paris|Frankfurt/i);
});

test('V36 truth gate: il nuovo OCR puo completare citta, email e brand persi', async () => {
  const monica = await freshCandidate(
    previousCard({ firstName: 'Monica', lastName: 'Pimpinato' }),
    `Avv. Monica Pimpinato
Via Cunizza da Romano, 27
1-36061 Bassano del Grappa (VI) Italy
Tel. +39 0424 1946622- fax +39 0424 194 6621
cell. +39 348 958 2580
e-mail: mpimpinato@gmail.com
pec: monica.pimpinato@avvocatibassanopec.it`
  );
  assert.equal(
    monica.address?.city,
    'Bassano del Grappa',
    JSON.stringify(monica.address)
  );

  const derga = await freshCandidate(
    previousCard({
      firstName: 'Fabrizio',
      lastName: 'Lorigiola',
      company: 'DERGA Consulting',
    }),
    `DERGAE
CONSULTING
Account Manager
Fabrizio Lorigiola
fabrizio.lorigiola a derga it
+39 346 4730515
Via Frischin,3 - 39100 Bolzano
www.derga.it`
  );
  assert.ok(derga.emails.includes('fabrizio.lorigiola@derga.it'));

  const school = await freshCandidate(
    previousCard({
      firstName: 'Giorgio',
      lastName: 'Pellizzaro',
      company: 'Scuolaitlianadesign',
    }),
    `Scuola ltaliana Design
Giorgio Pellizzaro
Scuola ltaliana Design è un dipartimento Galileo
Sede didattica: 35127 PADOVA - Z.I. Sud - Corso Stati Uniti, 14 bis
pellizzaro@scuolaitalianadesign.com - www.scuolaitlianadesign.com`
  );
  assert.equal(school.company, 'Scuola Italiana Design');
});

test('V36 truth gate: Unit, Phase e District non diventano CAP, civico o citta', async () => {
  const namshi = await freshCandidate(
    previousCard({ firstName: 'Alessandro', lastName: 'Nadalin', company: 'Namshi' }),
    `NAMSHI
Alessandro Nadalin
Head of Development
www.namshi.com
T +971 4 870 7483
Emaar Gold & Diamond Park, Dubai, UAE
alex.nadalin@namshi.com
P.O.Box 500435, Unit 3219, Bldg 3, Phase 2
M +971 55 762 7451`
  );
  assert.equal(namshi.address?.postalCode, undefined);
  assert.equal(namshi.address?.civicNumber, undefined);
  assert.equal(namshi.address?.city, 'Dubai');

  const wolfin = await freshCandidate(
    previousCard({ firstName: 'Jennifer', lastName: 'Lin', company: 'Wolfin Enterprise Company LIMITED' }),
    `WOLFIN ENTERPRISE COMPANY LIMITED
Jennifer Lin
General Manager
jennifer@lougawa.com
+886(0)931 646 048
www.lougawa.com
5F-1, No. 631,Sec. 1,Chongde Rd., North Dist., Taichung City 40452, Taiwan
LOLIGNU`
  );
  assert.equal(wolfin.address?.city, 'Taichung City');
});

test('V36 truth gate: localita italiana prima del CAP e ruolo professionale restano strutturati', async () => {
  const exhaust = await freshCandidate(
    previousCard({ firstName: 'Luca', lastName: 'Moscatelli', company: 'Exhaust System' }),
    `www.Imexhaustsystem.it
info@Imexhaustsystem.it
EXHAUST SYSTEM
Via vergoli 1 bibbiano (RE)42021 ITALIA
MOSCATELLI LUCA
09-3484046806
PARTI SPECIALI RACING`
  );
  assert.equal(exhaust.address?.city, 'Bibbiano');
  assert.equal(exhaust.address?.postalCode, '42021');

  const turetta = await freshCandidate(
    previousCard({ firstName: 'Giancarlo', lastName: 'Turetta' }),
    `TURETTA GIANCARLO
Pavimenti e Rivestimenti
POSATORE
328.21.92.117
36015 SCHIO VI
via E. Gregori 7
Tel/Fax 0445.50.00.46
E-mail: interbus66@tin.it
P.l. 03011170242`
  );
  assert.equal(turetta.role.toUpperCase(), 'POSATORE');
  assert.equal(turetta.address?.city, 'Schio');
});

test('V36 truth gate: un dominio aziendale valido puo colmare il sito non letto', async () => {
  const sun = await freshCandidate(
    previousCard({ firstName: 'Lorena', lastName: 'Cervo', company: 'Immobiliare SUN House srl' }),
    `RRETECASA
MALO
Lorena Cervo
Responsabile Ufficio
AFFILIATO
IMMOBILIARE SUN HOUSE srl
36034 MALO (VI) - Piazza Marconi, 14
Tel. 0445 581310 - P. IVA 02888100241
e-mail: malo@retecasa.it`
  );
  assert.equal(sun.website, 'www.retecasa.it');
});

test('V36 truth gate: righe fiscali corrotte non diventano telefoni', async () => {
  const isis = await freshCandidate(
    previousCard({ firstName: 'Alessio', lastName: 'Giullano', company: 'ISIS' }),
    `ISIS
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
Www.ISISware.com`
  );
  assert.ok(
    isis.phones.every((phone) => !phone.number.includes('3527130267')),
    JSON.stringify({ phones: isis.phones, vatNumber: isis.vatNumber })
  );
  assert.equal(isis.vatNumber, undefined);
});

test('V41 phone QA: sito raw esplicito recupera email anche se il layout lo perde', async () => {
  const technical = await freshCandidate(
    previousCard({ company: 'TECHNICAL TOUCH BVBA' }),
    `KYB
K
TEGHNIGAL
TOUGHKA
SUSPENSION SERVICE CENTER
HINSON
EUROPEAN DISTRIBUTOR
TECHNICAL TOUCH byba
IZ Kristalpark - Ondernemersstraat 20 - 3920 Lommel (Belgium)
Tel. 0032-11-54.96.96 - Fax 0032-11-54.96.97
e-mail: info@technical-touch.com-www.technical-touch.com
BTW BE 0446.450.220 - RPR Hasselt`
  );
  assert.ok(technical.emails.includes('info@technical-touch.com'));

  const isis = await freshCandidate(
    previousCard({ company: 'ISIS' }),
    `ISIS
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
Www.ISISware.com`
  );
  assert.ok(isis.emails.includes('alessio.giullano@isisware.com'));
  assert.ok(isis.phones.every((phone) => phone.number.replace(/\D/g, '') !== '21760595'));
});

test('V67 QA strutturale: brand impilato, coda OCR e titoli non diventano campi falsi', async () => {
  const garbin = await freshCandidate(
    previousCard({ company: 'Garbin & maule' }),
    `Dott. Michela Maule
Dottore Commercialista c
e-mail: mmaule@garbinmaule.it
GARBIN
&MAULE
COMMERCIALISTI ASSOCIATI`
  );
  assert.equal(garbin.company, 'Garbin & Maule');
  assert.equal(garbin.role, 'Dottore Commercialista');

  const strategy = await freshCandidate(
    previousCard({ company: '3ASTRATEGY troulut' }),
    `3ASTRATEGY
troulut
Alexander Pohl, CEO
Partner
aPohl@3A-Strategy.com`
  );
  assert.equal(strategy.company, '3A Strategy');

  const sanmarco = await freshCandidate(
    previousCard({ company: 'Sanmarco informatica SpA' }),
    `Dott. Claudia Serblin
Human Resources
Sanmarco informatica SpA
cserblin@sanmarcoinformatica.it`
  );
  assert.equal(sanmarco.role, 'Human Resources');

  const lisa = await freshCandidate(
    previousCard({ company: 'Consorzio Arsenàl' }),
    `Lisa CuCcato
Staff amministrativo - Progetti europei
lcuccato consorzioarsenal.it
Uiale Oberdan, 5 - 31100 Treviso
www.consorzioarsenal.it`
  );
  assert.ok(lisa.emails.includes('lcuccato@consorzioarsenal.it'));
  assert.match(lisa.role, /Staff amministrativo/i, lisa.role);
  assert.match(lisa.address?.full ?? '', /Viale Oberdan/i, JSON.stringify(lisa.address));

  const biiker = await freshCandidate(
    previousCard({ company: 'Biiker' }),
    `BIIKER.COM
Biiker`
  );
  assert.equal(biiker.website, 'www.biiker.com');

  const piano = await freshCandidate(
    previousCard({ company: 'Pianoimmobiliare' }),
    `Marco Ceruo
mcervo@pianoimmobiliare.com
www.pianoimmobiliare.com`
  );
  assert.ok(piano.emails.includes('mcervo@pianoimmobiliare.com'));
  assert.ok(!piano.emails.includes('mceruo@pianoimmobiliare.com'));
});

test('V68 ri-OCR fronte e retro: indirizzo personale del fronte prevale sulla sede centrale', async () => {
  const candidate = await freshCandidatePages(
    previousCard({ company: 'Stz' }),
    [
      `STEINBEIS-TRANSFERZENTRUM
SOFTWARE QUALITY SYSTEMS
Prof. Dr. (Purdue Univ.)
Jörg Friedrich
Leiter
Eugen-Ruoff-Straße 30, 71404 Korb
E-Mail: joerg.triedrich@stz-sqs.com
Internet: www.stz-sqs.com`,
      `Zentrale
Steinbeis GmbH & Co KG für Technologietransfer
Haus der Wirtschaft, Willi-Bleicher-Straße 19, 70174 Stuttgart
Internet: www.stw.de`,
    ],
  );
  assert.match(candidate.address?.full ?? '', /Korb/i, JSON.stringify(candidate.address));
  assert.doesNotMatch(candidate.address?.full ?? '', /Stuttgart/i, JSON.stringify(candidate.address));
  assert.match(candidate.address?.street ?? '', /Eugen-Ruoff/i, JSON.stringify(candidate.address));
  assert.doesNotMatch(candidate.address?.street ?? '', /Willi-Bleicher/i, JSON.stringify(candidate.address));
});

test('V75 ri-OCR: rumore binario non cancella una coppia strada e CAP osservata', async () => {
  const candidate = await freshCandidate(
    previousCard({ company: 'Esempio S.r.l.' }),
    `0101010101010 Galleria Verdi, 5
0101010101010 36100 Vicenza
Esempio S.r.l.
info@esempio.it`,
  );
  assert.match(candidate.address?.full ?? '', /Galleria Verdi, 5, 36100 Vicenza/i, JSON.stringify(candidate.address));
  assert.equal(candidate.address?.postalCode, '36100');
});

test('V75 ri-OCR: ragione sociale legale osservata prevale su valore derivato dal dominio', async () => {
  const candidate = await freshCandidate(
    previousCard({ company: 'Aedsrl S.r.l.' }),
    `Alberto Capuzzo
A&D
A&D S.r.L.
Consulting & Logistic Systems
direzione@aedsrl.it
www.aedsrl.it`,
  );
  assert.match(candidate.company.replace(/\s+/g, ''), /^A&DS\.r\.L\.?$/i, candidate.company);
});

test('V75 ri-OCR: handle social coerente con il dominio non diventa persona o company estesa', async () => {
  const candidate = await freshCandidate(
    previousCard({ firstName: 'Story', lastName: 'Time', company: 'storytimeofficial About Us Storytime Podcast' }),
    `STORYTIME
About Us Storytime Podcast
assistenzaospiti@story-time.it
Spotify`,
  );
  assert.equal(candidate.firstName, '');
  assert.equal(candidate.lastName, '');
  assert.equal(candidate.company, 'Storytime');
});

test('V76 ri-OCR: dominio email sostituisce il sito OCR a due glifi solo con brand osservato', async () => {
  const candidate = await freshCandidate(
    previousCard({ company: 'Max Medical' }),
    `Max Medical
valerio.bignardi@maxmedicalgroup.com
www.naxmcdicalgroup.com`,
  );
  assert.equal(candidate.website, 'www.maxmedicalgroup.com', JSON.stringify(candidate));
});

test('V76 ri-OCR: acronimo & internazionale e 5/S richiedono dominio e prova nel testo', async () => {
  const ampersand = await freshCandidate(
    previousCard({ company: 'G& Hinternational Co., Ltd.' }),
    `G&HINTERNATIONAL CO, LTD.
e.deana@gandh.co.kr
www.gandh.co.kr`,
  );
  assert.equal(ampersand.company, 'G&H International Co., Ltd.');

  const glyph = await freshCandidate(
    previousCard({ company: 'SHEIKH OF 5IALKOT (Private) Limited' }),
    `SHEIKH OF 5IALKOT
(Private) Limited
SIALKOT 51310, PAKISTAN.
saad@sheikhofsialkot.com`,
  );
  assert.match(glyph.company, /SHEIKH OF SIALKOT/i, glyph.company);
});

test('V79 ri-OCR: parentesi al posto della chiocciola conserva una mailbox completa osservata', async () => {
  const candidate = await freshCandidate(
    previousCard({ company: 'Consorzio Esempio' }),
    `Lisa Esempio
l.esempio [consorzioesempio.it
www.consorzi0esempio.it`,
  );
  assert.ok(candidate.emails.includes('l.esempio@consorzioesempio.it'), JSON.stringify(candidate.emails));
  assert.equal(candidate.website, 'www.consorzioesempio.it');
});

test('V81 ri-OCR: un brand dominio OCR resta separato dal descrittore verticale adiacente', async () => {
  const candidate = await freshCandidate(
    previousCard({ company: 'Azienda precedente' }),
    `Professional School
BRANDLLNET
Elena Verdi`,
  );
  assert.equal(candidate.company, 'BRANDI.NET', JSON.stringify(candidate));
});

test('V82 ri-OCR: un marchio OCR confermato dal dominio prevale su slogan e forma giuridica isolata', async () => {
  const slogan = await freshCandidate(
    previousCard({ company: 'Agricoltura, Alimentazione, Ambiente Spa' }),
    `Responsabile Sistemi Informativi
Andrea Verdi
andrea.verdi@cerealdocks.it
Agricoltura, Alimentazione, Ambiente
Spa
CEREAL DOCKS`,
  );
  assert.equal(slogan.company, 'Cereal Docks Spa', JSON.stringify(slogan));

  const legalOnly = await freshCandidate(
    previousCard({ company: 'GmbH S.r.l.' }),
    `DERGAE
CONSULTING
GMBH SRL
Stefano Verdi
stefano.verdi@derga.it`,
  );
  assert.match(legalOnly.company, /^Derga\b/i, JSON.stringify(legalOnly));
});

test('V82 ri-OCR: titolo professionale e mailbox ripristinano nome composto senza dizionario', async () => {
  const candidate = await freshCandidate(
    previousCard({ firstName: 'Dal', lastName: 'Collo', company: 'Esempio' }),
    `dott.ssa Paola Dal Collo
paola.dalcollo@azienda.it
Dal Collo & Partners`,
  );
  assert.equal(candidate.firstName, 'Paola', JSON.stringify(candidate));
  assert.equal(candidate.lastName, 'Dal Collo', JSON.stringify(candidate));
});

test('V83 ri-OCR: la normalizzazione runtime non sovrascrive il brand finale del nuovo OCR', async () => {
  const candidate = await freshCandidate(
    previousCard({ company: 'Agricoltura, Alimentazione, Ambiente Spa' }),
    `R.I. - C.F. e P.IVA 02218040240
e-mail: andreazanuso@cerealdocks.it
www.cerealdocks.it
Responsabile Sistemi Informativi
ANDREA ZANUSO
Agricoltura, Alimentazione, Ambiente
Spa
CEREAL DOCKS`,
  );
  assert.equal(candidate.company, 'Cereal Docks Spa', JSON.stringify(candidate));
});
