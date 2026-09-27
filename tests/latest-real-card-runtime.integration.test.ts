import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BusinessCard } from '../types';
import {
  applyBusinessCardReparseProposal,
  buildBusinessCardReparseProposal,
} from '../lib/contact-reparse';
import { initializeParsedContactReviewState } from '../lib/contact-review-state';
import { testCard } from './helpers/critical-workflow-harness';

interface RealFixture {
  id: string;
  createdAt: string;
  rawText: string;
  current: Partial<BusinessCard>;
}

const fixtures: Record<string, RealFixture> = {
  legalHeaderPersonGuard: {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-01T14:21:00.000Z',
    rawText: `Gino Carretta
S.r.l.
Via Firenze, 5
Villaverla (VI)`,
    current: {
      title: 'Gino Carretta',
      firstName: 'Gino',
      lastName: 'Carretta',
      company: 'Gino Carretta',
    },
  },
  dolphin: {
    id: 'd0179007-c15d-4309-8a00-74bce21380ed',
    createdAt: '2026-08-01T14:20:44.845Z',
    rawText: `SDOLPHIN
Software & Taiakaane
Dolphin srl
24040 BONATE SOTTO (BG) Via V. Veneto, 2
Tel. 035 494.3081 Fax 035 509.5548
Roberto Sivera
10064 PINEROLO (TO) Via Arsenale, 4
Tel. 0121 393.163 Fax 0121 390.560
E-mail: rsivera@ dolphin.it
Web: www.dolphin.it
Mobile: +39 348 1316768
E-mail: info@ dolphin. it`,
    current: {
      title: 'Dolphin S.r.l. - Roberto Sivera', firstName: 'Roberto', lastName: 'Sivera',
      company: 'Dolphin S.r.l.', emails: [], website: 'www.dolphin.it',
      address: { full: '24040 Bonate Sotto (BG) Via V. Veneto, Nr. 4 - IT', street: '24040 Bonate Sotto (BG) Via V. Veneto', civicNumber: '4', region: 'BG', country: 'IT' },
    },
  },
  i3p: {
    id: '05fa8a2a-4d4e-4504-a0dd-73c7e9029225', createdAt: '2026-08-01T14:20:21.838Z',
    rawText: `Massimiliano Ceaglio
Senior Consultant
Incubatore
Imprese
Innovative
Politecnico
Torino
ceaglio@i3p.it
www.i3p.it
13P S.c.p.a. Corso Castelfidardo 30/A, 10129 Torino T +39 011 0905137
M +39 393 7014041 F +39 011 0905733
PIVA 07793080016`,
    current: { title: 'Politecnico - Massimiliano Ceaglio', firstName: 'Massimiliano', lastName: 'Ceaglio', role: 'Senior Consultant', company: 'Politecnico', website: 'www.i3p.it', vatNumber: '07793080016', address: { full: 'S.c.p.a. Corso Castelfidardo, Nr. 13P - 10129 - Torino T - (TO) - IT', street: 'S.c.p.a. Corso Castelfidardo', civicNumber: '13P', postalCode: '10129', city: 'Torino T', region: 'TO', country: 'IT' } },
  },
  maxicarta: {
    id: 'b156f59b-0d1c-4fda-9902-1692859a8d66', createdAt: '2026-08-01T14:20:02.430Z',
    rawText: `in axicarta
Renato Plesnicar
Delegato alle vendite
cell. 3381051640
Sede operativa:
Sede legale:
Via lII Armata, 123
Via Garzarolli, 197/199
Tel. 0481.20831 - Fax 0481.21516
34170 - GORIZIA
34170 - GORIZIA
P. IVA O0163400310
www.maxicarta.it
E-mail: maxicarta@maxicarta.it`,
    current: { title: 'Maxicarta - Renato Plesnicar', firstName: 'Renato', lastName: 'Plesnicar', company: 'Maxicarta', role: '', vatNumber: '00163400310', website: 'www.maxicarta.it', address: { full: 'Via l|| Armata, Nr. 123 - 34170 - Gorizia - (GO) - IT', street: 'Via l|| Armata', civicNumber: '123', postalCode: '34170', city: 'Gorizia', region: 'GO', country: 'IT' } },
  },
  informatica: {
    id: '1f8b98ec-87c8-46e8-b986-cb519cf8edb1', createdAt: '2026-08-01T14:19:41.693Z',
    rawText: `INFORMATICA
ADMINISTRATION'SENTER
A
S.a.s
di M. BERNI & C.
Organizzazione amministrativa aziendale
Progettazione software personalizzato
Scuola addestramento sofiware applicativo
PIAZZA CARDINALE ELIA
DALLA COSTA, 18 - 50126
FIRENZE TEL. 055/686465
CF/P 03100160484`,
    current: { title: 'Scuola addestramento sofiware applicativo', company: 'Scuola addestramento sofiware applicativo', taxCode: '03100160484', address: { full: 'Piazza Cardinale ELIA, Dalla Costa, Nr. 18 - 50126 - 50126, Firenze - (FI) - IT', street: 'Piazza Cardinale ELIA, Dalla Costa', civicNumber: '18', postalCode: '50126', city: '50126, Firenze', region: 'FI', country: 'IT' } },
  },
  schinasi: {
    id: '2035bdcc-b0b3-4f14-94fd-0acececc2390', createdAt: '2026-08-01T14:18:14.923Z',
    rawText: `D+39 320 1452812
C+39 0445 520487
S
stefano.ruberti@schinasi.it
9Via G. Carducci 18 - Schio 36015
Sede secondaria - Schio
RUI BOO001 1679
Account Executive
INSURANCE BROKERS
SCHINASI
Stefano Ruberti`,
    current: { title: 'Schinasi - Stefano Ruberti', firstName: 'Stefano', lastName: 'Ruberti', company: 'Schinasi', role: 'Account Executive', emails: ['stefano.ruberti@schinasi.it'], phones: [{ number: '+39 320 1452812' }, { number: '+39 0445 520487' }, { number: '001 1679' }] },
  },
  cristallo: {
    id: 'e33b13e0-30b3-4f39-972f-97e4603be4b8', createdAt: '2026-08-01T14:16:33.031Z',
    rawText: `CARROZZERIA
CRISTALLO
di De Rossi Romeo Emilio
Via Croce, 58 I36033 Isola Vicentina
Tel. 0444 975669 cell./whatsapp 345 1638355
P.J. 01238380248IC.F. DRSRML58E27E864N
carr_cristallo@libero.itI www.carrozzeriacristallo.net`,
    current: { title: 'Carrozzeria Cristallo - Romeo Emilio De Rossi', firstName: 'Romeo Emilio', lastName: 'De Rossi', company: 'Carrozzeria Cristallo', vatNumber: '01238380248', taxCode: 'DRSRML58E27E864N', address: { full: 'Via Croce, 58 |36033 Isola Vicentina' } },
  },
  corium: {
    id: '9dcd669a-a485-4be3-9eb6-074a0cf87e62', createdAt: '2026-08-01T14:15:13.472Z',
    rawText: `CORIUM
Roberto Manzoni
Presidente
Via Correggio, 19- 20149 Milano
Via Savoia, 78-00198 Roma
Tel. 0248014317
Tel. 068413222
B-mail: manzoni@eorium-mi.it
arbora
Global Career Partners`,
    current: { title: 'Eoriummi - Roberto Manzoni', firstName: 'Roberto', lastName: 'Manzoni', company: 'Eoriummi', role: 'Presidente', emails: ['manzoni@eorium-mi.it'], address: { full: 'Via Correggio, Nr. 19 - IT', street: 'Via Correggio', civicNumber: '19', country: 'IT' } },
  },
  shield: {
    id: 'db0dc964-3586-43bf-81c8-32f8a2e64bb2', createdAt: '2026-08-01T14:14:15.116Z',
    rawText: `QAISER AKRAM
ySHIELD
Business Development Director
MOTORBIKE GLOVES
9+92-300-8711 104
SOLEHRE BROTHERS INDUSTRIES
info@shieldmoto.com
12-KM Daska Road,
Qaiser@shieldmoto.com
Mahabat Khan Industrial Estate,
Sialkot- 51310 Pakistan.
Gloves @shieldmoto.com
https://shieldmoto. com
+92 52 352 4181`,
    current: { title: 'Shieldmoto - Qaiser Akram', firstName: 'Qaiser', lastName: 'Akram', company: 'Shieldmoto', role: 'Business Development Director', emails: ['info@shieldmoto.com', 'qaiser@shieldmoto.com'], website: undefined, address: { full: '12-KM Daska Road - 51310 - Pakistan. - PK', street: '12-KM Daska Road', postalCode: '51310', city: 'Pakistan.', country: 'PK' } },
  },
};

function currentCard(fixture: RealFixture): BusinessCard {
  return initializeParsedContactReviewState(testCard({
    id: fixture.id,
    createdAt: new Date(fixture.createdAt),
    updatedAt: new Date(fixture.createdAt),
    rawText: fixture.rawText,
    firstName: '', lastName: '', company: '', role: '', emails: [], phones: [],
    ...fixture.current,
  }));
}

function integratedResult(key: keyof typeof fixtures): BusinessCard {
  const card = currentCard(fixtures[key]);
  const proposal = buildBusinessCardReparseProposal(card);
  assert.ok(proposal, `${key}: proposal expected`);
  const fields = proposal.fields.filter((field) => !field.protectedByManualOverride).map((field) => field.field);
  const applied = applyBusinessCardReparseProposal(card, proposal, fields);
  assert.equal(applied.status, 'applied');
  return applied.appliedResult;
}

test('LEGAL-HEADER-01 una persona seguita da forma legale non perde la propria identità', () => {
  const result = integratedResult('legalHeaderPersonGuard');
  assert.equal(
    result.firstName,
    'Gino',
    JSON.stringify({ firstName: result.firstName, lastName: result.lastName, company: result.company }),
  );
  assert.equal(result.lastName, 'Carretta');
  assert.doesNotMatch(result.company, /S\.r\.l\.?\s+S\.r\.l/i);
});

test('LAST8-01 riga azienda osservata prevale sul dominio OCR corrotto', () => {
  const result = integratedResult('corium');
  assert.equal(result.company.toLowerCase(), 'corium');
  assert.doesNotMatch(result.company, /eoriummi|eorium-mi/i);
  assert.ok(result.extractionReview?.company.reasons?.length);
});

test('LAST8-02 RUI etichettato non diventa telefono', () => {
  const result = integratedResult('schinasi');
  assert.ok(!result.phones.some((phone) => /001\s*1679/.test(phone.number)));
});

test('LAST8-03 prefisso grafico non elimina un indirizzo strutturato', () => {
  const result = integratedResult('schinasi');
  assert.match(result.address?.full ?? '', /Via G\. Carducci.*18/i);
  assert.match(result.address?.full ?? '', /Schio/i);
  assert.equal(result.address?.postalCode, '36015');
});

test('LAST8-04 sedi Dolphin non contaminano via e civico', () => {
  const result = integratedResult('dolphin');
  const addresses = [result.address, ...(result.extractionReview?.addressAlternatives ?? [])].filter(Boolean);
  const bonate = addresses.find((address) => /Bonate Sotto/i.test(address?.full ?? ''));
  const pinerolo = addresses.find((address) => /Pinerolo/i.test(address?.full ?? ''));
  assert.equal(bonate?.civicNumber, '2');
  assert.equal(pinerolo?.civicNumber, '4');
  assert.match(bonate?.street ?? bonate?.full ?? '', /V\.?\s*Veneto/i);
  assert.match(pinerolo?.street ?? pinerolo?.full ?? '', /Arsenale/i);
});

test('LAST8-05 email Dolphin con spazio resta proposta repaired', () => {
  const result = integratedResult('dolphin');
  const repaired = result.emailEvidence?.find(
    (item) =>
      item.origin === 'repaired' &&
      /rsivera@dolphin\.it/i.test(item.repairedValue ?? item.value)
  );
  assert.ok(repaired);
  assert.equal(repaired.confirmed, false);
  assert.ok(result.extractionReview?.reviewFields.includes('emails'));
});

test('LAST8-06 sigla societaria non diventa civico', () => {
  const result = integratedResult('i3p');
  assert.match(result.company, /I3P/i);
  assert.doesNotMatch(result.address?.civicNumber ?? '', /I3P|13P/i);
  assert.equal(result.address?.civicNumber, '30/A');
  assert.match(result.address?.street ?? '', /Corso Castelfidardo/i);
});

test('LAST8-07 intestazione e forma legale multilinea battono la descrizione servizio', () => {
  const result = integratedResult('informatica');
  assert.match(result.company, /Informatica/i);
  assert.match(result.company, /S\.?a\.?s|Berni/i);
  assert.doesNotMatch(result.company, /Scuola addestramento/i);
});

test('LAST8-08 CAP e città non vengono duplicati', () => {
  const result = integratedResult('informatica');
  assert.equal(((result.address?.full ?? '').match(/50126/g) ?? []).length, 1);
  assert.equal(result.address?.postalCode, '50126');
  assert.match(result.address?.city ?? '', /Firenze/i);
});

test('LAST8-09 ruolo osservato Maxicarta è conservato', () => {
  assert.equal(integratedResult('maxicarta').role.toLowerCase(), 'delegato alle vendite');
});

test('LAST8-10 paese Shield resta distinto dalla città', () => {
  const result = integratedResult('shield');
  assert.match(result.address?.city ?? '', /Sialkot/i);
  assert.doesNotMatch(result.address?.city ?? '', /Pakistan/i);
  assert.match(result.address?.country ?? '', /PK|Pakistan/i);
});

test('LAST8-11 URL Shield con spazio è riparato conservativamente', () => {
  const result = integratedResult('shield');
  const proposed = result.website ?? result.extractionReview?.website.value ?? '';
  assert.match(proposed, /shieldmoto\.com/i);
});

test('LAST8-12 P.IVA e CF concatenati restano separati', () => {
  const result = integratedResult('cristallo');
  assert.equal(result.vatNumber, '01238380248');
  assert.equal(result.taxCode, 'DRSRML58E27E864N');
  assert.doesNotMatch(result.address?.full ?? '', /\|/);
});

test('LAST8-13 apply proposal propaga i campi nel record finale', () => {
  const result = integratedResult('corium');
  assert.equal(result.contactReviewState?.fieldOrigins.company, 'reparse');
  assert.ok(result.lastParserBuildId);
});

test('LAST8-14 titolo usa i campi finali', () => {
  const result = integratedResult('corium');
  assert.match(result.title, /Corium/i);
  assert.match(result.title, /Roberto Manzoni/i);
  assert.doesNotMatch(result.title, /Eoriummi/i);
});

test('LAST8-15 nessun hardcode reale nei sorgenti di produzione', () => {
  const production = [
    'lib/contact-reparse.ts',
    'lib/parser-v5/engine.ts',
    'lib/parser-v5/address-assembly.ts',
    'lib/parser-engine/resolve/reconcile.ts',
  ].map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const fixture of Object.values(fixtures)) {
    assert.equal(production.includes(fixture.id), false);
  }
});
