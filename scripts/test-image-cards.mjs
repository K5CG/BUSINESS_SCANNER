/**
 * test-image-cards.mjs
 * Simula la scansione di tutti i biglietti da visita visibili nelle immagini caricate.
 * Esegui con: npx tsx scripts/test-image-cards.mjs
 */
import { extractCardV5 } from '../lib/parser-v5/engine.ts';
import { summarizeContractSuite } from '../lib/test-suite-contract.ts';

const EXPECTED_IMAGE_CASES = 49;
const imageResults = [];

function pagesFromText(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) return [{ lines: [], rawText: '' }];
  const lines = trimmed.split('\n').map((t, i) => ({
    text: t.trim(),
    confidence: 0.9,
    boundingBox: { x: 30, y: 20 + i * 18, width: 500, height: 16 },
  })).filter(l => l.text);
  return [{ lines, rawText: trimmed }];
}

function runTest(id, label, rawText) {
  try {
    const result = extractCardV5(pagesFromText(rawText));
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`✅ OK  [${id}] ${label}`);
    console.log(`  👤 Nome:    ${result.firstName.value ?? '—'} ${result.lastName.value ?? '—'}`);
    console.log(`  🏢 Azienda: ${result.company.value ?? '—'}`);
    console.log(`  💼 Ruolo:   ${result.role.value ?? '—'}`);
    console.log(`  📧 Email:   ${result.emails.value?.join(', ') ?? '—'}`);
    console.log(`  📞 Tel:     ${result.phones.value?.map(p => p.number).join(', ') ?? '—'}`);
    console.log(`  🌐 Sito:    ${result.website.value ?? '—'}`);
    if (result.vatNumber.value) console.log(`  🧾 P.IVA:   ${result.vatNumber.value}`);

    const warns = [];
    if (!result.firstName.value && !result.lastName.value) warns.push('⚠️  NOME NON TROVATO');
    if (!result.company.value) warns.push('⚠️  AZIENDA NON TROVATA');
    if (!result.emails.value?.length && !result.phones.value?.length) warns.push('⚠️  NESSUN CONTATTO');
    if (result.pageMismatch) warns.push('⚠️  PAGE MISMATCH');
    warns.forEach(warning => console.log(`  ${warning}`));
    imageResults.push({ id, status: 'passed' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`❌ CRASH  [${id}] ${label}`);
    console.log(`  💥 ERRORE: ${message}`);
    imageResults.push({ id, status: 'failed', error: e });
  }
}

// ─── BIGLIETTI IMMAGINE 1 ──────────────────────────────────────────────────

runTest('01', 'Fabrizio Reale – Redomino s.r.l.', `
Fabrizio Reale
fabrizio.reale@redomino.com
Redomino s.r.l.
largo valgioie 14, 10146 torino - italy
+39 0117499875  +39 0113716911
http://www.redomino.com
PJ.08877930019
`);

runTest('02', 'Jörg Friedrich – Steinbeis Transferzentrum', `
STEINBEIS-TRANSFERZENTRUM
SOFTWARE QUALITY SYSTEMS
Prof. Dr. (Purdue Univ.)
Jörg Friedrich
Leiter
Eugen-Ruoff-Straße 30, 71404 Korb
Fon: (07 1 51) 27 01 92  Fax (07 1 51) 93 79 41
Mobil: (01 71) 2 74 68 68
E-Mail: joerg.friedrich@stz-sqs.com  Internet: www.stz-sqs.com
`);

runTest('03', 'Stefano Lanzi – Log 80 s.r.l.', `
Stefano Lanzi
stefano.lanzi@log80.it
347-4760209
Log 80 s.r.l.
Corso Mazzini, 83
47100 Forlì
Partita IVA 02622410401
Tel. 0543-83936  Fax. 0543-85619
`);

runTest('04', 'Simone Zinanni – Develer s.r.l.', `
Simone Zinanni
Project Manager
cell. +39.040.63.38.708
s.zinanni@develer.com
tel +39.055.38.86.627 int.202
develer eWork Solutions
Develer s.r.l.
via Mugellese 1/A
50013 Campi Bisenzio
FIRENZE - ITALY
tel.+39.055.38.86.627
fax.+39.178.60.03.614
info@develer.com
www.develer.com
`);

runTest('05', 'Javier Brugues – FDV Solutions', `
fdv solutions
soluciones de IT
Javier Brugues
Chief Financial Officer
Córdoba 966, 8vo E (CP:1054)
Buenos Aires, Argentina
(011) 15 4400 0658
javier.brugues@fdvsolutions.com
www.FDVSolutions.com
(54 - 11) 5239 - 9899
`);

runTest('06', 'Massimo Guerretta – ELDASOFT S.p.A.', `
ELDASOFT
Massimo Guerretta
Sales Area Manager
cell. 348 2337018
massimo.guerretta@eldasoft.it
è una società del Gruppo Maggioli
ELDASOFT S.p.A.
via E. Reginato, 87
31100 Treviso (TV)
tel. 0422 267720
fax. 0422 267768
www.eldasoft.it  eldasoft@eldasoft.it
`);

runTest('07', 'Laura De Zio – ABLE Tech srl', `
ABLE tech
Laura De Zio
Account Manager
+39 335 1830455
l.dezio@abletech.it
ARXivar
ABLE Tech srl
Via dell'Artigianato, 9/A
25018 Montichiari (BS) - ITALY
Tel. +39 030 9650.688  Fax +39 030 81931160
P. IVA 02355260981
`);

runTest('08', 'Roberto Montanari – QUERIT Srl', `
Querit
Soluzioni per l'analisi dei dati
QUERIT Srl
Via dei Ciliegi 49
31015 Conegliano (TV)
Tel. 0438 1895001
Fax. 0438 1896003
Cod.Fisc. e P.I 04296490261
www.querit.it
Roberto Montanari
CHIEF EXECUTIVE
mobile: +39 380 0435702
e-mail: roberto.montanari@querit.it
QlikView Certified Partner
`);

runTest('09', 'Ing. Paolo Foletto – Studio Ingegneria', `
STUDIO DI INGEGNERIA
DELL'INFORMAZIONE
Ing. Paolo Foletto
Progettazione Sistemi Informativi
Consulenze Informatiche
Via Manzoni, 1 - 35040 Carceri (PD)
Tel. e Fax 0429.2276 – Cell: 335.6152353
E-mail: pfoletto@tin.it
C.F. FLTPLA62P24L840T – P.I. 02656380280
`);

// ─── BIGLIETTI IMMAGINE 2 ──────────────────────────────────────────────────

runTest('10', 'Gerardo Padalino – Banca Popolare di Milano', `
BPM Banca Popolare di Milano
Gerardo Padalino
Promotore Finanziario
Rete Promotori Finanziari
Agenti Monomandatari
Uff. Tel. 049 891 35 12
Fax 17.42.74.52.06
Cell. 349 615 15 19
Ufficio:
Via Vallona, 11
35036 Montegrotto Terme (PD)
e-mail: padalinogerardo@tiscali.it
`);

runTest('11', 'Serena Arrighi – bNova Consulting', `
bNOVA CONSULTING
Serena Arrighi
+39 347 6453163
serena.arrighi@bnova.it
Via Silicani, 2
54033 CARRARA (MS) - ITALY
Tel. +39 0585 842210
Fax. +39 0585 847107
www.bnova.it
`);

runTest('12', 'Massimo Farina – EmmEffe s.r.l.', `
MF organizzare, formare e gestire
Massimo Farina
(+39) 335.54.73.041
mfarina@mfsrl.it
EmmEffe S.r.l. Management & Formazione
Via G.B. Fauché, 35 - 20154 Milano
Tel. 02.349.348.31 - Fax 02.349.348.19 - info@mfsrl.it - www.mfsrl.it
P.IVA 13098460150
`);

runTest('13', 'Francesco Russo – datapiano s.r.l.', `
Francesco Russo
francescorusso@datapiano.it
datapiano s.r.l.
servizi informatici per il territorio
30027 San Donà di Piave VE
Galleria Progresso 5
Tel. 0421 55 02 72
Fax 0421-33-36 80
C.F./P. 02220450274
www.datapiano.it
info@datapiano.it
335 5744434
`);

runTest('14', 'Marco Sinisi – IBM Italia S.p.A.', `
IBM
Marco Sinisi
ACG Product & Channel Leader
IBM Italia S.p.A.
Circonvallazione Idroscalo
20090 Segrate (Mi)
Tel. +39 02 596.27131
Fax +39 02 596.29200
Mobile +39 3356984018
e-mail marco.sinisi@it.ibm.com
`);

runTest('15', 'Franco Natali – SAP Italia Consulting S.p.A.', `
Franco Natali
Channel Partner
SAP Italia Consulting S.p.A.
Via E. P. Masini, 8
35131 Padova - Italy
Tel. +39 049 7801841
Mob. +39 335 7778999
franco_natali@sap-consulting.it
www.sap-consulting.it
SAP CONSULTING An IBM Company
`);

runTest('16', 'Jean-Marc Babin – TINYatWORK', `
TINYatWORK
Jean-Marc Babin
Président
Les Solutions TINYatWORK inc.
une division de Epsilon Technologies
3175, ch. des Quatre-Bourgeois
bureau 110
Sainte-Foy, QC, Canada, G1W 2K7
Téléphone: 418 780-1818
Cellulaire: 418 563-8019
Télécopieur: 418 780-3054
jmbabin@epsilon-ti.com
www.tinyatwork.com
`);

runTest('17', 'Jacques-André Eberhard – open-net', `
open-net OPEN SOURCE SOLUTION PROVIDER
Jacques-André EBERHARD
Directeur
ADVANCED eZ publish SOLUTION PARTNER
TinyERP
Avenue de la Vallombreuse 109
CH 1008 Prilly
info@open-net.ch  www.open-net.ch
078 898.40.77
`);

runTest('18', 'Dominique Chabord – SISalp', `
SISalp
Logiciel libre
Dominique Chabord
Consultant
18 avenue Beauregard
F-74960 CRAN GEVRIER
+33 (0)870 274 960
+33 (0)622 616 438
dominique.chabord@sisalp.org
http://www.sisalp.org
`);

runTest('19', 'Michel Pannetier – Humans & Diversity', `
HUMANS & DIVERSITY
http://www.hu-div.fr
Michel Pannetier
Consultant
06 15 94 60 66
michel.pannetier@hu-div.fr
68 rue Rmy les Prés 95240 Cormeilles en Parisis (France)  33 02 36 48 05 56
`);

// ─── BIGLIETTI IMMAGINE 3 ──────────────────────────────────────────────────

runTest('20', 'Hiroshi Aburakawa – Shokei Gakuin University', `
HIROSHI ABURAKAWA
PROFESSOR
SHOKEI GAKUIN UNIVERSITY
Faculty of Comprehensive Human Sciences
4-10-1 Yurigaoka Natori-City
MIYAGI-Pref. 981-1295 JAPAN
Phone (022)-383-0290
FAX (022)-383-0280
E-Mail: h_aburo@ybb.ne.jp
383-0111 EX290
`);

runTest('21', 'D.ssa Micaela Cera – DeMegni Antonio & Figli S.p.A.', `
DeMEGNI DISTRIBUZIONE SPA
D.ssa Micaela Cera
RESPONSABILE AREA CLIENTI
micaela.cera@demegni.it
DeMegni Antonio & Figli S.p.A.
37032 Monteforte d'Alpone 1/13  Verona
tel. +39 045 6173 111  fax +39 045 6100041
www.demegni.it  f.demegni@demegni.it
`);

runTest('22', 'Elda Alberti – OPC Group SPA', `
opcGroup
Elda Alberti
Account Manager
Security Management Networking
OPC GROUP SPA
Via E. Breda 152
20126 Milano
Tel. +39 02 2529.861
Fax +39 02 2529.8621
verde 800-203.301
www.opcgroup.it
cellulare +39 393 9003780
e-mail: elda.alberti@opcgroup.it
`);

runTest('23', 'Domenico Polisano – SIDI', `
Domenico Polisano
Via Mattecci, 10
20158 Milano
Telefono +39 02 37742.407
Telefax +39 02 37742.615
Tel. +348 8291102
Cell. +348 8291102
domenico.polisano@sidigroup.it
www.sidigroup.it
SIDI il valore dell'evoluzione
`);

runTest('24', 'Lars Johansson – Conduct AS', `
CONDUCT
Lars Johansson
+47 85 68 07 72
lars.johansson@conduct.no
Conduct AS
Kongens gate 14
Postboks 905 Sentrum
0104 Oslo, Norge
Telefon +47 40 00 17 68
Telefaks +47 22 33 60 24
www.conduct.no
`);

runTest('25', 'Dr. Claude Philipona – camptocamp', `
camptocamp
Dr. Claude Philipona
Directeur associé
Ing. phys. dipl. EPF
Master in Business Information System (MIS)
t. +41 21 619 10 11  m. +41 78 648 32 84
claude.philipona@camptocamp.com
`);

runTest('26', 'Gianni Zucchini – Infracom Italia S.p.A.', `
Infracom ITALIA
Gianni Zucchini
Direttore Commerciale
Infracom Italia S.p.A.
via Bassetti 12 - 37135 Verona, Italia
Tel. +39 045 965 9500  Fax. +39 045 965 9595
e-mail: giannizucchini@infracom.it
www.infracom.it
`);

runTest('27', 'Marco Ceola – MediaTrend', `
MEDIATREND
Marco Ceola
cell. 329 2138955
marco.ceola@mediatrend.it
Via Luigi Costa n°6
Torrebelvicino (Vi)
Tel. 0445570500
www.mediatrend.it
`);

runTest('28', 'Francesco Fullone – ideato', `
ideato web ideas for sale
Francesco Fullone
ceo
ff@ideato.it
mobile +39 347 2243285
skype ffullone
`);

runTest('29', 'Prof. Dr. Flavio Tonidandel – Centro Universitário da FEI', `
Centro Universitário da FEI
Fundação Educacional Inaciana Pe. Sabóia de Medeiros
Prof. Dr. Flavio Tonidandel
Coordenador do Curso de Ciência da Computação
Av. Humberto A. C. Branco, 3972
São Bernardo do Campo - SP - Brasil
CEP - 09850-901
Fone: (11) 4353-2900 - r.2190
Fax: (11) 4333-2910
flaviot@fei.edu.br
www.fei.edu.br
`);

// ─── BIGLIETTI IMMAGINE 4 ──────────────────────────────────────────────────

runTest('30', 'Piero – Speedmark', `
SPEEDMARK
Piero
mob. +39 335 5895598
piero@speedmark.it
Viale Venezia 28/A
36067 San Giuseppe di Cassola (VI) ITALY
Tel/Fax +39 0424 37806
info@speedmark.it  www.speedmark.it
P.Iva 02966260248
`);

runTest('31', 'Gino Carretta – Gino78', `
Gino78 FORNITURE SPORTIVE E AZIENDALI
Gino Carretta
cell. 348.3636554
fax. 0445.855363
www.ginocarretta.com
ginocarretta@gmail.com
78 di Carretta Gino, via San Simeone, 41 - Villaverla (VI)
P.Iva 03462270243 - C.F. CRRGNI78R10L157C
`);

runTest('32', 'giacomo Gamberoni – i-ware', `
giacomoGAMBERONI
giacomo@i-ware.it
ggamberoni
+39 345 6117243
via Borgo dei Leoni, 132
44121 Ferrara
www.i-ware.it
`);

runTest('33', 'Markus Roithmeier – Jedox AG', `
Jedox
Markus Roithmeier
Vice President
Global Alliances & Channel
Jedox AG
Bismarckallee 7a
D-79098 Freiburg
www.jedox.com
Phone: +49 761 15147 222
Mobile: +49 151 15147 222
markus.roithmeier@jedox.com
`);

runTest('34', 'Prof. Dott. José Blanco – Libera Cattedra di Lingua', `
Libera Cattedra di Lingua e Cultura Italiane
Santiago del Cile
Prof. Dott. José Blanco J.
Cavaliere della Repubblica Italiana
Los Industriales 2622 - L
Macul - SANTIAGO (CHILE)
Tel. (56-2) 231.34.49
e-mail: joblaar@gmail.com
`);

runTest('35', 'Luca Filippini – InformEtica Consulting', `
InformEtica CONSULTING
SAP BusinessObjects Gold Partner
Luca Filippini
Responsabile Commerciale
luca.filippini@informeticons.com
+39 349 0828409
InformEtica Consulting s.r.l.
Viale del Lavoro, 33 - Centro Direzionale E33
37036 San Martino Buon Albergo - VR
P. Iva e C.F. 03481480238
www.informeticons.com
`);

runTest('36', 'Ing. Loredana Reniero – OpenSymbol S.r.l.', `
OpenSymbol
Informatizzamo i processi aziendali
Ing. Loredana Reniero
Capo Progetto
Cell. +39.328.9866176
Mail: loredana.reniero@opensymbol.it
Skype: loren79
Opensymbol S.r.l.
Via Polaracca, 10 - Arzignano (VI)
Tel. +39.0444.189826
Fax: +39.0444.189827
http://www.opensymbol.it
`);

runTest('37', 'Victor Ika Acuña – Te Raai', `
Te Ra'ai Restaurant Italian Rapu Nui
Victor Ika Acuña
Gerente General / General Manager
e-mail: restaurant@teraapanui.cl
`);

runTest('38', 'Katie L. Pascincco – Boston University', `
Boston University
Division of Extended Education
Metropolitan College
755 Commonwealth Avenue
Room B7
Boston, Massachusetts 02215
617-353-6100
Fax: 617-353-2744
E-mail: katie@bu.edu
Katie L. Pascincco
Admissions & Outreach Coordinator
`);

runTest('39', 'Ugo Faggian – ULSS 13', `
Servizio Sanitario Nazionale - Regione Veneto
AZIENDA UNITA' LOCALE SOCIO-SANITARIA N. 13
UGO FAGGIAN
Direttore Dipartimento
Organizzazione, Sviluppo e Gestione del Sistema Informatico
30035 MIRANO(VE) - Via Mariutto, 76  tel. 041.5133482 - fax 041.5100732
e-mail: ugo.faggian@ulss13mirano.ven.it
sito web: www.ulss13mirano.ven.it
`);

// ─── BIGLIETTI IMMAGINE 5 ──────────────────────────────────────────────────

runTest('40', 'Dr.-Ing. Joachim Bues – BDB Systems', `
BDB Systems Prozesse & Systeme
Dr.-Ing. Joachim Bues
Geschäftsführer
BDB Systems Dr. Bues
European TelematicsFactory
Helmholtzhosse 2-9 10587 Berlin
Tel: +49 30 214 79 410
E-Mail: jbues@bdb-systems.de
Fax: +49 30 214 79 411
`);

runTest('41', 'Dott. Davide Bonamini – CRMVILLAGE.BIZ', `
CRMVILLAGE.BIZ
soluzioni e tecnologie per la gestione, l'analisi e il servizio dei tuoi clienti
Dott. Davide Bonamini
+39 3471603608
davide.bonamini@crmvillage.biz
CRMVILLAGE.BIZ S.r.L.
Via Fogazzaro 1
37047 San Bonifacio - VR
+39 045 9586297
`);

runTest('42', 'Mario Frati – GIVI', `
GIVI
MARIO FRATI
Responsabile
Ufficio Comunicazione
0039.030.2686027
m.frati@givi.it
`);

runTest('43', 'Chiozza Giovanni – MOTOCARD RAS', `
MOTOCARD RAS
COSTRUZIONI DI QUALITA' assistenza motocicli
Chiozza Giovanni
DA99030
0361000
`);

runTest('44', 'Alvaro Galán – Stratebi', `
Stratebi
Business Intelligence Solutions
Alvaro Galán
Desarrollo de Producto
Paseo de la Castellana, 164, 1°
28046 Madrid
Telefono: 91.788.34.10
alvaro.galan@stratebi.com
Portal Business Intelligence - www.TodoBi.com
`);

runTest('45', 'Corrado Pozzer – Tecno Pack SpA', `
Tecno Pack PACKAGING MACHINES
CORRADO POZZER
Managing Director
m.phone +39.333.1932785
corrado.pozzer@tecnopackspa.it
TECNO PACK SpA
Via lago di Alleghe, 19
136015 SCHIO (Vicenza) Italy
Tel. +39 0445.575.661
Fax +39 0445.575.672
www.tecnopackspa.it
`);

runTest('46', 'Enrico Sgarbossa – SAP Italia S.p.A.', `
SAP
Enrico Sgarbossa
Sales Executive
SAP Italia S.p.A.
Via Milazzo, 10/D
35019 Padova
T. +39 049 07325 27
F. +39 049 8725880
M +39 335 7721385
E enrico.sgarbossa@sap.com
www.sap.com/italy
`);

runTest('47', 'Morgan De Rizzo – Jolly Finissaggio', `
Jolly FINISSAGGIO
Morgan De Rizzo
Via Lungo Gogna, 45 - 36015 Schio (VI) - Italy
Phone +39 0445.525446 - Fax +39 0445.505321
info@finissaggioijolly.it
www.finissaggioijolly.it
P.IVA 02364190045
STIRERIA - RICOLLAUDI ABBIGLIAMENTO - PRESSING/RE-INSPECTION OF GARMENTS
`);

runTest('48', 'Thomas Morgner – pentaho', `
pentaho open source business intelligence
Thomas Morgner
Chief Architect, Reporting Technologies
E-mail: tmorgner@pentaho.org
Cell: +49 (178) 713 62 77
Schaefenstrasse 23c
67549 Worms, Germany
`);

runTest('49', 'Alexander Pohl – 3A Strategy', `
3A STRATEGY
Global Advisory: Controlling, Portfolio Management & Relocation
Pilotystrasse 4
80538 Munich, GERMANY
www.3A-Strategy.com
+49 (89) 230 35-261
Alexander Pohl, CEO
Partner
Cell: +49 (160) 584 20 20
aPohl@3A-Strategy.com
`);

// ─── RIEPILOGO ────────────────────────────────────────────────────────────

const imageSummary = summarizeContractSuite(
  'image cards smoke',
  'smoke',
  EXPECTED_IMAGE_CASES,
  imageResults
);
console.log(`\n${'═'.repeat(60)}`);
console.log(
  `SMOKE immagini: ${imageSummary.passed}/${imageSummary.executed} senza crash; ` +
    `${imageSummary.skipped} skipped; attesi ${imageSummary.expected}`
);
for (const violation of imageSummary.violations) {
  console.error(`CONTRACT ERROR: ${violation}`);
}
if (!imageSummary.ok) {
  console.error(`❌ Smoke fallito: ${imageSummary.failed} crash/errori.`);
  process.exitCode = 1;
} else {
  console.log('✅ Smoke completato senza crash.');
}
