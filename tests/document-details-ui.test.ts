import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { OrderDocument, QuoteDocument, FreeDocument } from '../types';
import { buildDocumentDetailsViewModel } from '../lib/document-details-view-model';
import type { DocumentEvidence, StructuredDocumentExtraction } from '../lib/document-structure';

const root = process.cwd();
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const base = {
  id: 'doc-1',
  title: 'Documento',
  images: ['page.jpg'],
  rawText: 'OCR',
  confidence: {},
  createdAt: new Date(2026, 7, 2),
  updatedAt: new Date(2026, 7, 2),
};

function quote(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return { ...base, type: 'quote', items: [], ...overrides };
}

function order(overrides: Partial<OrderDocument> = {}): OrderDocument {
  return { ...base, type: 'order', items: [], ...overrides };
}

function sectionFields(document: QuoteDocument | OrderDocument | FreeDocument) {
  return buildDocumentDetailsViewModel(document).sections.flatMap((entry) => entry.fields);
}

const evidence = <T>(value: T): DocumentEvidence<T> => ({
  rawValue: value, normalizedValue: value, pageIndex: 0,
  sourceLineIds: ['p1-l1'], sourceLines: [String(value)],
  validationStatus: 'unverified', confidenceType: 'heuristic',
  reasons: ['observed'], requiresReview: true, alternatives: [],
});

test('1 preventivo completo espone tutti i campi supportati', () => {
  const vm = buildDocumentDetailsViewModel(quote({
    quoteNumber: 'P-1', quoteDate: new Date(2026, 7, 2), validUntil: new Date(2026, 8, 2),
    customerName: 'Cliente', customerVat: 'IT123', subtotal: 100, vatAmount: 22,
    total: 122, currency: 'EUR', items: [{ description: 'Servizio', quantity: 1, unitPrice: 100, vatRate: 22, total: 100 }], notes: 'Nota',
  }));
  assert.deepEqual(vm.sections.map((entry) => entry.id), ['document', 'customer', 'amounts', 'items']);
  assert.equal(vm.sections.flatMap((entry) => entry.fields).length, 9);
});

test('2 preventivo con campi mancanti non crea righe vuote', () => {
  assert.deepEqual(buildDocumentDetailsViewModel(quote()).sections, []);
});

test('3 ordine multipagina conserva pagina di origine utile alla review', () => {
  const vm = buildDocumentDetailsViewModel(order({
    orderNumber: 'O-1',
    fieldReliability: { documentNumber: { rawValue: 'O-1', value: 'O-1', source: 'merged', pageIndex: 1, confidenceType: 'unknown', validationStatus: 'unverified', validationReasons: [], requiresReview: true, alternatives: [], conflict: false } },
  }));
  assert.equal(vm.sections[0].fields[0].sourcePage, 2);
});

test('4 scadenza presente è visibile', () => {
  assert.ok(sectionFields(quote({ validUntil: new Date(2026, 11, 31) })).some((field) => field.id === 'dueDate'));
});

test('5 partita IVA cliente è visibile', () => {
  assert.equal(sectionFields(quote({ customerVat: 'IT001' }))[0].value, 'IT001');
});

test('6 imponibile presente è visibile', () => {
  assert.ok(sectionFields(quote({ subtotal: 100 })).some((field) => field.id === 'subtotal'));
});

test('7 IVA presente è visibile', () => {
  assert.ok(sectionFields(quote({ vatAmount: 22 })).some((field) => field.id === 'vatAmount'));
});

test('8 valuta presente è visibile', () => {
  assert.ok(sectionFields(quote({ currency: 'EUR' })).some((field) => field.value === 'EUR'));
});

test('9 una riga articolo viene mostrata', () => {
  const vm = buildDocumentDetailsViewModel(quote({ items: [{ description: 'A', quantity: 1, unitPrice: 2, total: 2 }] }));
  assert.equal(vm.sections.find((entry) => entry.id === 'items')?.items.length, 1);
});

test('10 più articoli restano separati', () => {
  const items = [{ description: 'A', quantity: 1, unitPrice: 2, total: 2 }, { description: 'B', quantity: 3, unitPrice: 4, total: 12 }];
  assert.equal(buildDocumentDetailsViewModel(order({ items })).sections.find((entry) => entry.id === 'items')?.items.length, 2);
});

test('11 quantità mancante non viene trasformata in zero', () => {
  const items = [{ description: 'A', unitPrice: 2, total: 2 }] as OrderDocument['items'];
  const row = buildDocumentDetailsViewModel(order({ items })).sections.find((entry) => entry.id === 'items')!.items[0];
  assert.equal(row.fields.some((field) => field.labelKey === 'documentDetailsQuantity'), false);
});

test('12 prezzo mancante non viene trasformato in zero', () => {
  const items = [{ description: 'A', quantity: 1, total: 2 }] as OrderDocument['items'];
  const row = buildDocumentDetailsViewModel(order({ items })).sections.find((entry) => entry.id === 'items')!.items[0];
  assert.equal(row.fields.some((field) => field.labelKey === 'documentDetailsUnitPrice'), false);
});

test('13 note lunghe restano nel flusso editabile senza troncamento configurato', () => {
  const route = source('app/document/[id].tsx');
  const notes = source('components/DocumentNotesField.tsx');
  assert.match(route, /DocumentNotesField/);
  assert.match(notes, /multiline/);
});

test('14 valore da verificare genera un avviso', () => {
  const vm = buildDocumentDetailsViewModel(quote({ fieldReliability: { total: { rawValue: '122 da controllare', source: 'local_ocr', confidenceType: 'heuristic', validationStatus: 'unverified', validationReasons: [], requiresReview: true, alternatives: [], conflict: false } } }));
  assert.equal(vm.reviewAlerts[0].id, 'total');
  assert.ok(vm.sections.flatMap((entry) => entry.fields).some((field) => field.value === '122 da controllare'));
});

test('15 conflitto è distinto dalla review generica', () => {
  const vm = buildDocumentDetailsViewModel(order({ fieldReliability: { customerName: { rawValue: 'A', value: 'A', source: 'merged', confidenceType: 'unknown', validationStatus: 'ambiguous', validationReasons: [], requiresReview: true, alternatives: [], conflict: true } } }));
  assert.equal(vm.reviewAlerts[0].conflict, true);
});

test('16 null, NaN e stringhe vuote non appaiono come zero', () => {
  const fields = sectionFields(quote({ customerName: '  ', subtotal: undefined, vatAmount: Number.NaN, total: undefined }));
  assert.equal(fields.length, 0);
  assert.equal(fields.some((field) => field.value === '0'), false);
});

test('17 dettagli tecnici sono chiusi per default', () => {
  const route = source('app/document/[id].tsx');
  assert.match(route, /useState\(false\).*showTechnicalDetails|showTechnicalDetails.*useState\(false\)/s);
  assert.match(route, /showTechnicalDetails \? \(/);
});

test('18 light mode usa token adattivi, non colori hardcoded', () => {
  const component = source('components/DocumentStructuredDetails.tsx');
  assert.match(component, /colors\.surface/);
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}/i);
});

test('19 dark mode usa gli stessi token adattivi', () => {
  const component = source('components/DocumentStructuredDetails.tsx');
  assert.match(component, /colors\.warningSurface/);
  assert.match(source('lib/ui-theme.ts'), /DynamicColorIOS|PlatformColor/);
});

test('20 font scale grande può andare a capo senza larghezze fisse', () => {
  const component = source('components/DocumentStructuredDetails.tsx');
  assert.match(component, /flexShrink: 1/);
  assert.doesNotMatch(component, /width:\s*\d/);
});

test('documento libero espone soltanto campi strutturati non vuoti', () => {
  const document: FreeDocument = { ...base, type: 'free_document', documentNumber: 'D-1', extractedFields: { CUP: 'ABC', vuoto: '' } };
  const fields = sectionFields(document);
  assert.deepEqual(fields.map((entry) => entry.value), ['D-1', 'ABC']);
});

test('preventivo espone i campi liberi persistiti nella reliability', () => {
  const vm = buildDocumentDetailsViewModel(quote({
    fieldReliability: {
      extractedFields: {
        rawValue: { CUP: 'ABC' },
        value: { CUP: 'ABC', riferimento: 'R-7', vuoto: '' },
        source: 'merged',
        confidenceType: 'unknown',
        validationStatus: 'unverified',
        validationReasons: [],
        requiresReview: true,
        alternatives: [],
        conflict: false,
      },
    },
  }));
  const other = vm.sections.find((entry) => entry.id === 'other');
  assert.deepEqual(other?.fields.map((entry) => [entry.labelKey, entry.value]), [
    ['CUP', 'ABC'],
    ['riferimento', 'R-7'],
  ]);
});

test('ultimo tentativo utente invalido resta visibile per la correzione', () => {
  const fields = sectionFields(quote({
    total: 122,
    fieldReliability: {
      total: {
        rawValue: 122,
        value: 122,
        source: 'merged',
        confidenceType: 'unknown',
        validationStatus: 'valid',
        validationReasons: [],
        requiresReview: true,
        alternatives: [{
          rawValue: '12x',
          source: 'user',
          confidenceType: 'unknown',
          validationStatus: 'invalid',
          validationReasons: ['invalid_amount'],
        }],
        conflict: false,
      },
    },
  }));
  assert.equal(fields.find((entry) => entry.id === 'total')?.value, '12x');
});

test('gruppi multipagina evitano duplicati e chiavi tecniche namespaced', () => {
  const vm = buildDocumentDetailsViewModel(quote({
    fieldReliability: {
      extractedFields: {
        rawValue: { page_1_CUP: 'ABC' },
        value: { page_1_CUP: 'ABC' },
        source: 'merged',
        confidenceType: 'unknown',
        validationStatus: 'unverified',
        validationReasons: [],
        requiresReview: true,
        alternatives: [],
        conflict: false,
      },
    },
    fieldMerge: {
      fields: {},
      fieldReliability: {},
      itemGroups: [],
      extractedFieldGroups: [{
        field: 'extractedFields',
        value: { CUP: 'ABC' },
        sourcePageIndex: 0,
        sourceMethod: 'local',
        validation: 'unverified',
        reason: 'page_group_preserved',
      }],
      conflicts: [],
      rawText: 'CUP ABC',
      includedPageIndexes: [0],
      pageIntegrity: { complete: true, issuePageIndexes: [] },
      requiresReview: true,
    },
  }));
  const fields = vm.sections.find((entry) => entry.id === 'other')?.fields ?? [];
  assert.deepEqual(fields.map((entry) => [entry.labelKey, entry.value]), [['CUP', 'ABC']]);
  assert.equal(fields[0].sourcePage, 1);
});

test('scheda normale mostra emittente condizioni banca e righe strutturate parziali', () => {
  const structuredExtraction = {
    schemaVersion: 1,
    metadata: { subject: evidence('Conferma ordine'), references: evidence(['RIF-7']), internalReference: evidence('CO17406'), customerReference: evidence('2026002581') },
    issuer: { role: 'issuer', name: evidence('KÜNZI S.p.A.'), address: { full: evidence('Via esempio 1') }, iban: evidence('IT60X0542811101000000123456'), conflicts: [], requiresReview: true },
    customer: { role: 'customer', name: evidence('Associazione Amici Trafoi'), address: { full: evidence('Via Trafoi 5') }, conflicts: [], requiresReview: true },
    items: [{ itemCode: evidence('V-0.61'), description: evidence('Multiuso Escort'), quantity: evidence(50), lineTotal: evidence(422.95), pageIndex: 0, sourceLineIds: ['p1-l2'], sourceLines: ['V-0.61 Multiuso Escort'], requiresReview: true }],
    summary: { shippingCost: evidence(15), taxSummaries: [{ vatRate: evidence(22), taxableAmount: evidence(100), vatAmount: evidence(22), pageIndex: 0, requiresReview: true }], conflicts: [], requiresReview: true },
    conditions: { paymentTerms: evidence('Bonifico Anticipato'), deliveryTerms: evidence('30 giorni'), bankDetails: evidence('Banca') },
    pages: [], complete: false, requiresRescan: false, requiresReview: true, reasons: [],
  } as StructuredDocumentExtraction;
  const vm = buildDocumentDetailsViewModel(order({ structuredExtraction }));
  assert.ok(vm.sections.find((entry) => entry.id === 'issuer')?.fields.some((entry) => entry.value === 'KÜNZI S.p.A.'));
  assert.ok(vm.sections.find((entry) => entry.id === 'customer')?.fields.some((entry) => entry.value === 'Via Trafoi 5'));
  assert.ok(vm.sections.find((entry) => entry.id === 'document')?.fields.some((entry) => entry.value === 'CO17406'));
  assert.ok(vm.sections.find((entry) => entry.id === 'document')?.fields.some((entry) => entry.value === '2026002581'));
  assert.ok(vm.sections.find((entry) => entry.id === 'conditions')?.fields.some((entry) => entry.value === 'Bonifico Anticipato'));
  assert.equal(vm.sections.find((entry) => entry.id === 'items')?.items[0].fields.some((entry) => entry.value === 'V-0.61'), true);
  assert.equal(vm.sections.find((entry) => entry.id === 'amounts')?.fields.some((entry) => entry.value === '15'), true);
  assert.equal(vm.sections.find((entry) => entry.id === 'amounts')?.fields.some((entry) => entry.labelKey === 'documentDetailsTaxSummaryVat'), true);
});

test('righe strutturate parziali veicolo e spedizione non sono nascosti dal modello legacy', () => {
  const structuredExtraction = {
    schemaVersion: 1,
    metadata: {},
    items: [
      {
        itemCode: evidence('KIT-1'), description: evidence('Kit distribuzione'),
        quantity: evidence(1), unitPrice: evidence(216.977), lineTotal: evidence(216.98),
        pageIndex: 0, sourceLineIds: ['p1-l1'], sourceLines: ['KIT-1 Kit distribuzione'], requiresReview: true,
      },
      {
        itemCode: evidence('PERS'), description: evidence('Manodopera interna'),
        unitPrice: evidence(50.0441), lineTotal: evidence(353.09),
        pageIndex: 0, sourceLineIds: ['p1-l2'], sourceLines: ['PERS Manodopera interna'], requiresReview: true,
      },
    ],
    vehicle: {
      make: evidence('RENAULT'), model: evidence('RENAULT CAPTUR'), plate: evidence('FG826MZ'),
      vin: evidence('VF12RAJ1D56655103'), registrationDate: evidence('20/12/2016'),
      kilometers: evidence(197000), engine: evidence('K9K E6'), requiresReview: true,
    },
    shipping: { terms: evidence('Porto franco'), carrier: evidence('BARTOLINI SPA'), cost: evidence(15), requiresReview: true },
    project: { name: evidence('MARMED'), reference: evidence('G61B22002400006'), requiresReview: true },
    delivery: { recipient: evidence('Magazzino'), address: evidence('Via deposito 2'), requiresReview: true },
    bank: { bankName: evidence('Banca'), iban: evidence('IT60X0542811101000000123456'), ownerRole: 'issuer', requiresReview: true },
    publicAdministrationData: { cup: evidence('G61B22002400006'), office: evidence('Ufficio gare'), requiresReview: true },
    summary: { taxSummaries: [], conflicts: [], requiresReview: true },
    conditions: {}, pages: [], complete: false, requiresRescan: false, requiresReview: true, reasons: [],
  } as StructuredDocumentExtraction;
  const vm = buildDocumentDetailsViewModel(order({
    items: [{ description: 'Riga legacy incompleta', quantity: 1, unitPrice: 1, total: 1 }],
    structuredExtraction,
  }));

  const displayedItems = vm.sections.find((entry) => entry.id === 'items')?.items ?? [];
  assert.equal(displayedItems.length, 2);
  assert.ok(displayedItems.some((entry) => entry.fields.some((field) => field.value === 'Manodopera interna')));
  assert.equal(displayedItems[1].fields.some((field) => field.labelKey === 'documentDetailsQuantity'), false);
  assert.ok(vm.sections.find((entry) => entry.id === 'vehicle')?.fields.some((entry) => entry.value === 'VF12RAJ1D56655103'));
  assert.ok(vm.sections.find((entry) => entry.id === 'shipping')?.fields.some((entry) => entry.value === 'BARTOLINI SPA'));
  assert.ok(vm.sections.find((entry) => entry.id === 'project')?.fields.some((entry) => entry.value === 'MARMED'));
  assert.ok(vm.sections.find((entry) => entry.id === 'delivery')?.fields.some((entry) => entry.value === 'Magazzino'));
  assert.ok(vm.sections.find((entry) => entry.id === 'bank')?.fields.some((entry) => entry.value === 'IT60X0542811101000000123456'));
  assert.ok(vm.sections.find((entry) => entry.id === 'publicAdministration')?.fields.some((entry) => entry.value === 'Ufficio gare'));
});

test('documento libero mostra il modello strutturato completo', () => {
  const structuredExtraction = {
    schemaVersion: 1, metadata: {},
    issuer: { role: 'issuer', name: evidence('Fornitore'), conflicts: [], requiresReview: false },
    customer: { role: 'customer', name: evidence('Cliente'), conflicts: [], requiresReview: false },
    recipient: { role: 'recipient', name: evidence('Destinatario'), conflicts: [], requiresReview: false },
    prospect: { role: 'prospect', name: evidence('Prospect distinto'), conflicts: [], requiresReview: false },
    items: [{ description: evidence('Servizio'), quantity: evidence(2), unitPrice: evidence(10), lineTotal: evidence(20), pageIndex: 0, sourceLineIds: [], sourceLines: [], requiresReview: false }],
    summary: { total: evidence(20), taxSummaries: [], conflicts: [], requiresReview: false },
    conditions: {}, pages: [], complete: true, requiresRescan: false, requiresReview: false, reasons: [],
  } as StructuredDocumentExtraction;
  const document: FreeDocument = { ...base, type: 'free_document', extractedFields: {}, structuredExtraction };
  const vm = buildDocumentDetailsViewModel(document);
  assert.ok(vm.sections.find((entry) => entry.id === 'issuer')?.fields.some((entry) => entry.value === 'Fornitore'));
  const parties = vm.sections.find((entry) => entry.id === 'customer')?.fields.map((entry) => entry.value) ?? [];
  assert.ok(parties.includes('Cliente'));
  assert.ok(parties.includes('Destinatario'));
  assert.ok(parties.includes('Prospect distinto'));
  assert.equal(vm.sections.find((entry) => entry.id === 'items')?.items.length, 1);
  assert.ok(vm.sections.find((entry) => entry.id === 'amounts')?.fields.some((entry) => entry.value === '20'));
});
