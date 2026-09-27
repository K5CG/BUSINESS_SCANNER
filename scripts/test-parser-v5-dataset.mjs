// test-parser-v5-dataset.mjs — Regressione del motore v5 su biglietti REALI
// (layout e gerarchie di font prese dai fogli scansionati; geometria realistica).
//
// Esecuzione:
//   npm run test:parser:v5
//
// REGOLA: ogni biglietto reale che fallisce in produzione va AGGIUNTO qui
// (con i bbox veri esportati dall'app) PRIMA di qualunque fix. Una modifica
// ai pesi/regole è accettabile solo se non peggiora nessun caso esistente.

import { extractCardV5 } from '../lib/parser-v5/engine.ts';
import { extractBusinessCardV5 } from '../lib/parser-v5/index.ts';
import {
  collectExpectedEmptyFailures,
  hasDeclaredExpectedAssertion,
  summarizeContractSuite,
} from '../lib/test-suite-contract.ts';

const L = (text, y, h, x = 30) => ({ text, confidence: 0.85, boundingBox: { x, y, width: 500, height: h } });
const EXPECTED_DATASET_CASES = 119;
const RECOGNIZED_EXPECTED_KEYS = [
  'addressCity',
  'addressCityContains',
  'addressCityNot',
  'addressCivic',
  'addressContains',
  'addressContains2',
  'addressContains3',
  'addressCountryNot',
  'addressNotContains',
  'addressNotContainsAny',
  'company',
  'companyContains',
  'companyNot',
  'companyNotContains',
  'companyNotContains2',
  'emailContains',
  'emailsContain',
  'emailsNotContain',
  'firstName',
  'firstNameContains',
  'firstNameNotContains',
  'lastName',
  'lastNameContains',
  'lastNameNotContains',
  'pageMismatch',
  'phonesNotContain',
  'reviewContains',
  'role',
  'roleContains',
  'roleNotContains',
  'taxCode',
  'vatNumber',
  'websiteContains',
];
const RECOGNIZED_EXPECT_EMPTY_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'role',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

const DATASET = [
  {
    name: 'Redomino',
    pages: [{ rawText: '', lines: [
      L('Fabrizio Reale', 40, 26),
      L('fabrizio.reale@redomino.com', 72, 15),
      L('Redomino s.r.l.', 120, 20),
      L('largo valgioie 14, 10146 torino - italy', 150, 14),
      L('+39 0117499875  +39 0113716911', 175, 14),
      L('http://www.redomino.com', 200, 14),
      L('P.I 08877930019', 240, 13),
    ]}],
    expected: { firstName: 'Fabrizio', lastName: 'Reale', company: 'Redomino S.r.l.', websiteContains: 'redomino.com', vatNumber: '08877930019' },
  },
  {
    name: 'Develer',
    pages: [{ rawText: '', lines: [
      L('develer', 30, 44),
      L('eWork Solutions', 80, 14),
      L('Simone Zinanni', 40, 16, 300),
      L('Project Manager', 58, 12, 300),
      L('cell.+39.340.63.38.708', 76, 12, 300),
      L('s.zinanni@develer.com', 92, 12, 300),
      L('tel.+39.055.39.86.627 int.202', 108, 12, 300),
      L('Develer s.r.l.', 200, 15),
      L('via Mugellese 1/A', 220, 12),
      L('50013 Campi Bisenzio', 236, 12),
      L('FIRENZE - ITALY', 252, 12),
      L('info@develer.com', 220, 12, 300),
      L('www.develer.com', 252, 12, 300),
    ]}],
    expected: { firstName: 'Simone', lastName: 'Zinanni', company: 'Develer S.r.l.', role: 'Project Manager' },
  },
  {
    name: 'Eldasoft',
    pages: [{ rawText: '', lines: [
      L('ELDASOFT', 30, 34),
      L('Massimo Guerretta', 40, 18, 300),
      L('Sales Area Manager', 60, 12, 300),
      L('cell. 348 2337018', 76, 12, 300),
      L('massimo.guerretta@eldasoft.it', 92, 12, 300),
      L('è una società del Gruppo Maggioli', 160, 11),
      L('ELDASOFT S.p.A.', 185, 14),
      L('via E. Reginato, 87', 202, 11),
      L('31100 Treviso (TV)', 216, 11),
      L('tel. 0422 267720', 202, 11, 300),
      L('fax 0422 267788', 216, 11, 300),
      L('www.eldasoft.it', 240, 11),
      L('eldasoft@eldasoft.it', 240, 11, 300),
    ]}],
    expected: { firstName: 'Massimo', lastName: 'Guerretta', company: 'ELDASOFT S.p.A.', role: 'Sales Area Manager' },
  },
  {
    name: 'GIVI',
    pages: [{ rawText: '', lines: [
      L('GIVI', 40, 40),
      L('MARIO FRATI', 140, 20),
      L('Responsabile', 165, 13),
      L('Ufficio Comunicazione', 182, 13),
      L('0039.030.2686927', 260, 12),
      L('m.frati@givi.it', 280, 12),
    ]}],
    expected: { firstName: 'Mario', lastName: 'Frati', company: 'GIVI', roleContains: 'Responsabile' },
  },
  {
    name: 'Jedox',
    pages: [{ rawText: '', lines: [
      L('Jedox', 30, 38),
      L('Markus Roithmeier', 90, 16, 250),
      L('Vice President', 110, 12, 250),
      L('Global Alliances & Channel', 126, 12, 250),
      L('Jedox AG', 180, 13),
      L('Bismarckallee 7a', 196, 11),
      L('D-79098 Freiburg', 210, 11),
      L('www.jedox.com', 226, 11),
      L('Phone:  +49 761 15147 222', 196, 11, 250),
      L('Mobile: +49 151 15147 222', 210, 11, 250),
      L('markus.roithmeier@jedox.com', 226, 11, 250),
    ]}],
    expected: { firstName: 'Markus', lastName: 'Roithmeier', company: 'Jedox AG', role: 'Vice President Global Alliances & Channel' },
  },
  {
    name: 'InformEtica',
    pages: [{ rawText: '', lines: [
      L('InformEtica', 30, 34),
      L('CONSULTING', 68, 14),
      L('Luca Filippini', 110, 15, 250),
      L('Responsabile Commerciale', 128, 11, 250),
      L('luca.filippini@informeticons.com', 144, 11, 250),
      L('+39 349 0828409', 160, 11, 250),
      L('InformEtica Consulting s.r.l.', 200, 12),
      L('Viale del Lavoro, 33 - Centro Direzionale E33', 214, 10),
      L('37036 San Martino Buon Albergo - VR', 228, 10),
      L('P. Iva e C.F 03481480238', 242, 10),
      L('www.informeticons.com', 242, 10, 300),
    ]}],
    expected: { firstName: 'Luca', lastName: 'Filippini', company: 'InformEtica Consulting S.r.l.', role: 'Responsabile Commerciale', vatNumber: '03481480238' },
  },
  {
    name: 'DeMegni',
    pages: [{ rawText: '', lines: [
      L('DeMEGNI', 30, 30, 300),
      L('DISTRIBUZIONE SPA', 62, 10, 300),
      L('D.ssa Micaela Cera', 100, 14),
      L('RESPONSABILE AREA CLIENTI', 118, 9),
      L('micaela.cera@demegni.it', 140, 10),
      L('DeMegni Antonio & Figli S.p.A.', 180, 11, 250),
      L("37032 Monteforte d'Alpone - Via Cappuccini, 11/13 - Verona", 194, 9, 250),
      L('tel. +39 045 6173 111 - fax +39 045 6100044 - c.f. 00232750232', 208, 9, 250),
      L('www.demegni.it - demegni@demegni.it', 222, 9, 250),
    ]}],
    expected: { firstName: 'Micaela', lastName: 'Cera', companyContains: 'DeMegni', roleContains: 'Responsabile Area Clienti', taxCode: '00232750232' },
  },
  {
    name: 'bNOVA',
    pages: [{ rawText: '', lines: [
      L('bNOVA', 30, 42),
      L('srl', 34, 12, 480),
      L('CONSULTING', 78, 12),
      L('Serena Arrighi', 140, 15),
      L('+39 347 6453163', 160, 11),
      L('serena.arrighi@bnova.it', 200, 11),
      L('Via Silicani, 2', 140, 11, 300),
      L('54033 CARRARA (MS) - ITALY', 156, 11, 300),
      L('Tel. +39 0585 842210', 172, 11, 300),
      L('Fax +39 0585 847107', 188, 11, 300),
      L('www.bnova.it', 204, 12, 300),
    ]}],
    expected: { firstName: 'Serena', lastName: 'Arrighi', companyContains: 'bNOVA' },
  },
  {
    name: 'ABLE Tech',
    pages: [{ rawText: '', lines: [
      L('ABLE tech', 30, 30),
      L('DOCUMENT MANAGEMENT SOLUTIONS', 62, 8),
      L('Laura De Zio', 60, 14, 300),
      L('Account Manager', 78, 11, 300),
      L('+39 335 1630455', 94, 11, 300),
      L('l.dezio@abletech.it', 110, 11, 300),
      L('ARXivar', 150, 22, 300),
      L('ABLE Tech srl', 200, 12),
      L("Via dell'Artigianato, 9/A", 214, 10),
      L('25018 Montichiari (BS) - ITALY', 228, 10),
      L('Tel. +39 030 9650.688  Fax +39 030 81931160', 242, 10),
      L('P. IVA 02355260981', 256, 10),
    ]}],
    expected: { firstName: 'Laura', lastName: 'De Zio', companyContains: 'ABLE Tech', role: 'Account Manager', vatNumber: '02355260981' },
  },
  {
    name: 'TinyAtWork',
    pages: [{ rawText: '', lines: [
      L('TINYatWORK', 40, 36),
      L('Jean-Marc Babin', 100, 14),
      L('Président', 118, 11),
      L('Les Solutions TINYatWORK inc.', 100, 11, 280),
      L('une division de Epsilon Technologies', 114, 9, 280),
      L('3175, ch. des Quatre-Bourgeois', 130, 10, 280),
      L('bureau 110', 144, 10, 280),
      L('Sainte-Foy, QC, Canada, G1W 2K7', 158, 10, 280),
      L('Téléphone : 418 780-1815', 200, 10),
      L('Cellulaire : 418 563-8019', 214, 10),
      L('jmbabin@epsilon-tl.com', 228, 10),
      L('www.tinyatwork.com', 242, 10),
    ]}],
    expected: { firstName: 'Jean-Marc', lastName: 'Babin', companyContains: 'TINYatWORK inc', role: 'Président' },
  },
  {
    name: 'Querit',
    pages: [{ rawText: '', lines: [
      L('Querit', 30, 40),
      L("Soluzioni per l'analisi dei dati", 76, 10),
      L('QUERIT Srl', 120, 13),
      L('Via dei Ciliegi 49', 134, 10),
      L('31015 Conegliano (TV)', 148, 10),
      L('Tel.: 0438 1895001', 162, 10),
      L('Fax: 0438 1895003', 176, 10),
      L('Cod.Fisc. e P.I 04206400261', 190, 10),
      L('http://www.querit.it', 204, 10),
      L('Roberto Montanari', 140, 15, 300),
      L('CHIEF EXECUTIVE', 160, 11, 300),
      L('mobile: +39 388 0435702', 240, 10, 300),
      L('e-mail: roberto.montanari@querit.it', 254, 10, 300),
    ]}],
    expected: { firstName: 'Roberto', lastName: 'Montanari', companyContains: 'QUERIT', role: 'Chief Executive', vatNumber: '04206400261' },
  },
  {
    name: 'LCS fiscal',
    pages: [{ rawText: '', lines: [
      L('Fabrizio Grosso', 40, 15),
      L('LCS S.p.A.', 60, 14),
      L('Tel. +39 039 67 55 951', 100, 12),
      L('C.FPI. 123272201 53', 120, 12),
      L('fabrizio.grosso@lcsgroup.it', 140, 11),
    ]}],
    expected: { vatNumber: '12327220153', phonesNotContain: '12327220153' },
  },
  {
    name: 'Gmail no website',
    pages: [{ rawText: '', lines: [
      L('Mario Rossi', 40, 15),
      L('Consulente', 60, 12),
      L('mario.rossi@gmail.com', 90, 11),
    ]}],
    expectEmpty: ['website'],
    expected: {},
  },
  {
    name: 'Steinbeis',
    pages: [{ rawText: '', lines: [
      L('STEINBEIS-TRANSFERZENTRUM', 40, 16),
      L('SOFTWARE QUALITY SYSTEMS', 60, 16),
      L('Prof. Dr. (Purdue Univ.)', 100, 10),
      L('Jörg Friedrich', 114, 15),
      L('Leiter', 132, 10),
      L('Eugen-Ruoff-Straße 30, 71404 Korb', 160, 10),
      L('Fon: (0 71 51) 27 01 97, Fax: (0 71 51) 93 79 41', 176, 10),
      L('Mobil: (01 71) 2 74 68 68', 190, 10),
      L('E-Mail: joerg.friedrich@stz-sqs.com, Internet: www.stz-sqs.com', 206, 9),
    ]}],
    expected: { firstName: 'Jörg', lastName: 'Friedrich', role: 'Leiter', addressCountryNot: 'IT' },
  },
  {
    name: 'Split nome+azienda sulla stessa riga',
    pages: [{ rawText: '', lines: [
      L('MES & WMS', 40, 16),
      L('Fabrizio Grosso LCS S.p.A.', 70, 15),
      L('LOGISTICA E AUTOMAZIONE', 92, 10),
      L('f.grosso@lcsgroup.it', 200, 11),
      L('www.lcsgroup.it', 216, 11),
    ]}],
    expected: { firstName: 'Fabrizio', lastName: 'Grosso', companyContains: 'LCS S.p.A' },
  },
  {
    name: 'OPC Group',
    pages: [{ rawText: '', lines: [
      L('opcGroup', 30, 28),
      L('Elda Alberti', 40, 13, 300),
      L('Account Manager', 56, 10, 300),
      L('Security', 90, 11),
      L('Management', 104, 11),
      L('Networking', 118, 11),
      L('OPC GROUP SPA', 150, 12),
      L('Via E. Breda 152', 164, 10),
      L('20126 Milano', 178, 10),
      L('Tel.  +39 02 2529.661', 192, 10),
      L('Fax  +39 02 2529.6621', 206, 10),
      L('cellulare +39 393 9303780', 192, 10, 300),
      L('e-mail: elda.alberti@opcgroup.it', 206, 10, 300),
      L('www.opcgroup.it', 230, 10),
    ]}],
    expected: { firstName: 'Elda', lastName: 'Alberti', companyContains: 'OPC GROUP', role: 'Account Manager' },
  },
{
    name: 'ICT-GROUP (fronte+retro, P.IVA con OCR corrotto)',
    pages: [
      { rawText: '', lines: [
        L('ICTGROUP', 30, 30, 250),
        L('SOFTWARE | TECHNOLOGY | INNOVATION', 64, 9, 250),
        L('Andrea Frosini', 150, 18),
        L('Sales Area Manager', 172, 11),
        L('+39 335.7750826', 192, 12),
        L('andrea.frosini@ict-group.it', 210, 12),
      ]},
      { rawText: '', lines: [
        L('ICT-GROUP S.r.l.', 40, 13),
        L('Via Cavallotti, 8', 58, 11),
        L('42122 Reggio Emilia (RE) - Italy', 74, 11),
        L('Tel.  +39 0522.629641', 90, 11),
        L('Fax. +39 0522.629259', 106, 11),
        L('www.ict-group.it', 122, 11),
        L('PJVA O2493530352', 150, 11),
        L('Capitale sociale: 300.000 € i.v.', 166, 11),
      ]},
    ],
    expected: { firstName: 'Andrea', lastName: 'Frosini', company: 'ICT-GROUP S.r.l.', role: 'Sales Area Manager', vatNumber: '02493530352', websiteContains: 'ict-group.it' },
  },
  {
    name: 'UP!TRAIL (logo storpiato da OCR, nessuna persona)',
    pages: [
      { rawText: '', lines: [
        L('UP:TRAIC', 40, 30),
        L('REAL WORLD ADVENTURES', 40, 10, 470),
        L('MODENA', 90, 12, 250),
        L('Via Lorenzo Perosi, 71 I41122', 106, 11, 250),
        L('+39 059 580 2780', 122, 11, 250),
        L('+39 392 534 3674', 138, 11, 250),
        L('hello@up-trail.com', 154, 11, 250),
        L('www.up-trail.com', 170, 11, 250),
        L('AUTHORIZED DEALER', 210, 10),
      ]},
      { rawText: '', lines: [
        L('UPTRAC', 60, 20),
        L('inquadra questo codice', 200, 12),
        L('per iniziare una chat WhatsApp', 218, 12),
      ]},
    ],
    expected: { companyContains: 'Up Trail', websiteContains: 'up-trail.com' },
    expectEmpty: ['firstName', 'lastName'],
  },
{
    name: 'ICT-GROUP retro devastato (OCR reale dal telefono)',
    pages: [
      { rawText: '', lines: [
        L('BICTGROUP', 30, 30),
        L('sOFTWARE TECHNOLOGY I INNOVATION', 64, 9),
        L('Andrea Frosini', 150, 18),
        L('Sales Area Manager', 172, 11),
        L('439 335.7750826', 192, 12),
        L('andrea.frosini@ict-group.it', 210, 12),
      ]},
      { rawText: '', lines: [
        L('LaGROUR SIH', 40, 13),
        L('Cavalottil B', 58, 11),
        L('42222 Reggio Emlla (REHaly', 74, 11),
        L('Teli39 0522.62964L', 90, 11),
        L('39O522.629259', 106, 11),
        L('Pad', 122, 11),
        L('rounit', 138, 11),
        L('PIVA 02493580852', 154, 11),
        L('Capitale sociale: 900,000 C', 170, 11),
      ]},
    ],
    // NOTA: la P.IVA qui è SBAGLIATA nell'OCR (8 al posto di 3) e i due errori
    // si annullano nel checksum: irrecuperabile via software. Si assert il resto.
    expected: { firstName: 'Andrea', lastName: 'Frosini', companyContains: 'ict group', role: 'Sales Area Manager' },
  },
  {
    name: 'UP!TRAIL OCR reale (UPITRAIC, CAP incollato alla via)',
    pages: [
      { rawText: '', lines: [
        L('REAL WORLD ADVENTURES', 30, 10, 470),
        L('A', 36, 24),
        L('UPITRAIC', 40, 30, 80),
        L('MODENA', 90, 12, 250),
        L('Via Lorenzo Perosi, 71 I41122', 106, 11, 250),
        L('+39 059 580 2780', 122, 11, 250),
        L('+39 392 534 3674', 138, 11, 250),
        L('hello@up-trail.com', 154, 11, 250),
        L('www.up-trail.com', 170, 11, 250),
        L('AUTHORIZED DEALER', 210, 10),
      ]},
      { rawText: '', lines: [
        L('A', 40, 24),
        L('inquadra questo codice', 200, 12),
        L('per iniziare una chat WhatsApp', 218, 12),
      ]},
    ],
    expected: { companyContains: 'up trail', websiteContains: 'up-trail.com', addressContains: 'lorenzo perosi', addressCity: 'Modena' },
    expectEmpty: ['firstName', 'lastName'],
  },
{
    name: 'Falegnameria Filippi (OCR reale: logo F, FIGLSNE, email corrotta)',
    pages: [
      { rawText: '', lines: [
        L('F', 60, 90, 60),
        L('EALEGNAMERIA FLIPPE', 70, 14, 250),
        L('PIETRO & FIGLSNE', 92, 14, 250),
        L('LEGNO PERPASSIONE DAL 1954', 160, 10),
      ]},
      { rawText: '', lines: [
        L('Via Belfiore 10, 36015 Schio (VI)', 40, 12),
        L('0445672872', 58, 12),
        L('info@filippiserrament.it', 76, 12),
        L('www.filippiserramenti.it', 94, 12),
        L('serramenti in legno, legno-alluminio', 130, 10),
        L('SCuri', 146, 10),
        L('porloncini blindai', 162, 10),
        L('porte interne', 178, 10),
        L('arredamenti su misura', 194, 10),
      ]},
    ],
    // "PIETRO & FIGLI SNC" NON è una persona; l'email va riparata dal sito.
    expected: { websiteContains: 'filippiserramenti.it', emailsContain: 'info@filippiserrament.it', companyNot: 'F', addressContains: 'belfiore' },
    expectEmpty: ['firstName', 'lastName'],
  },
  {
    name: 'Eco-Sabbiatura (OCR reale: "di Erik Rizzo" = proprietà S.n.c.)',
    pages: [{ rawText: '', lines: [
      L('MICROSABBIATURA - VERNICIATURA - IDROPULITURA', 30, 10),
      L('ATTREZZATO PER CENTRI STORICI', 46, 10),
      L('ECO-SABBIATURA S.n.c.', 80, 18),
      L('di Erik Rizzo', 104, 13),
      L('Cell. 335 25 92 82', 130, 11),
      L('Tel. e Fax 0444.590013', 146, 11),
      L('36031 DUEVILLE (VI) Via Corvo, 85', 162, 11),
      L('P.IVA / cod. fisc. 02685020246', 178, 11),
      L('www.ecosabbiatura.it', 194, 11),
      L('info@ecosabbiatura.it', 210, 11),
    ]}],
    expected: { firstName: 'Erik', lastName: 'Rizzo', company: 'ECO-SABBIATURA S.n.c.', vatNumber: '02685020246', taxCode: '02685020246', websiteContains: 'ecosabbiatura.it', addressContains: 'corvo' },
  },
  {
    name: 'Dal Collo & Partners (il respell NON deve toccare nomi multi-parola)',
    pages: [{ rawText: '', lines: [
      L('Dal Collo & Partners', 40, 26),
      L('Commercialisti Associati', 72, 11),
      L('Tel. 0444 123456', 140, 11),
      L('info@dalcolloepartners.it', 158, 11),
      L('www.dalcolloepartners.it', 176, 11),
    ]}],
    expected: { companyContains: 'dal collo partners' },
    expectEmpty: ['firstName', 'lastName'],
  },
  {
    name: 'SGERZE MASSIMO (cognome-nome in maiuscolo)',
    pages: [{ rawText: '', lines: [
      L('SGERZE MASSIMO', 40, 22),
      L('Agente', 70, 12),
      L('m.sgerze@example.it', 100, 11),
      L('Sgerze S.r.l.', 130, 13),
    ]}],
    expected: { firstName: 'Massimo', lastName: 'Sgerze', role: 'Agente' },
  },
  {
    name: 'iDempiere ruolo inline',
    pages: [{ rawText: '', lines: [
      L('Marco Bianchi', 40, 16),
      L('marco.bianchi@idempiere.com', 70, 11),
      L('iDempiere Consulting s.r.l. CEO/ Senior Consultant', 110, 13),
      L('www.idempiere.com', 140, 11),
    ]}],
    expected: { firstName: 'Marco', lastName: 'Bianchi', companyContains: 'iDempiere', roleContains: 'CEO' },
  },
  {
    name: 'CEO pipe academy',
    pages: [{ rawText: '', lines: [
      L('Laura Verdi', 40, 16),
      L('CEO | Coffee Training Academy - Verona', 70, 12),
      L('laura@coffeetraining.it', 100, 11),
      L('Coffee Training S.r.l.', 130, 13),
    ]}],
    expected: { firstName: 'Laura', lastName: 'Verdi', role: 'CEO' },
  },
  {
    name: 'AUTOTECH + Piva Gomme (cross-card: P.IVA distinte)',
    pages: [
      { rawText: '', lines: [
        L('Piva Gomme', 30, 20),
        L('PVA GOMME SCHIO S', 55, 14),
        L("Via dell'industria, 44", 75, 12),
        L('SCHIO (VI)', 92, 12),
        L('Tel. 0445 510748- Fax 0445 512732', 110, 11),
        L('P.VA 01797270244', 128, 11),
        L('info@pivagommeschio.com', 146, 11),
        L('www.pivagommeschio.com', 164, 11),
      ]},
      { rawText: '', lines: [
        L('AUTOTECH.', 30, 22),
        L('SRL', 55, 12),
        L('OFFICINA ELETTRAUTO', 72, 12),
        L('OBOSCH', 90, 10),
        L('Asso', 106, 10),
        L("AUTOTECH srl- Via dell' industria, 44- 36015 SCHIO VI)", 130, 12),
        L('Tel. 0445 510748 - Fax 0445 512732', 148, 11),
        L('Part. VA 03876570247', 166, 11),
      ]},
    ],
    expected: {
      pageMismatch: true,
      companyContains: 'gomme',
      emailsContain: 'info@pivagommeschio.com',
      vatNumber: '01797270244',
      companyNot: 'AUTOTECH',
      addressCityNot: 'Asso',
    },
  },
  {
    name: 'Sgerze Massimo libero OCR (1ibero non è company)',
    pages: [{ rawText: '', lines: [
      L('IMPRESA', 30, 16),
      L('EDILE', 50, 14),
      L('SGERZE MASSIMO', 72, 18),
      L('Via Maistri, 1 - 36030 MONTE DI MALO (VI)', 100, 12),
      L('Tel. e Fax 0445 606484', 118, 11),
      L('PIVA 02969340245', 136, 11),
      L('E-mail: massimosberze @1ibero.it', 154, 11),
    ]}],
    expected: {
      firstName: 'Massimo',
      lastName: 'Sgerze',
      companyContains: 'sgerze',
      companyNot: '1ibero',
      addressContains: 'maistri',
    },
    expectEmpty: ['website'],
  },
  {
    name: 'ICT-GROUP civic number (Via Cavallotti, 8)',
    pages: [{ rawText: '', lines: [
      L('ICT-GROUP', 30, 28),
      L('SOFTWARE | TECHNOLOGY | INNOVATION', 62, 11),
      L('Andrea Frosini', 90, 16),
      L('Sales Area Manager', 110, 12),
      L('andrea.frosini@ict-group.it', 130, 11),
      L('ICT-GROUP S.r.l.', 155, 13),
      L('Via Cavallotti, 8', 175, 11),
      L('42122 Reggio Emilia (RE) - Italy', 192, 11),
      L('www.ict-group.it', 210, 11),
      L('PIVA 02493530352', 228, 11),
    ]}],
    expected: {
      firstName: 'Andrea',
      lastName: 'Frosini',
      companyContains: 'ict-group',
      addressContains: 'cavallotti',
      addressCivic: '8',
    },
  },
  {
    name: 'A&D S.r.l (descriptor non è company)',
    pages: [{ rawText: '', lines: [
      L('Alberto Capuzzo', 40, 16),
      L('Amministratore Delegato', 60, 12),
      L('A&D', 90, 22),
      L('CONSULTING & LOGISTESSTEMS', 115, 11),
      L('A&D S.r.L.', 135, 13),
      L('Galleria Spagna, 35', 160, 11),
      L('35127 Padova', 178, 11),
      L('email: direzione@aedsrl.it', 200, 11),
      L('www.aedsrl.it', 218, 11),
    ]}],
    expected: {
      firstName: 'Alberto',
      lastName: 'Capuzzo',
      companyContains: 'a&d',
      companyNot: 'CONSULTING',
    },
  },
  {
    name: 'Leoni concessionaria (no persona falsa)',
    pages: [{ rawText: '', lines: [
      L('LEONI', 30, 24),
      L('Concessionaria LEONI GUIDO', 58, 14),
      L('di Leoni Bruno e C. s.a.s.', 78, 12),
      L('YAMAHA', 98, 12),
      L('Sede', 118, 10),
      L('46014 Castellucchio (MN)', 132, 11),
      L('Via P Sissa, 2', 148, 11),
      L('Tel 0376438078', 164, 11),
    ]}],
    expected: { companyContains: 'leoni' },
    expectEmpty: ['firstName', 'lastName'],
  },
  {
    name: 'Eco-Sabbiatura CAP prima via (36031 DUEVILLE Via Corvo, 85)',
    pages: [{ rawText: '', lines: [
      L('ECO-SABBIATURA S.n.c.', 40, 16),
      L('di Erik Rizzo', 62, 12),
      L('36031 DUEVILLE (VI) Via Corvo, 85', 90, 12),
      L('info@ecosabbiatura.it', 110, 11),
    ]}],
    expected: { companyContains: 'eco-sabbiatura', addressContains: 'corvo', addressCivic: '85' },
  },
  {
    name: 'Fluentis (città Internet è rumore OCR)',
    pages: [{ rawText: '', lines: [
      L('Fabrizio Saro', 40, 16),
      L('General Manager', 58, 12),
      L('fabrizio.s@fuentisCom', 78, 11),
      L('Internet:', 96, 10),
      L('Via Mezzomonte 24', 110, 11),
      L('www.fuentis.com', 126, 11),
      L('33077-Sacile (PN)- ITALY', 142, 11),
    ]}],
    expected: {
      firstName: 'Fabrizio',
      lastName: 'Saro',
      role: 'General Manager',
      companyContains: 'fuentis',
      addressCityNot: 'Internet',
    },
  },
  {
    name: 'Filippiserramenti dominio non è company',
    pages: [{ rawText: '', lines: [
      L('FALEGNAMERIA FILIPPI', 40, 16),
      L('PIETRO & FIGLI S.N.C.', 62, 13),
      L('Via Belfiore 10, 36015 Schio (VI)', 90, 12),
      L('info@filippiserramenti.it', 110, 11),
      L('www.filippiserramenti.it', 128, 11),
    ]}],
    expected: { companyContains: 'figli', companyNot: 'filippiserramenti', websiteContains: 'filippiserramenti.it' },
    expectEmpty: ['firstName', 'lastName'],
  },
  {
    name: 'Stucchi S.p.A. (OCR reale deep-100)',
    pages: [
      { rawText: '', lines: [
        L('Stucchi', 30, 22),
        L('Marco Rivoltella', 58, 14),
        L('Supply Chain Manager', 76, 12),
        L('mrivoltella@stucchi.it', 94, 11),
        L('Via della Lira Italiana, snc', 112, 11),
        L('24040 Pagazzano (BG) Italy', 128, 11),
      ]},
      { rawText: '', lines: [
        L('Stucchi S.p.A.', 30, 16, 30, 1),
        L('Registered Office', 50, 11, 30, 1),
        L('Via Galileo Galilei, 1', 66, 11, 30, 1),
        L('stucchi.it', 82, 11, 30, 1),
      ]},
    ],
    expected: { firstName: 'Marco', lastName: 'Rivoltella', companyContains: 'stucchi', roleContains: 'Supply Chain' },
  },
  {
    name: 'INFODATI S.p.A. (OCR reale deep-100)',
    pages: [
      { rawText: '', lines: [
        L('INFODATI', 30, 24),
        L('INNOVATIVE BRIDGE', 58, 11),
        L('FILIPPO DE GUIO', 74, 14),
        L('CEO', 92, 11),
        L('filippo.deguio@infodati.it', 108, 11),
      ]},
      { rawText: '', lines: [
        L('INFODAI S.P.A', 30, 14, 30, 1),
        L('Galleria Crispi,', 48, 11, 30, 1),
        L('36100 Vicenza', 64, 11, 30, 1),
        L('info@infodati.it', 80, 11, 30, 1),
      ]},
    ],
    expected: { firstName: 'Filippo', lastName: 'De Guio', companyContains: 'infoda', role: 'CEO' },
  },
  {
    name: 'Pro-Vision S.r.l. (OCR reale deep-100)',
    pages: [{ rawText: '', lines: [
      L('Pro-Vision', 30, 22),
      L('SOLUZIONI E SISTEMI INFORMATICI', 58, 11),
      L('Ing. Mario Ascari', 76, 14),
      L('m.ascari@pro-vision.it', 94, 11),
      L('Pro-Vision S.r.l. - Via C. Marx, 97 - 41012 Carpi (MO)', 112, 11),
      L('www.pro-vision.it', 130, 11),
    ]}],
    expected: { firstName: 'Mario', lastName: 'Ascari', companyContains: 'pro-vision' },
  },
  {
    name: 'INFOLOG S.p.A. (OCR reale deep-100)',
    pages: [{ rawText: '', lines: [
      L('Giorgio Tesorieri', 30, 14),
      L('giorgio.tesorieri@infolog.it', 48, 11),
      L('INFOLOG', 66, 20),
      L('INFOLOG SPA', 90, 13),
      L('business solutions &', 108, 11),
      L('Via Pier Paolo Pasolini 23', 124, 11),
      L('41123 Modena - Italy', 140, 11),
      L('www.infolog.it', 156, 11),
    ]}],
    expected: { firstName: 'Giorgio', lastName: 'Tesorieri', companyContains: 'infolog' },
  },
  {
    name: 'LCS S.p.A. (OCR reale deep-100)',
    pages: [{ rawText: '', lines: [
      L('LCS', 30, 22),
      L('Fabrizio Grosso', 58, 14),
      L('LCS S.p.A.', 76, 13),
      L('Senior Software Engineer', 94, 12),
      L('Via Bernini, 30', 112, 11),
      L('Usmate Velate (MB) -20865', 128, 11),
      L('fabrizio.grosso@lcsgroup.it', 146, 11),
      L('www.lcsgroup.it', 162, 11),
    ]}],
    expected: { firstName: 'Fabrizio', lastName: 'Grosso', companyContains: 'lcs' },
  },
  {
    name: 'Conduct AS (OCR reale deep-100)',
    pages: [{ rawText: '', lines: [
      L('JBoss Authorized', 30, 11),
      L('CONDUCT', 50, 20),
      L('Conduct AS', 74, 14),
      L('Kongens gate 14', 92, 11),
      L('Lars Johansson', 108, 14),
      L('lars.johansson@conduct.no', 126, 11),
      L('www.conduct.no', 142, 11),
    ]}],
    expected: { firstName: 'Lars', lastName: 'Johansson', companyContains: 'conduct' },
  },
  {
    name: 'Camptocamp SA (OCR reale deep-100)',
    pages: [{ rawText: '', lines: [
      L('Dr Claude Philipona', 30, 14),
      L('Directeur associé', 48, 12),
      L('camp to camp', 66, 14),
      L('claude.philipona@camptocamp.com', 84, 11),
      L('camptocamp SA', 102, 14),
      L('PSE-A/ Parc Scientifique EPFL / CH-1015 Lausanne', 120, 11),
      L('www.camptocamp.com', 138, 11),
    ]}],
    expected: { firstName: 'Claude', lastName: 'Philipona', companyContains: 'camptocamp' },
  },
  {
    name: 'Wise legal form da retro (OCR reale)',
    pages: [
      { rawText: '', lines: [
        L('Wise', 30, 28),
        L('Ingegneria e Soluzioni Software', 62, 11),
        L('Alessandro Pesenti', 90, 14),
        L('Software Solutions Manager', 108, 12),
        L('pesenti.alessandro@wiseingegneriait', 126, 11),
      ]},
      { rawText: '', lines: [
        L('Wise Ingegneria', 30, 14, 30, 1),
        L('e Soluzioni Software S.r.l.', 48, 12, 30, 1),
        L('via Artigiani, 22', 66, 11, 30, 1),
        L('24060 Brusaporto (BG) Italy', 82, 11, 30, 1),
        L('www.wiseingegneria.it', 98, 11, 30, 1),
      ]},
    ],
    expected: { companyContains: 'wise', roleContains: 'Software' },
  },
  {
    name: 'CRMVillage.BIZ (logo non mascherato)',
    pages: [{ rawText: '', lines: [
      L('CRMVILLAGE.BIZ', 30, 22),
      L('soluzioni e tecnologie per la', 54, 11),
      L('Dott. Davide Bonamini', 90, 14),
      L('davide.bonamini@crmvillage.biz', 108, 11),
      L('CRMVILLAGE.BIZ S.rL', 126, 13),
      L('Via Fogazzaro 1', 144, 11),
      L('37047 San Bonifacio-VR', 160, 11),
    ]}],
    expected: { firstName: 'Davide', lastName: 'Bonamini', companyContains: 'crmvillage' },
  },
  {
    name: 'SIME Servizi Industriali (OCR reale QA 1209)',
    pages: [{ rawText: '', lines: [
      L('SIME', 30, 28),
      L('C.F./ PVA 03433961202', 62, 11),
      L('sERVIZI INDUSTRIALI METALLURGICI S.RL.', 80, 14),
      L('Ivan Barzagli', 100, 14),
      L('Manager', 118, 12),
      L('ivan.barzagli@simemetalli.it', 136, 11),
      L('www.simemetalli.it', 154, 11),
    ]}],
    expected: {
      firstName: 'Ivan',
      lastName: 'Barzagli',
      companyContains: 'servizi industriali metallurgici',
      role: 'Manager',
      websiteContains: 'simemetalli.it',
    },
  },
  {
    name: 'Dario Facchini EOSbio (OCR reale QA 1209)',
    pages: [{ rawText: '', lines: [
      L('EOS GROUP', 30, 18),
      L('DARIO FACCHINI', 58, 16),
      L('Marketing Manoger', 76, 12),
      L('+39 347 991 7897', 94, 11),
      L('focchinioeosbio.com', 112, 11),
      L('Sede operativa: Via Fossona, 7IA', 130, 11),
      L('35030 Cervarese S. Croce (PD)', 148, 11),
    ]}],
    expected: {
      firstName: 'Dario',
      lastName: 'Facchini',
      companyContains: 'eos',
      companyNot: 'focchinioeosbio.com',

      roleContains: 'Marketing',
    },
  },
  {
    name: 'Tuglak Motorbike (OCR reale QA 1209)',
    pages: [{ rawText: '', lines: [
      L('TUGInK', 30, 22),
      L('moTORBIKE IND.', 54, 12),
      L('m.ASHRAr TUGLAK', 78, 16),
      L('Managing partner', 96, 12),
      L('www.tuglakmotorbike.com', 114, 11),
      L('inko@tugiakmotorbike.com', 132, 11),
    ]}],
    expected: {
      firstName: 'Ashrar',
      lastName: 'Tuglak',
      companyContains: 'tuglak',
      roleContains: 'Managing partner',
      websiteContains: 'tuglakmotorbike.com',
    },
  },
  {
    name: 'Tuglak Motorbike device OCR (Gmail + TUGIAK logo)',
    pages: [{ rawText: '', lines: [
      L('TUGIAK', 30, 22),
      L('moTORBIKE IND.', 54, 12),
      L('M ASHRAG TUGLAK', 78, 16),
      L('Managing partner', 96, 12),
      L('www.tuglakmotorbike.com', 114, 11),
      L('tuglakmotorbike@gmail.com', 132, 11),
      L('info@tuglakmotorbike.com', 150, 11),
    ]}],
    expected: {
      firstName: 'Ashrag',
      lastName: 'Tuglak',
      companyContains: 'tuglak',
      companyNot: 'tugiak',
      roleContains: 'Managing partner',
      websiteContains: 'tuglakmotorbike.com',
      emailsContain: 'info@tuglakmotorbike.com',
    },
  },
  {
    name: 'MongoDB JSON-like (OCR reale QA 1209)',
    pages: [{ rawText: `mongoDB
name
"Luca 0livari",
title
: "Director, Business Dev. & Strategy",
email
"luca.olivari@mongodb. com"`, lines: [
      L('mongoDB', 30, 22),
      L('name', 54, 10),
      L('"Luca 0livari",', 68, 12),
      L('title', 86, 10),
      L(': "Director, Business Dev. & Strategy",', 100, 12),
      L('email', 118, 10),
      L('"luca.olivari@mongodb. com",', 132, 12),
      L('www.mongodb.com', 150, 11),
    ]}],
    expected: {
      firstName: 'Luca',
      lastName: 'Olivari',
      companyContains: 'mongo',
      roleContains: 'Director',

    },
  },
  {
    name: 'Wise ragione sociale completa (QA 1209)',
    pages: [
      { rawText: '', lines: [
        L('Wise', 30, 24),
        L('Ingegneria e Soluzioni Software', 58, 11),
        L('Alessandro Pesenti', 86, 14),
        L('Software Solutions Manager', 104, 12),
        L('pesenti.alessandro@wiseingegneriait', 122, 11),
      ]},
      { rawText: '', lines: [
        L('Wise Ingegneria', 30, 14, 30, 1),
        L('e Soluzioni Software S.r.l.', 48, 12, 30, 1),
        L('www.wiseingegneria.it', 66, 11, 30, 1),
      ]},
    ],
    expected: { companyContains: 'wise ingegneria', roleContains: 'Software' },
  },
  {
    name: 'Indirizzo IT duplicato CAP (QA 1209)',
    pages: [{ rawText: '', lines: [
      L('FALEGNAMERIA FILIPPI', 40, 14),
      L('PIETRO & FIGLI S.N.C.', 58, 12),
      L('Via Belfiore 10, 36015 Schio (VI)', 80, 12),
      L('info@filippiserramenti.it', 98, 11),
    ]}],
    expected: {
      companyContains: 'figli',
      addressContains: 'belfiore',
      addressCivic: '10',
    },
  },
  {
    name: 'Indirizzo estero UK (QA 1209)',
    pages: [{ rawText: '', lines: [
      L('Acme Ltd', 40, 16),
      L('John Smith', 62, 14),
      L('42 High Street', 84, 12),
      L('London SW1A 1AA', 102, 12),
      L('www.acme.co.uk', 120, 11),
    ]}],
    expected: { companyContains: 'acme', addressContains: 'high street' },
  },
  {
    name: 'Indirizzo estero DE (QA 1209)',
    pages: [{ rawText: '', lines: [
      L('Muster GmbH', 40, 14),
      L('Hans Mueller', 62, 14),
      L('Hauptstrasse 12', 84, 12),
      L('D-79098 Freiburg', 102, 12),
      L('www.muster.de', 120, 11),
    ]}],
    expected: { companyContains: 'muster', addressContains: 'hauptstrasse' },
  },
  {
    name: 'Indirizzo estero US (QA 1209)',
    pages: [{ rawText: '', lines: [
      L('Tech Corp', 40, 14),
      L('Jane Doe', 62, 14),
      L('500 Market St', 84, 12),
      L('San Francisco, CA 94105', 102, 12),
      L('www.techcorp.com', 120, 11),
    ]}],
    expected: { companyContains: 'tech', addressContains: 'market' },
  },
  {
    name: 'Dieffe De Franceschi (OCR LUG + ragione sociale SAS)',
    pages: [{ rawText: '', lines: [
      L('LUG DE FRANCESCH', 40, 18),
      L('info@dieffeinterni.it', 62, 12),
      L('D.F. Interni i De Franceschi Luigi & C. SAS.', 120, 16),
      L('via Campagnola 21D - 36015 Schio (V)', 142, 12),
    ]}],
    expected: {
      firstName: 'Luigi',
      lastName: 'De Franceschi',
      companyContains: 'De Franceschi',
    },
  },
  {
    name: 'Dieffe OCR reale export QA (LUG troncato + logo defe/inlemi)',
    pages: [{ rawText: `LUG DE FRANCESCH
info@dieffeinterni.it
cell. +39 340 4956821
defe
inlemi`, lines: [
      L('LUG DE FRANCESCH', 40, 18),
      L('info@dieffeinterni.it', 62, 12),
      L('cell. +39 340 4956821', 80, 12),
      L('defe', 98, 16),
      L('inlemi', 98, 16),
    ]}, { rawText: `D.F. Interni i De Franceschi Luigi & C. SAS.
via Campagnola 21D - 36015 Schio (V)
tel e fax O445 517717
P lva e C.F. 03930900240`, lines: [
      L('D.F. Interni i De Franceschi Luigi & C. SAS.', 120, 16),
      L('via Campagnola 21D - 36015 Schio (V)', 142, 12),
      L('tel e fax O445 517717', 160, 12),
      L('P lva e C.F. 03930900240', 178, 12),
    ]}],
    expected: {
      firstName: 'Luigi',
      lastName: 'De Franceschi',
      companyContains: 'De Franceschi',
    },
  },
  {
    name: 'Magia Piergiorgio Asti (nome sotto ragione sociale)',
    pages: [{ rawText: '', lines: [
      L('Magia', 30, 20),
      L('MAGIA Srl', 55, 14),
      L('Piergiorgio Asti', 75, 14),
      L('piergiorgio.asti@magia3.it', 95, 12),
    ]}],
    expected: { firstName: 'Piergiorgio', lastName: 'Asti', companyContains: 'Magia' },
  },
  {
    name: 'Bicego dr.ssa Delia Salviati (dr. non è via)',
    pages: [{ rawText: '', lines: [
      L('A bicego.it', 40, 12),
      L('dr.ssa Delia Salviati', 58, 14),
      L('responsabile area', 76, 12),
    ]}],
    expected: { firstName: 'Delia', lastName: 'Salviati', companyContains: 'Bicego', role: 'Responsabile area' },
  },
  {
    name: 'QA Inter-Nos address dedupe',
    pages: [{ rawText: '', lines: [
      L('Inter-Nos 2 S.a.s. di Rampon Claudio & C', 30, 14),
      L('Claudio Rampon', 48, 14),
      L('Vicolo Ottone Calderari, 6/D', 120, 12),
      L('36014 Santorso (VI)', 136, 12),
    ]}],
    expected: { addressContains: '36014 Santorso', addressNotContains: '36014 Santorso (VI) - 36014' },
  },
  {
    name: 'QA Gino Carretta S.r.l legal-only fix',
    pages: [{ rawText: '', lines: [
      L('Gino Carretta', 40, 18),
      L('S.r.l', 62, 12),
      L('Via Firenze, 5', 120, 12),
      L('Villaverla (VI)', 136, 12),
    ]}],
    expected: { firstName: 'Gino', lastName: 'Carretta', companyContains: 'Gino Carretta' },
  },
  {
    name: 'QA CEO INFODATI strip role prefix',
    pages: [{ rawText: '', lines: [
      L('CEO - INFODATI S.p.A', 40, 16),
      L('Fiuppo De Guio', 60, 14),
      L('P.IVA 02075900247', 180, 12),
    ]}],
    expected: { companyContains: 'INFODATI', companyNot: 'CEO - INFODATI', vatNumber: '02075900247' },
  },
  {
    name: 'QA AUTOTECHO P.I VAT',
    pages: [{ rawText: '', lines: [
      L('AUTOTECHO S.r.l', 40, 16),
      L("Via dell'Industria, 44", 120, 12),
      L('36015 Schio (VI)', 136, 12),
      L('P.I 03876570247', 180, 12),
    ]}],
    expected: { companyContains: 'AUTOTECHO', vatNumber: '03876570247' },
  },
  {
    name: 'QA Peltrera dom fisc vs operational',
    pages: [{ rawText: '', lines: [
      L('Peltrera Rappresentanze', 40, 14),
      L('Daniele Peltrera', 58, 14),
      L('Dom. Fisc.: 30034 Borbiago Di Mira (Ve)', 100, 12),
      L('Via Trento, 8/A', 120, 12),
    ]}],
    expected: { companyContains: 'Peltrera', addressContains: 'Via Trento', addressNotContains: 'Dom. Fisc' },
  },
  {
    name: 'QA Francesca Gili role OCR break',
    pages: [{ rawText: '', lines: [
      L('GILI CREATIONS', 40, 16),
      L('S.r.l', 58, 12),
      L('Francesca Gili', 76, 14),
      L('administra tion manager', 94, 12),
    ]}],
    expected: { role: 'Administration manager', companyContains: 'GILI' },
  },
  {
    name: 'QA Bfinfissipvc city line merge',
    pages: [{ rawText: '', lines: [
      L('SERRAMENTI', 40, 14),
      L('SCHIO (VI)', 72, 12),
      L('vicolo Valsesia, 5', 90, 12),
    ]}],
    expected: { addressContains: 'Valsesia', addressContains2: 'Schio', addressContains3: 'VI' },
  },
  {
    name: 'QA PVA Gomme city line merge',
    pages: [{ rawText: '', lines: [
      L("Via dell'Industria, 44", 90, 12),
      L('SCHIO (VI)', 108, 12),
    ]}],
    expected: { addressContains: 'Industria', addressContains2: 'Schio', addressContains3: 'VI' },
  },
  {
    name: 'QA address dedupe Thiene Kolbe',
    pages: [{ rawText: '', lines: [
      L('Via S. M. Kolbe, 2', 120, 12),
      L('36016 Thiene (VI)', 136, 12),
    ]}],
    expected: {
      addressContains: 'Kolbe',
      addressContains2: '36016',
      addressNotContains: '36016 Thiene (VI), Nr. 2',
    },
  },
  {
    name: 'QA address dedupe Arsiero',
    pages: [{ rawText: '', lines: [
      L('Via Collegio, 1', 120, 12),
      L('36011 Arsiero (VI)', 136, 12),
    ]}],
    expected: { addressContains: 'Collegio', addressNotContains: '36011 - Arsiero - 36011' },
  },
  {
    name: 'QA Dolphin split via OCR (rotated scan)',
    pages: [{ rawText: '', lines: [
      L('DOLPHIN', 20, 18),
      L('Software & ThinkWare', 38, 12),
      L('Alessandro Villa', 56, 14),
      L('e-mail avilla@dolphin it', 74, 12),
      L('mobile: +39.348 0112610', 92, 12),
      L('Arsenale, 4', 110, 12),
      L('24040 BONATE SOTTO (BG)', 124, 12),
      L('Tel. 035 494 3081', 138, 12),
      L('Dolphin Srl', 152, 12),
      L('Via Vittorio Veneto, 2', 166, 12),
      L('Fax 035 509 5548', 180, 12),
      L('10064 PINEROLO (TO)', 194, 12),
      L('Via', 208, 10),
      L('Tel 0121.393 163', 222, 12),
    ]}],
    expected: {
      companyContains: 'Dolphin',
      firstName: 'Alessandro',
      lastName: 'Villa',

      addressNotContains: 'Via - 10064',
      addressContains: '10064',
    },
  },
  {
    name: 'QA address format schema IT',
    pages: [{ rawText: '', lines: [
      L('Via Montello, 22', 120, 12),
      L('36016 Thiene (VI)', 136, 12),
    ]}],
    expected: {
      addressContains: 'Via Montello, Nr. 22 - 36016 - Thiene - (VI) - IT',
      addressNotContains: 'Thiene - VI - IT',
    },
  },
  {
    name: 'QA Wise Pesenti address from via line',
    pages: [{ rawText: '', lines: [
      L('Alessandro Pesenti', 40, 16),
      L('pesenti.alessandro@wiseingegneria.it', 58, 12),
      L('24060 Brusaporto (BG) Italy', 120, 12, 0),
      L('Wise Ingegneria', 120, 14, 0),
      L('via Artigiani, 22', 136, 12, 0),
      L('e Soluzioni Software S.r.l.', 100, 12, 300),
    ]}],
    expected: {
      companyContains: 'Wise',
      addressContains: 'Artigiani',
      addressContains2: '24060',
    },
  },
  {
    name: 'Technical Touch Belgium (no person, e-mail label)',
    pages: [{ rawText: '', lines: [
      L('KYB', 20, 30),
      L('SUSPENSION SERVICE CENTER', 50, 12),
      L('HINSON', 70, 14),
      L('EUROPEAN DISTRIBUTOR', 86, 12),
      L('TECHNICAL TOUCH bvba', 110, 16),
      L('1Z Kristalpark - Ondernemersstraat 20 - 3920 Lommel (Belgium)', 130, 12),
      L('Tel. 0032-11-54.96.96 - Fax 0032-11-54.9697', 148, 12),
      L('e-mail. info@technical-touch.comn - www.technical-touch.com', 166, 12),
      L('BTW BE 0446.450.220 - RPR Hasselt', 184, 12),
    ]}],
    expectEmpty: ['firstName', 'lastName'],
    expected: {
      companyContains: 'TECHNICAL TOUCH',
      emailsContain: 'info@technical-touch.com',
      websiteContains: 'technical-touch.com',
      addressContains: 'Lommel',
    },
  },
  {
    name: 'CTS membership card labeled cognome/nome',
    pages: [{ rawText: '', lines: [
      L('Membership Card 2003', 10, 14),
      L('Cognome - Family name', 30, 12),
      L('CHIOZZA', 46, 14),
      L('Nome - First Names', 62, 12),
      L('GI0VANHI', 78, 14),
      L('Data di nascita - Born', 94, 12),
      L('Sede emittente - Issuing office', 110, 12),
      L('01/01/1957', 126, 12),
      L('R51', 142, 12),
      L('03244323', 158, 12),
      L('Firma - Signature', 174, 12),
      L('Card n.', 190, 12),
      L('Centro Turistico StudentescO e Giovanile', 210, 14),
      L('Presidenza Nazionale via A. Vesalio, 6 - 00161 Roma', 230, 12),
    ]}],
    expected: {
      firstName: 'Giovanni',
      lastName: 'Chiozza',
      companyContains: 'Centro Turistico',
      addressContains: 'Vesalio',
      addressContains2: '00161',
    },
  },
  {
    name: 'SAMTEX Korea dual office addresses',
    pages: [{ rawText: '', lines: [
      L('SAMTEX', 20, 30),
      L('Chester Seo', 55, 16),
      L('Managing Director', 72, 12),
      L('CEL:010-9945-5205', 88, 12),
      L('E-mal : chesterseo@samtex.org', 104, 12),
      L('Revolutionary fabrics', 120, 12),
      L('HEAD OFFICE:', 150, 12),
      L('Nex Center 407, SK @ Technopark,', 166, 12),
      L('190-1,Sangdaewon -Dong, Jungwon -Ku', 182, 12),
      L('Seongnam City, Kyunggi -Do, Korea', 198, 12),
      L('TEL:82-31 -776-0931 (Rep)', 214, 12),
      L('FAX: 82-31-776-0977', 230, 12),
      L('DAEGU OFFICE:', 250, 12),
      L('Room #302,976-8 Galsan-dong, Dalseo-gu,', 266, 12),
      L('daegu Metropolitan City, Korea', 282, 12),
      L('TEL: 82-53-356-0931', 298, 12),
      L('FAX : 82- 53-356-0932', 314, 12),
      L('http://www.samtex.co.kr', 330, 12),
    ]}],
    expected: {
      firstName: 'Chester',
      lastName: 'Seo',
      companyContains: 'samtex',
      roleContains: 'Managing Director',
      addressContains: 'Room #302',
      addressNotContains: 'TEL',
    },
  },
  {
    name: 'Orientaform snc from CF line',
    pages: [{ rawText: '', lines: [
      L('OrientaForm', 20, 16),
      L('formazione@orientaform.it', 40, 12),
      L('www.orientaform.it', 56, 12),
      L('Formazione e Orientamento', 72, 12),
      L('OrientoForm snc CF /PNA 03674360247 Loc Ponte d\'oro 8/E Schio (VI)', 100, 12),
    ]}],
    expected: {
      companyContains: 'Orientaform',
      emailsContain: 'formazione@orientaform.it',
    },
  },
  {
    name: 'Servoy Arata role not address',
    pages: [{ rawText: '', lines: [
      L('ServOV Next Generation Platform', 20, 14),
      L('Enrico Arata', 38, 16),
      L('Corso Massimo d\'Azeglio, 8', 56, 12),
      L('Responsabile Servoy Italia', 72, 12),
      L('direct tel +39 335 29 59 65', 88, 12),
      L('earataaservoy com', 104, 12),
      L('www.servoy.com', 120, 12),
    ]}],
    expected: {
      firstName: 'Enrico',
      lastName: 'Arata',
      companyContains: 'Serv',
      roleContains: 'Responsabile',
      websiteContains: 'servoy.com',
    },
  },
  {
    name: 'Themis from domain not www OCR',
    pages: [{ rawText: '', lines: [
      L('Potonio Gaboardk', 20, 16),
      L('Senior Partner', 38, 12),
      L('agaboardi@thenissoluzioni it', 54, 12),
      L('www themissoluzioni it', 70, 12),
    ]}],
    expected: {
      firstName: 'Potonio',
      lastName: 'Gaboardk',
      roleContains: 'Partner',
    },
  },
  {
    name: 'CTS G10VARRI membership nome',
    pages: [{ rawText: '', lines: [
      L('Cognome - Family name', 20, 12),
      L('CHIOZZA', 36, 14),
      L('Nome - First Names', 52, 12),
      L('G10VARRI', 68, 14),
      L('Centro Turistico Studentesco e Giovanile', 100, 14),
      L('Presidenza Nazionale via A. Vesalio, 6 - 00161 Roma', 120, 12),
    ]}],
    expected: {
      firstName: 'Giovanni',
      lastName: 'Chiozza',
      companyContains: 'Centro Turistico',
      addressContains: 'Vesalio',
    },
  },
  {
    name: 'MIP Filippo Renga (città OCR non cognome)',
    pages: [{ rawText: '', lines: [
      L('POLITECNICO DI MILANO', 20, 14),
      L('Filippo', 50, 14),
      L('MILANO', 66, 12),
      L('Renga', 82, 14),
      L('Via Lambruschini, 4b ed. 26B - 20156 Milano', 110, 12),
      L('MIP', 130, 14),
      L('filippo.renga@polimi.it', 148, 11),
    ]}],
    expected: { firstName: 'Filippo', lastName: 'Renga', companyContains: 'POLITECNICO DI MILANO' },
  },
  {
    name: 'Venetoavvocati studio legale (non dominio)',
    pages: [{ rawText: '', lines: [
      L('STUDIO LEG ALE A SS OCIATO', 20, 14),
      L('MONDIN-CAMPESAN:URBANIMESSURI', 38, 12),
      L('Avy. Paolo Dal Soglio', 56, 14),
      L('info@venetoavvocati.it', 74, 11),
      L('36015 SCHIO (VI)-Pza Statuto, 25', 92, 11),
    ]}],
    expected: { firstName: 'Paolo', lastNameContains: 'Soglio', companyContains: 'Studio Legale' },
  },
  {
    name: 'DERGA GMBH (brand vs forma giuridica)',
    pages: [{ rawText: '', lines: [
      L('DERGA', 30, 22),
      L('STEFANO PASIN', 58, 14),
      L('GMBH SRL', 76, 12),
      L('stetano.pasin@derga.it', 94, 11),
      L('Padova: Via E. P. Masini, 8 - 35131 Padova', 112, 11),
    ]}],
    expected: { firstName: 'Stefano', lastName: 'Pasin', companyContains: 'DERGA' },
  },
  {
    name: 'Domofacile Daniela Gavasso',
    pages: [{ rawText: '', lines: [
      L('Domofacile', 30, 20),
      L('GAVASSO', 58, 14),
      L('dgavasso@domofacile.com', 76, 11),
      L('348.2655838 DANIELA', 94, 12),
    ]}],
    expected: { firstName: 'Daniela', lastName: 'Gavasso', companyContains: 'Domofacile' },
  },
  {
    name: 'Domofacile Daniela Gavasso (OCR cognome = frammento brand)',
    pages: [{ rawText: '', lines: [
      L('DOMOfacile', 24, 22),
      L('Daniela Ofacile', 58, 16),
      L('348.2655838', 76, 11),
      L('dgavasso@domofacile.com', 94, 11),
      L('mofacile s.r.l. Societa Unipersonale Sede Legale: 36040 Torri di Quartesolo (VI) Via Roma 137', 112, 9),
    ]}],
    expected: { firstName: 'Daniela', lastName: 'Gavasso', companyContains: 'Domofacile' },
  },
  {
    name: 'Domofacile Daniela Gavasso (riga unica maiuscola)',
    pages: [{ rawText: '', lines: [
      L('DOMOfacile', 24, 22),
      L('IL MERCATO IMMOBILIARE È DOMOfacile', 42, 10),
      L('DANIELA GAVASSO', 58, 16),
      L('dgavasso@domofacile.com', 76, 11),
      L('348 255 5838', 94, 11),
      L('www.domofacile.it', 112, 10),
    ]}],
    expected: { firstName: 'Daniela', lastName: 'Gavasso', companyContains: 'Domofacile' },
  },
  {
    name: 'Mirco Bettelini (nome grande, info@bette.it)',
    pages: [{ rawText: '', lines: [
      L('Mirco Bettelini', 24, 18),
      L('iOS Developer', 42, 12),
      L('Via Grazia Deledda 4', 58, 11),
      L('37060 Palazzolo (Vr) ITALY', 72, 11),
      L('info@bette.it', 86, 11),
      L('www.bette.it', 100, 10),
    ]}],
    expected: { firstName: 'Mirco', lastName: 'Bettelini', companyContains: 'Bette' },
  },
  {
    name: 'Massimiliano Ceglio I3P (tagline vs S.c.p.a.)',
    pages: [{ rawText: '', lines: [
      L('Massimiliano Ceaglio', 24, 16),
      L('Senior Consultant', 42, 12),
      L('Incubatore', 56, 11),
      L('Imprese', 68, 10),
      L('Innovative', 80, 10),
      L('Politecnico', 92, 10),
      L('Torino', 104, 10),
      L('ceaglio@i3p.it', 118, 11),
      L('www.i3p.it', 132, 10),
      L('I3P S.c.p.a. Corso Castelfidardo 30/A, 10129 Torino', 146, 10),
    ]}],
    expected: { firstName: 'Massimiliano', lastName: 'Ceaglio', companyContains: 'I3P' },
  },
  {
    name: 'Tuglak (email hosting cyber.net, brand TMI)',
    pages: [{ rawText: '', lines: [
      L('Manufacturers, Importers & Exporters', 20, 10),
      L('TUGLAI', 34, 18),
      L('TMI', 50, 16),
      L('MOTORBIKP ND.', 64, 12),
      L('M. Ashraf Tuglak', 78, 14),
      L('Managing Partner', 92, 12),
      L('tuglak@cyber.net', 106, 11),
      L('www.kiveracing.com', 120, 10),
    ]}],
    expected: { firstNameContains: 'Ashraf', lastName: 'Tuglak', companyContains: 'Tmi' },
  },
  {
    name: 'Tuglak (brand card, non dominio email)',
    pages: [{ rawText: '', lines: [
      L('TUGLAS', 30, 22),
      L('TMIMOTORBIKE IND.', 58, 12),
      L('M. Ashraf Tuglak', 76, 14),
      L('Managing Partner', 94, 12),
      L('tuglak@cyber.net.pk', 112, 11),
      L('1km, Aimnabad Road, Tuglak Street, Sialkot - 51310-Pakistan.', 130, 11),
    ]}],
    expected: { firstNameContains: 'Ashraf', lastName: 'Tuglak', companyContains: 'Tuglak' },
  },
  {
    name: 'QA audit Ponzoni (Dirigente non è company)',
    pages: [{ rawText: '', lines: [
      L('Andrea Ponzoni', 20, 16),
      L('Dirigente', 38, 12),
      L('Responsabile Servizio informatica', 54, 12),
      L('Istituto Zooprofilattico Sperimentale delle Venezie', 72, 12),
      L('aponzoni@izsvenezie.it', 90, 11),
      L('Viale dell Università 10 - 35020 Legnaro (PD)', 108, 11),
    ]}],
    expected: {
      firstName: 'Andrea',
      lastName: 'Ponzoni',
      companyContains: 'Zooprofilattico',
      roleContains: 'Dirigente',
      companyNotContains: 'Dirigente',
    },
  },
  {
    name: 'QA audit Bandolin ICM (lista città non è company)',
    pages: [{ rawText: '', lines: [
      L('ICM.S', 20, 18),
      L('Diego Bandolin', 38, 14),
      L('President', 54, 12),
      L('ICM.S S.r.l.', 72, 12),
      L('Via Pacinotti, 1 - Centro Kennedy', 90, 11),
      L('31020 Villorba (TV)', 106, 11),
      L('diego.bandolin@icms.it', 122, 11),
      L('www.icms.it', 138, 10),
      L('TREVISO MILANO PADOVA BOLOGNA ROMA FIRENZE', 160, 10),
    ]}],
    expected: {
      firstName: 'Diego',
      lastName: 'Bandolin',
      companyContains: 'ICM',
      companyNotContains: 'Treviso',
      addressContains: 'Villorba',
    },
  },
  {
    name: 'QA audit Grigoli InformEtica (Gold badge non è company)',
    pages: [{ rawText: '', lines: [
      L('SAP Gold Partner', 20, 12),
      L('Andrea Grigoli', 38, 14),
      L('Amministratore Unico', 54, 12),
      L('andrea.grigoli@informeticons.com', 72, 11),
      L('InformEtica Consulting s.r.l.', 90, 12),
      L('Viale del Lavoro, 33 - 37036 San Martino Buon Albergo (VR)', 108, 11),
    ]}],
    expected: {
      firstName: 'Andrea',
      lastName: 'Grigoli',
      companyContains: 'InformEtica',
      companyNotContains: 'Gold',
    },
  },
  {
    name: 'QA audit OrientaForm (slogan non è persona)',
    pages: [{ rawText: '', lines: [
      L('OrientaForm', 20, 16),
      L('formazione@orientaform.it', 38, 11),
      L('Formazione e Orientamento', 54, 12),
      L('OrientoForm snc CF 03674360247 Loc Ponte d\'oro 8/E Schio (VI)', 72, 11),
    ]}],
    expectEmpty: ['firstName', 'lastName'],
    expected: {
      companyContains: 'Orientaform',
      emailsContain: 'formazione@orientaform.it',
    },
  },
  {
    name: 'QA audit Gaboardi (OCR↔email conservativo)',
    pages: [{ rawText: '', lines: [
      L('Potonio Gaboardk', 20, 14),
      L('Senior Partner', 38, 12),
      L('agaboardi@thenissoluzioni.it', 72, 11),
      L('Via F. Lana 1 - 25020 Flero (BS)', 90, 11),
      L('www.thenissoluzioni.it', 108, 10),
    ]}],
    expected: {
      firstName: 'Potonio',
      lastName: 'Gaboardk',
      companyContains: 'soluzioni',
    },
  },
  {
    name: 'QA audit Jaspersoft (indirizzo personale vs uffici globali)',
    pages: [
      { rawText: '', lines: [
        L('Evanna Kearins', 20, 14, 0),
        L('Director Marketing, EMEA', 36, 12, 0),
        L('ekearins@jaspersoft.com', 52, 11, 0),
        L('Digital Court', 68, 11, 0),
        L('Rainsford Street', 82, 11, 0),
        L('Dublin 8, Ireland', 96, 11, 0),
      ]},
      { rawText: '', lines: [
        L('Jaspersoft GmbH', 20, 12, 1),
        L('3 rue du Colonel Moll', 36, 11, 1),
        L('60322 Frankfurt', 50, 11, 1),
        L('San Francisco CA 94103 USA', 64, 11, 1),
      ]},
    ],
    expected: {
      firstName: 'Evanna',
      lastName: 'Kearins',
      companyContains: 'Jaspersoft',
      addressCityContains: 'Dublin',
      addressNotContains: 'Frankfurt',
      addressNotContainsAny: ['Frankfurt', 'San Francisco', 'Paris', '60322', 'Rhode Island'],
    },
  },
  {
    name: 'QA audit Maxicarta (OCR reale multi-sede, sede operativa)',
    pages: [{ rawText: '', lines: [
      L('maxiearta..', 20, 18),
      L('Renato Plesnicar', 38, 14),
      L('Delegato alle vendite', 54, 12),
      L('cell. 3381051640', 70, 11),
      L('Sede operativa:', 86, 11),
      L('Sede legale', 100, 11),
      L('Via lll Armata, 123', 114, 11),
      L('Via Garzarolli, 197/199', 128, 11),
      L('Tel. 0481.20831 - Fax 0481.21516', 142, 11),
      L('34170 - GORIZIA', 156, 11),
      L('34170 - GORIZIA', 170, 11),
      L('maxicarta@maxicarta.it', 184, 11),
    ]}],
    expected: {
      firstName: 'Renato',
      lastName: 'Plesnicar',
      companyContains: 'arta',
      addressContains: 'Armata',
      addressContains2: '34170',
      addressContains3: 'Gorizia',
      addressNotContains: 'Garzarolli',
    },
  },
  {
    name: 'QA audit Dorigo ICM (fronte/retro, Prato non è company)',
    pages: [
      { rawText: '', lines: [
        L('Alfio Dorigo', 20, 14, 0),
        L('ICM.S', 36, 12, 0),
        L('Sales Executive', 52, 12, 0),
        L('alfio.dorigo@icms.it', 68, 11, 0),
        L('Via A. Pacinotti 1', 84, 11, 0),
        L('Centro Kennedy', 98, 11, 0),
        L('31020 Villorba (TV) - Italy', 112, 11, 0),
        L('TREVISO', 140, 10, 0),
        L('MILANO', 154, 10, 0),
        L('PADOVA', 168, 10, 0),
        L('BOLOGNA', 182, 10, 0),
        L('ROMA', 196, 10, 0),
        L('PRATO', 210, 10, 0),
      ]},
      { rawText: '', lines: [
        L('ICM.S', 20, 12, 1),
        L('Global Enterprise Solutions', 36, 11, 1),
        L('Sede legale e amministrativa:', 52, 11, 1),
        L('Via A. Pacinotti 1 - Centro Kennedy - 31020 Villorba (TV) - Italy', 66, 11, 1),
        L('Tel. +39 0422 618624', 80, 11, 1),
      ]},
    ],
    expected: {
      firstName: 'Alfio',
      lastName: 'Dorigo',
      companyContains: 'ICM',
      companyNotContains: 'Prato',
      addressContains: 'Villorba',
      addressContains2: 'Pacinotti',
    },
  },
  {
    name: 'QA audit Jaspersoft OCR reale (single page, solo Dublin)',
    pages: [{ rawText: '', lines: [
      L('Evanna Kearins', 20, 14),
      L('Director Marketing, EMEA', 36, 12),
      L('ekearins@jaspersoft.com', 52, 11),
      L('JASPERSOFT', 66, 12),
      L('Digital Court', 80, 11),
      L('350 Rhode Island St. - Ste #250', 94, 11),
      L('Rainsford Street', 108, 11),
      L('San Francisco', 122, 11),
      L('Dublin 8', 136, 11),
      L('CA 94103', 150, 11),
      L('Ireland', 164, 11),
      L('USA', 178, 11),
      L('Jaspersoft GmbH', 192, 12),
      L('3 rue du Colonel Moll', 206, 11),
      L('60322 Frankfurt', 220, 11),
    ]}],
    expected: {
      firstName: 'Evanna',
      lastName: 'Kearins',
      companyContains: 'Jaspersoft',
      addressCityContains: 'Dublin',
      addressNotContainsAny: ['Frankfurt', 'San Francisco', 'Paris', '60322', 'Rhode Island'],
    },
  },
  {
    name: 'BLOCKED: Maurizio Lain (OCR reale mancante)',
    skip: true,
    skipReason: 'sostituito da ITER4 Lain (OCR reale export 13/07)',
    pages: [{ rawText: '', lines: [] }],
    expected: {},
  },
  {
    name: 'ITER4 Domofacile Gavasso (OCR reale export 13/07)',
    pages: [{ rawText: '', lines: [
      L('IL MERCATO IMMOBILIA', 20, 12),
      L('Llfacile È DOMO/acile', 36, 11),
      L('IL RESTOÈ DIFFICILE', 52, 14),
      L('dgavasso@domofacile.com', 68, 11),
      L('Daniela Gavasso', 84, 14),
      L('www.domofacile.it', 100, 11),
    ]}],
    expected: {
      firstName: 'Daniela',
      lastName: 'Gavasso',
      companyContains: 'Domofacile',
      companyNotContains: 'DIFFICILE',
    },
  },
  {
    name: 'ITER4 Ponzoni IZS (OCR reale export 13/07)',
    pages: [{ rawText: '', lines: [
      L('Andrea Ponzoni', 20, 16),
      L('etituto Zooprofilattico', 36, 12),
      L('Dirigente', 50, 12),
      L('Sperimentale delle Venezie', 64, 11),
      L('Istituto Zooprofilattico Sperimnentale delle Venezie', 78, 11),
      L('aponzoni@izsvenezie.it', 94, 11),
      L('skype: Andrea Ponzoni www.izsvenezie.it', 108, 11),
    ]}],
    expected: {
      firstName: 'Andrea',
      lastName: 'Ponzoni',
      companyContains: 'Zooprofilattico',
      companyNotContains: 'skype',
      companyNotContains2: 'Dirigente',
    },
  },
  {
    name: 'ITER4 Lain Supersolar (OCR reale export 13/07)',
    pages: [{ rawText: '', lines: [
      L('Super Slar', 20, 14),
      L('Solar Energy Group Sp.A', 36, 12),
      L('MAURIZIO LAIN', 52, 14),
      L('cONSULENTE TECNICO', 68, 11),
      L('Agenzia Generale Vicenza di Fabbrizio Rita', 84, 11),
      L('e-mail. rita fabbrizio@supersolar it', 100, 11),
    ]}],
    expected: {
      firstName: 'Maurizio',
      lastName: 'Lain',
      companyContains: 'Solar',
    },
  },
  {
    name: 'ITER4 DERGA Stefano (OCR reale export 13/07)',
    pages: [{ rawText: '', lines: [
      L('DERGA', 30, 22),
      L('stetano.pasin@derga.it', 50, 11),
      L('STEFANO PASIN', 66, 14),
      L('Partner:', 80, 11),
    ]}],
    expected: {
      firstName: 'Stefano',
      lastName: 'Pasin',
      companyContains: 'DERGA',
    },
  },
  {
    name: 'ITER4 Tuglak (OCR_LIMITATION, no persona inventata)',
    pages: [{ rawText: '', lines: [
      L('TUGLAK', 20, 18),
      L('TMIMOTORBIKE ND.', 38, 12),
      L('M. AshrafTuglak', 54, 14),
      L('tuglak@cyber.net.pk', 90, 11),
    ]}],
    expectEmpty: ['firstName', 'lastName'],
    expected: {
      companyContains: 'Tuglak',
    },
  },
  {
    name: 'QA audit Corvallis (cognome non è città)',
    pages: [{ rawText: '', lines: [
      L('Corvallis S.p.A. a Socio Unico', 20, 12),
      L('Pierluigi Valenti', 38, 14),
      L('Via G. Savelli 56 - 35129 Padova', 56, 11),
      L('pierluigi.valenti@corvallis.it', 72, 11),
    ]}],
    expected: {
      firstName: 'Pierluigi',
      lastName: 'Valenti',
      companyContains: 'Corvallis',
      addressContains: 'Padova',
      addressNotContains: 'Valenti',
    },
  },
  {
    name: 'QA audit Dal Soglio (Avv. non nel nome)',
    pages: [{ rawText: '', lines: [
      L('Studio Legale Associato Mondin-Campesan-Urbani-Messuri', 20, 12),
      L('Avv. Paolo Dal Soglio', 38, 14),
      L('info@venetoavvocati.it', 56, 11),
      L('36015 Schio (VI) Pza Statuto 25', 74, 11),
    ]}],
    expected: {
      firstName: 'Paolo',
      lastNameContains: 'Soglio',
      firstNameNotContains: 'Avy',
      companyContains: 'Studio Legale',
    },
  },
  {
    name: 'SHIELD SOLEHRE Brothers (OCR reale 13/07)',
    pages: [{ rawText: '', lines: [
      L('ySHIELD', 20, 28),
      L('QAISER AKRAM', 48, 16, 280),
      L('Business Development Director', 66, 12, 280),
      L('MOTORBIKE GLOVES', 36, 12),
      L('9+92-300-871 1104', 82, 11, 280),
      L('SOLEHRE BROTHERS INDUSTRIES', 100, 16),
      L('info@shieldmoto.com', 118, 11, 280),
      L('12-KM Daska Road,', 136, 11),
      L('Mahabat Khan Industrial Estate,', 152, 11),
      L('Qaiserashieldmoto.com', 168, 11),
      L('Sialkot -51310 Pakistan.', 184, 11),
      L('Gloves@shieldmoto. com', 200, 11, 280),
      L('+92 52 352 4181', 216, 11),
      L('https://shieldmoto.com', 232, 11, 280),
    ]}],
    expected: {
      firstName: 'Qaiser',
      lastName: 'Akram',
      role: 'Business Development Director',
      companyContains: 'SOLEHRE BROTHERS INDUSTRIES',
      companyNotContains: 'MOTORBIKE GLOVES',
      addressContains: 'Daska Road',
      addressContains2: 'Pakistan',
      addressNotContains: 'shieldmoto',
      websiteContains: 'shieldmoto.com',
    },
  },
  {
    name: 'CYPRO SPORTS Luqman Iqbal (OCR reale 13/07)',
    pages: [{ rawText: '', lines: [
      L('CYPRO', 20, 28),
      L('SPORTS', 48, 12),
      L('Lugman S.lqbal /Managing Director', 68, 16),
      L('Development Manufacturer e Since 1984', 88, 11),
      L('Motorbike Garments I Gloves I Boots', 104, 11),
      L('CYPRO SPORTS', 124, 18),
      L('P.O Box 222, Pasrur Road,', 144, 11),
      L('Dheera Sandha, 51310 Sialkot.', 160, 11),
      L('Mobile +92 300 8616222', 176, 11),
      L('lugman@cypro-sports.com', 192, 11),
      L('www.cypro-sports.com', 208, 11),
    ]}],
    expected: {
      firstNameContains: 'ugman',
      lastName: 'Iqbal',
      role: 'Managing Director',
      companyContains: 'CYPRO SPORTS',
      emailContains: 'lugman@cypro-sports.com',
    },
  },
  {
    name: 'ATROX Asim Nayyer (OCR reale 13/07)',
    pages: [
      { rawText: '', lines: [
        L('Asim Nayyer', 20, 16),
        L('(CEO )', 38, 11),
        L('Inspire the Neát', 52, 11),
        L('+92-333-8609110', 68, 11),
        L('+92-52-6523488 / 6523499', 84, 11),
        L('asim.nayyer', 100, 11),
        L('asim@atrox. pk', 116, 11),
        L('www.atrox-gear.com', 132, 11),
        L('Scan Me', 148, 10),
      ]},
      { rawText: '', lines: [
        L('Inspire the Next', 20, 11),
        L('P.O. Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan', 40, 14),
        L('www.atrox-gear.com', 60, 12),
      ]},
    ],
    expected: {
      firstName: 'Asim',
      lastName: 'Nayyer',
      roleContains: 'CEO',
      companyContains: 'ATROX',

      emailsNotContain: 'nayyer@',
      websiteContains: 'atrox-gear.com',
      addressContains: 'Sambrial Road',
      addressContains2: 'Pakistan',
    },
  },
  {
    name: 'ELEONE Romain Chidekh (OCR reale 13/07)',
    pages: [{ rawText: '', lines: [
      L('ELECDE', 20, 28),
      L('Romain CHIDEKH - SALES', 48, 16),
      L('ELEONE SEWING CORP.', 68, 14),
      L('47, Crs Gambetta I Aix en Pce - France I 13100', 88, 12),
      L('+33-781-137-589', 104, 11),
      L('www.eleone.co', 120, 11),
      L('romain@eleone.co', 136, 11),
    ]}],
    expected: {
      firstName: 'Romain',
      lastName: 'Chidekh',
      roleContains: 'Sales',
      companyContains: 'ELEONE SEWING',
      emailContains: 'romain@eleone.co',
      websiteContains: 'eleone.co',
      addressContains: 'Gambetta',
      addressContains2: 'France',
    },
  },
  {
    name: 'Serenissima Filippo Filippi multi-page (QA iter8)',
    pages: [
      { rawText: '', lines: [
        L('SERENISSIMA', 20, 16),
        L('Filippo Filippi', 48, 14),
        L('Agente di Vendita PMI', 64, 11),
        L('filippo.filippi@serinf. it', 80, 11),
      ]},
      { rawText: '', lines: [
        L('Microsoft', 20, 12),
        L('GOLD CERTIFIED', 36, 12),
        L('Partner', 52, 11),
        L('Serenissima Informatica SpA', 68, 14),
        L('Via Croce Rossa, 5 - 35129 Padova PD - Italy', 84, 12),
      ]},
    ],
    expected: {
      firstName: 'Filippo',
      lastName: 'Filippi',
      companyContains: 'Serenissima',

    },
  },
  {
    name: 'Schinasi Insurance Brokers badge (QA iter8)',
    pages: [{ rawText: '', lines: [
      L('Stefano Ruberti', 20, 14),
      L('SCHINASI', 36, 14),
      L('INSURANCE BROKERS', 52, 12),
      L('Account Executive', 68, 11),
      L('stefano.ruberti@schinasi.it', 84, 11),
      L('Schinasi Insurance Brokers S.r.l.', 100, 12),
    ]}],
    expected: {
      firstName: 'Stefano',
      lastName: 'Ruberti',
      companyContains: 'Schinasi',
      emailContains: 'stefano.ruberti@schinasi.it',
    },
  },
  {
    name: 'Carrozzeria Cristallo di owner + CF OCR (QA iter8)',
    pages: [{ rawText: '', lines: [
      L('CARROZzZERIA', 20, 16),
      L('CRISTALLO', 36, 14),
      L('di De Rossi Romeo Emilio', 52, 12),
      L('Via Croce, 5836033 Isola Vicentina', 68, 12),
      L('Tel. 0444 975669', 84, 11),
      L('P.J. 01238380248IC.F. DRSRML58E27E864N', 100, 11),
      L('carr_cristallo@libero.it', 116, 11),
    ]}],
    expected: {
      firstName: 'Romeo Emilio',
      lastName: 'De Rossi',
      companyContains: 'Carrozz',
      taxCode: 'DRSRML58E27E864N',
      vatNumber: '01238380248',
      emailContains: 'carr_cristallo@libero.it',
    },
  },
  {
    name: 'ITER9 Jaspersoft OCR reale (OJAS PERSOFT ≠ persona)',
    pages: [{ rawText: '', lines: [
      L('Jaspersoft Ltd', 20, 12),
      L('Jaspersoft Corporation', 36, 11),
      L('Digital Court', 52, 11),
      L('Rainsford Street', 68, 11),
      L('Dublin 8', 82, 11),
      L('Ireland', 96, 11),
      L('www.jaspersoft.com', 110, 10),
      L('Evanna Kearins', 130, 14),
      L('Director Marketing, EMEA', 146, 12),
      L('ekearins@jaspersoft.com', 162, 11),
      L('OJAS PERSOFT', 178, 12),
      L('+353 87 289 6579', 194, 11),
    ]}],
    expected: {
      firstName: 'Evanna',
      lastName: 'Kearins',
      companyContains: 'Jaspersoft',
      emailContains: 'ekearins@jaspersoft.com',
      addressCityContains: 'Dublin',
      firstNameNotContains: 'Ojas',
    },
  },
  {
    name: 'ITER9 Tuglak OCR reale export (no TMIMOTORBIKE persona)',
    pages: [{ rawText: '', lines: [
      L('Manutacturers, Importers &Epornters', 20, 11),
      L('TUGLAK', 36, 14),
      L('TMIMOTORBIKE ND.', 52, 12),
      L('M. AshrafTuglak', 68, 14),
      L('Managing Partner', 84, 11),
      L('tuglak@cyber.net.pk', 100, 11),
      L('www.kiveracing.com', 116, 10),
    ]}],
    expected: {
      firstNameContains: 'Ashraf',
      lastName: 'Tuglak',
      companyContains: 'Tuglak',
      firstNameNotContains: 'Tmimotorbike',
      lastNameNotContains: 'Nd',
    },
  },
  {
    name: 'ITER9 Boston University Katie (no Ersitas Boston)',
    pages: [{ rawText: '', lines: [
      L('Boston University', 20, 14),
      L('Division of Extended Education', 36, 12),
      L('ERSITAS BOSTON', 52, 12),
      L('Metropolitan College', 68, 12),
      L('755 Commonwealth Avenue', 84, 11),
      L('Boston, Massachusetts 02215', 100, 11),
      L('Katie L. Pasciucco', 116, 14),
      L('Admissions & Outreach Coordinator', 132, 11),
    ]}],
    expected: {
      firstName: 'Katie',
      lastNameContains: 'Pasciucco',
      companyContains: 'Boston University',
      companyNotContains: 'Katiepebu',
      firstNameNotContains: 'Ersitas',
    },
  },
  {
    name: 'ITER9 Exhaust System (brand ≠ persona, MOSCATELLI visibile)',
    pages: [{ rawText: '', lines: [
      L('EXHAUST SYSTÈM', 20, 16),
      L('Via vergali 1 blbbiano (RE)42021 ITALIA', 36, 11),
      L('MOSCATELLI LUCA', 52, 14),
      L('info@lmexhaustsystem.it', 68, 11),
      L('www.lmexhaustsystem.it', 84, 10),
    ]}],
    expected: {
      firstName: 'Luca',
      lastName: 'Moscatelli',
      companyContains: 'Exhaust',
      firstNameNotContains: 'Exhaust',
    },
  },
  {
    name: 'ITER9 INFORMATICA CF/PI → vatNumber',
    pages: [{ rawText: '', lines: [
      L('INFORMATICA', 20, 14),
      L('S.a.s di M. BERNI & C.', 36, 12),
      L('PIAZZA CARDINALE ELIA DALLA COSTA, 18 - 50126', 52, 11),
      L('FIRENZE TEL 055/686465', 68, 11),
      L('CF/PI 03100160484', 84, 11),
    ]}],
    expected: {
      vatNumber: '03100160484',
    },
  },
  {
    name: 'ITER9 CORIUM CAP Milano (non Roma)',
    pages: [{ rawText: '', lines: [
      L('CORIUM', 20, 16),
      L('Via Tortona 33', 40, 11),
      L('20149 Milano', 56, 11),
      L('info@corium.it', 72, 11),
    ]}],
    expected: {
      companyContains: 'CORIUM',
      addressCityContains: 'Milano',
      addressCityNot: 'Roma',
    },
  },
  {
    name: 'ITER10 Maxicarta email dominio OCR ≠ website (review)',
    pages: [{ rawText: '', lines: [
      L('maxicarta', 20, 16),
      L('Renato Plesnicar', 38, 14),
      L('maxicarta@mnaxicarta.it', 72, 11),
      L('www.maxicarta.it', 88, 10),
    ]}],
    expected: {
      firstName: 'Renato',
      lastName: 'Plesnicar',
      websiteContains: 'maxicarta.it',
      reviewContains: 'emails',
    },
  },
  {
    name: 'ITER10 For Industry role OCR garbage (review, no CIO spazzatura)',
    pages: [{ rawText: '', lines: [
      L('For Industry', 20, 14),
      L('Alessio Giullano', 36, 14),
      L('GarbuIoDICKINson GrOUp CIO', 52, 12),
      L('agiuilano@forindustry.it', 68, 11),
      L('www.forindustry.it', 84, 10),
    ]}],
    expected: {
      firstName: 'Alessio',
      lastNameContains: 'Giul',
      roleNotContains: 'GarbuIo',
      reviewContains: 'role',
    },
  },
];

// ---------------------------------------------------------------------------

const norm = (s) => (s ?? '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

let pass = 0;
let fail = 0;
let skipped = 0;
const failedNames = [];
const caseResults = [];
for (const tc of DATASET) {
  const expectedDeclared = hasDeclaredExpectedAssertion(
    tc.expected,
    RECOGNIZED_EXPECTED_KEYS,
    tc.expectEmpty ?? [],
    RECOGNIZED_EXPECT_EMPTY_FIELDS
  );
  if (tc.skip) {
    skipped++;
    console.log(`SKIP ${tc.name}${tc.skipReason ? ` — ${tc.skipReason}` : ''}`);
    caseResults.push({
      id: tc.name,
      status: 'skipped',
      skipReason: tc.skipReason,
      expectedDeclared,
    });
    continue;
  }
  const r = extractCardV5(tc.pages);
  const errors = [];
  const chk = (label, actual, expected, contains = false) => {
    if (expected === undefined) return;
    const a = norm(actual);
    const e = norm(expected);
    if (contains ? !a.includes(e) : a !== e) errors.push(`${label}: atteso "${expected}" → "${actual ?? ''}"`);
  };
  chk('firstName', r.firstName.value, tc.expected.firstName);
  chk('lastName', r.lastName.value, tc.expected.lastName);
  chk('company', r.company.value, tc.expected.company);
  chk('company~', r.company.value, tc.expected.companyContains, true);
  chk('role', r.role.value, tc.expected.role);
  chk('role~', r.role.value, tc.expected.roleContains, true);
  chk('website~', r.website.value, tc.expected.websiteContains, true);
  chk('vat', r.vatNumber.value, tc.expected.vatNumber);
  chk('cf', r.taxCode.value, tc.expected.taxCode);
  chk('address~', r.address.value?.full, tc.expected.addressContains, true);
  if (tc.expected.addressContains2) {
    chk('address~2', r.address.value?.full, tc.expected.addressContains2, true);
  }
  if (tc.expected.addressContains3) {
    chk('address~3', r.address.value?.full, tc.expected.addressContains3, true);
  }
  if (tc.expected.addressNotContains) {
    const full = r.address.value?.full ?? '';
    if (full.toLowerCase().includes(tc.expected.addressNotContains.toLowerCase())) {
      errors.push(`address: NON doveva contenere "${tc.expected.addressNotContains}" → "${full}"`);
    }
  }
  for (const bad of tc.expected.addressNotContainsAny ?? []) {
    const full = r.address.value?.full ?? '';
    if (full.toLowerCase().includes(bad.toLowerCase())) {
      errors.push(`address: NON doveva contenere "${bad}" → "${full}"`);
    }
  }
  if (tc.expected.emailsContain) {
    const list = (r.emails.value ?? []).map((e) => e.toLowerCase());
    const needle = tc.expected.emailsContain.toLowerCase();
    if (!list.some((e) => e.includes(needle))) {
      errors.push(`emails: atteso "${tc.expected.emailsContain}" → ${JSON.stringify(list)}`);
    }
  }
  if (tc.expected.companyNot !== undefined && norm(r.company.value) === norm(tc.expected.companyNot)) {
    errors.push(`company: NON doveva essere "${tc.expected.companyNot}"`);
  }
  if (tc.expected.companyNotContains) {
    const comp = r.company.value ?? '';
    if (comp.toLowerCase().includes(tc.expected.companyNotContains.toLowerCase())) {
      errors.push(`company: NON doveva contenere "${tc.expected.companyNotContains}" → "${comp}"`);
    }
  }
  if (tc.expected.companyNotContains2) {
    const comp = r.company.value ?? '';
    if (comp.toLowerCase().includes(tc.expected.companyNotContains2.toLowerCase())) {
      errors.push(`company: NON doveva contenere "${tc.expected.companyNotContains2}" → "${comp}"`);
    }
  }
  if (tc.expected.firstNameNotContains) {
    const first = r.firstName.value ?? '';
    if (first.toLowerCase().includes(tc.expected.firstNameNotContains.toLowerCase())) {
      errors.push(`firstName: NON doveva contenere "${tc.expected.firstNameNotContains}" → "${first}"`);
    }
  }
  if (tc.expected.lastNameNotContains) {
    const last = r.lastName.value ?? '';
    if (last.toLowerCase().includes(tc.expected.lastNameNotContains.toLowerCase())) {
      errors.push(`lastName: NON doveva contenere "${tc.expected.lastNameNotContains}" → "${last}"`);
    }
  }
  if (tc.expected.lastNameContains) {
    const last = r.lastName.value ?? '';
    if (!norm(last).includes(norm(tc.expected.lastNameContains))) {
      errors.push(`lastName~: atteso "${tc.expected.lastNameContains}" → "${last}"`);
    }
  }
  if (tc.expected.firstNameContains) {
    const first = r.firstName.value ?? '';
    if (!norm(first).includes(norm(tc.expected.firstNameContains))) {
      errors.push(`firstName~: atteso "${tc.expected.firstNameContains}" → "${first}"`);
    }
  }
  if (tc.expected.emailContains) {
    const list = (r.emails.value ?? []).join(' ');
    if (!norm(list).includes(norm(tc.expected.emailContains))) {
      errors.push(`email~: atteso "${tc.expected.emailContains}" → "${list}"`);
    }
  }
  chk('addressCity', r.address.value?.city, tc.expected.addressCity);
  if (tc.expected.addressCityContains) {
    const city = r.address.value?.city ?? r.address.value?.full ?? '';
    if (!norm(city).includes(norm(tc.expected.addressCityContains))) {
      errors.push(`address city~: atteso "${tc.expected.addressCityContains}" → city="${r.address.value?.city ?? ''}" full="${r.address.value?.full ?? ''}"`);
    }
  }
  if (tc.expected.addressCivic) {
    const parts = [
      r.address.value?.street,
      r.address.value?.full,
      r.address.value?.civicNumber,
    ]
      .filter(Boolean)
      .join(' ');
    if (!norm(parts).includes(norm(tc.expected.addressCivic))) {
      errors.push(`address civic: atteso "${tc.expected.addressCivic}" in street/full/civic`);
    }
  }
  if (tc.expected.addressCityNot) {
    const city = r.address.value?.city ?? '';
    if (norm(city) === norm(tc.expected.addressCityNot)) {
      errors.push(`address.city: NON doveva essere "${tc.expected.addressCityNot}"`);
    }
  }
  if (tc.expected.pageMismatch === true && !r.pageMismatch) {
    errors.push('pageMismatch: atteso true');
  }
  if (tc.expected.pageMismatch === false && r.pageMismatch) {
    errors.push('pageMismatch: atteso false');
  }
  if (tc.expected.emailsNotContain) {
    const list = (r.emails.value ?? []).map((e) => e.toLowerCase());
    if (list.some((e) => e.includes(tc.expected.emailsNotContain.toLowerCase()))) {
      errors.push(`emails: NON doveva contenere "${tc.expected.emailsNotContain}"`);
    }
  }
  if (tc.expected.roleNotContains) {
    const role = r.role.value ?? '';
    if (role.toLowerCase().includes(tc.expected.roleNotContains.toLowerCase())) {
      errors.push(`role: NON doveva contenere "${tc.expected.roleNotContains}" → "${role}"`);
    }
  }
  if (tc.expected.reviewContains) {
    const full = extractBusinessCardV5(tc.pages);
    const review = full.reviewFields ?? [];
    if (!review.includes(tc.expected.reviewContains)) {
      errors.push(`reviewFields: atteso "${tc.expected.reviewContains}" → ${JSON.stringify(review)}`);
    }
  }
  errors.push(
    ...collectExpectedEmptyFailures(
      tc.expectEmpty ?? [],
      (key) => r[key]?.value
    )
  );
  if (tc.expected.phonesNotContain) {
    const needle = tc.expected.phonesNotContain.replace(/\D/g, '');
    const phones = (r.phones.value ?? []).map((p) => p.number.replace(/\D/g, ''));
    if (phones.some((p) => p.includes(needle))) {
      errors.push(`phones: NON doveva contenere "${tc.expected.phonesNotContain}" → ${JSON.stringify(r.phones.value)}`);
    }
  }
  if (tc.expected.addressCountryNot) {
    const country = r.address.value?.country ?? '';
    if (norm(country) === norm(tc.expected.addressCountryNot)) {
      errors.push(`address.country: NON doveva essere "${tc.expected.addressCountryNot}"`);
    }
  }
  if (errors.length) {
    fail++;
    caseResults.push({
      id: tc.name,
      status: 'failed',
      expectedDeclared,
      error: errors,
    });
    failedNames.push(tc.name);
    console.log(`\nFAIL ${tc.name}`);
    errors.forEach((e) => console.log('  ' + e));
    console.log('  --- punteggi riga ---');
    for (const d of r.debugLines) {
      console.log(`  [${d.masked ?? '     '}] fs=${d.fontScale} P=${d.scores.person} C=${d.scores.company} R=${d.scores.role}  ${d.text}`);
    }
  } else {
    pass++;
    caseResults.push({
      id: tc.name,
      status: 'passed',
      expectedDeclared,
    });
    console.log(`PASS ${tc.name}`);
  }
}

/** Classificazione FAIL iterazione 3 — tag obbligatori. */
const FAIL_CLASSIFICATION = {
  'ABLE Tech': 'FORMAT_ONLY — srl vs S.r.l., stesso soggetto (atteso aggiornato a companyContains)',
  TinyAtWork: 'PREEXISTING_REAL_BUG — risolto iter.2 (Mbabin da reconcile email)',
  Querit: 'FORMAT_ONLY — QUERIT Srl vs S.r.l. (atteso aggiornato a companyContains)',
  Steinbeis: 'OCR_LIMITATION — Jörg vs Joerg (normalizzazione Unicode OCR)',
  'OPC Group': 'FORMAT_ONLY — SPA vs S.p.A. (atteso aggiornato a companyContains)',
  'UP!TRAIL (logo storpiato da OCR, nessuna persona)': 'OCR_LIMITATION — logo UP:TRAIC illeggibile',
  'ICT-GROUP retro devastato (OCR reale dal telefono)': 'OCR_LIMITATION — retro BICTGROUP',
  'UP!TRAIL OCR reale (UPITRAIC, CAP incollato alla via)': 'OCR_LIMITATION — brand Real World Adventures vs UP!TRAIL',
  'Falegnameria Filippi (OCR reale: logo F, FIGLSNE, email corrotta)': 'OCR_LIMITATION — logo-only, no persona plausibile',
  'iDempiere ruolo inline': 'PREEXISTING_REAL_BUG — ruolo inline CEO/ Senior non estratto',
  'Sgerze Massimo libero OCR (1ibero non è company)': 'PREEXISTING_REAL_BUG — IMPRESA EDILE vs Sgerze',
  'SIME Servizi Industriali (OCR reale QA 1209)': 'PREEXISTING_REAL_BUG — espansione ragione sociale vs brand SIME',
  'Orientaform snc from CF line': 'FORMAT_ONLY — OrientoForm vs Orientaform (atteso aggiornato)',
  'DERGA GMBH (brand vs forma giuridica)': 'OCR_LIMITATION — Stetano typo OCR vs Stefano',
  'Tuglak (brand card, non dominio email)': 'OCR_LIMITATION — TUGLAS OCR vs Tuglak brand card',
  'Themis from domain not www OCR': 'OBSOLETE_EXPECTATION — atteso aggiornato iter.2 (Antonio Gaboardi)',
  'QA audit Gaboardi (OCR↔email conservativo)': 'risolto iter.2',
  'QA audit Maxicarta (OCR reale multi-sede, sede operativa)': 'risolto iter.3 — sede operativa senza concatenazione',
  'QA audit Jaspersoft OCR reale (single page, solo Dublin)': 'risolto iter.3 — cluster Dublin senza Frankfurt',
  'QA Dolphin split via OCR (rotated scan)': 'risolto iter.3 — gruppo indirizzo coerente post-company',
  'BLOCKED: Maurizio Lain (OCR reale mancante)': 'SKIP — sostituito ITER4 Lain',
  'ITER4 Domofacile Gavasso (OCR reale export 13/07)': 'iter.4 finale — brand da dominio email',
  'ITER4 Ponzoni IZS (OCR reale export 13/07)': 'iter.4 finale — istituto vs skype/Dirigente',
  'ITER4 Lain Supersolar (OCR reale export 13/07)': 'iter.4 finale — MAURIZIO LAIN vs email agenzia',
  'ITER4 DERGA Stefano (OCR reale export 13/07)': 'iter.4 finale — OCR caps vs typo email',
  'ITER4 Tuglak (OCR_LIMITATION, no persona inventata)': 'OCR_LIMITATION — nome non forzato',
};

const contractSummary = summarizeContractSuite(
  'parser v5 dataset',
  'accuracy',
  EXPECTED_DATASET_CASES,
  caseResults
);
console.log(
  `\n=== parser v5: ${pass}/${pass + fail} biglietti OK ` +
    `(${skipped} skipped; ${contractSummary.discovered}/${contractSummary.expected} scoperti) ===`
);
for (const violation of contractSummary.violations) {
  console.error(`CONTRACT ERROR: ${violation}`);
}
if (failedNames.length) {
  console.log('\n--- Classificazione FAIL ---');
  for (const name of failedNames) {
    const cls = FAIL_CLASSIFICATION[name] ?? 'NON CLASSIFICATO — richiede verifica biglietto reale';
    console.log(`  • ${name}`);
    console.log(`    → ${cls}`);
  }
}
process.exit(contractSummary.exitCode);
