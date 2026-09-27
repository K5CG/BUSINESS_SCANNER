import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, OcrQualityMetadata } from '../types';
import {
  applyBusinessCardReocrProposal,
  buildBusinessCardReocrProposal,
  prepareBusinessCardReocrBatch,
} from '../lib/contact-reparse';
import {
  applyManualContactEdits,
  initializeParsedContactReviewState,
} from '../lib/contact-review-state';

const QUALITY: OcrQualityMetadata = {
  heuristicQuality: 0.9,
  confidenceType: 'heuristic',
  qualityReasons: [],
  requiresReview: false,
};

function savedCard(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return initializeParsedContactReviewState({
    id: 'real-reocr-v36',
    type: 'business_card',
    title: 'Vecchia azienda - Mario Rossi',
    images: ['scan://front', 'scan://back'],
    rawText: 'MARIO ROSSI\nVECCHIA AZIENDA',
    confidence: {
      firstName: 0.8,
      lastName: 0.8,
      company: 0.6,
      role: 0,
      emails: 0,
      phones: 0,
    },
    createdAt: new Date('2026-09-17T08:00:00.000Z'),
    updatedAt: new Date('2026-09-17T08:00:00.000Z'),
    firstName: 'Mario',
    lastName: 'Rossi',
    role: '',
    company: 'Vecchia azienda',
    emails: [],
    phones: [],
    ...overrides,
  });
}

test('V36: Rielabora da OCR legge davvero tutte le foto salvate in ordine', async () => {
  const calls: string[] = [];
  const result = await buildBusinessCardReocrProposal(savedCard(), {
    resolveImage: (uri) => `resolved:${uri}`,
    scanImage: async (uri) => {
      calls.push(uri);
      const text = uri.endsWith('front')
        ? 'DANTE CHIERICO\nPERITO INDUSTRIALE\nS.A.GE.MA. S.n.c.'
        : '36015 SCHIO (Vicenza) ITALY\nVia Molise, 12\nPartita IVA 00255760241';
      return { text, lines: [], quality: QUALITY };
    },
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['resolved:scan://front', 'resolved:scan://back']);
  assert.equal(
    result.reocrCard.rawText,
    'DANTE CHIERICO\nPERITO INDUSTRIALE\nS.A.GE.MA. S.n.c.\n\n' +
      '36015 SCHIO (Vicenza) ITALY\nVia Molise, 12\nPartita IVA 00255760241'
  );
  assert.equal(result.proposal?.candidate.company, 'S.A.GE.MA. S.n.c.');
  assert.equal(result.proposal?.candidate.vatNumber, '00255760241');
});

test('V36: annullamento implicito non modifica il contatto originale', async () => {
  const current = savedCard();
  const before = JSON.stringify(current);
  const result = await buildBusinessCardReocrProposal(current, {
    scanImage: async () => ({
      text: 'DANTE CHIERICO\nS.A.GE.MA. S.n.c.',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });

  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(current), before);
  assert.equal(current.rawText, 'MARIO ROSSI\nVECCHIA AZIENDA');
});

test('V36: apply conserva il nuovo raw OCR ma protegge un campo manuale', async () => {
  const current = applyManualContactEdits(savedCard(), {
    company: 'Azienda corretta manualmente',
  });
  const result = await buildBusinessCardReocrProposal(current, {
    scanImage: async () => ({
      text: 'DANTE CHIERICO\nPERITO INDUSTRIALE\nS.A.GE.MA. S.n.c.',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(result.status, 'ready');
  assert.ok(result.proposal);

  const applied = applyBusinessCardReocrProposal(
    current,
    result,
    ['company']
  );
  assert.equal(applied.status, 'applied');
  assert.equal(applied.appliedResult.company, 'Azienda corretta manualmente');
  assert.ok(applied.protectedFields.includes('company'));
  assert.match(applied.appliedResult.rawText ?? '', /S\.A\.GE\.MA/);
});

test('V36: senza immagini o senza nuovo testo fallisce chiuso', async () => {
  const noImages = await buildBusinessCardReocrProposal(
    savedCard({ images: [] })
  );
  assert.equal(noImages.status, 'missing_images');

  const current = savedCard();
  const noText = await buildBusinessCardReocrProposal(current, {
    scanImage: async () => ({ text: '', lines: [], quality: QUALITY }),
    resolveImage: (uri) => uri,
  });
  assert.equal(noText.status, 'no_text');
  assert.equal(noText.reocrCard.rawText, current.rawText);
  assert.equal(noText.proposal, null);
});

test('V36: una lease annullata ferma le pagine successive', async () => {
  let active = true;
  let calls = 0;
  const operation = {
    operationId: 'reocr-v36',
    invalidated: Promise.resolve('manual' as const),
    isActive: () => active,
    isCurrent: () => active,
    tryFinalize: () => active,
    runIfActive: (effect: () => void) => {
      if (!active) return false;
      effect();
      return true;
    },
  };

  const result = await buildBusinessCardReocrProposal(savedCard(), {
    operation,
    scanImage: async () => {
      calls += 1;
      active = false;
      return {
        text: 'MARIO ROSSI\nACME S.r.l.',
        lines: [],
        quality: QUALITY,
      };
    },
    resolveImage: (uri) => uri,
  });

  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
});

test('V36: il batch QA OCRizza una volta sola e prepara senza salvare', async () => {
  let calls = 0;
  const first = savedCard({ id: 'batch-1', images: ['scan://one'] });
  const second = savedCard({ id: 'batch-2', images: [] });
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [first, second],
    scanImage: async () => {
      calls += 1;
      return {
        text: 'DANTE CHIERICO\nPERITO INDUSTRIALE\nS.A.GE.MA. S.n.c.',
        lines: [],
        quality: QUALITY,
      };
    },
    resolveImage: (uri) => uri,
  });

  assert.equal(calls, 1);
  assert.equal(batch.total, 2);
  assert.equal(batch.ready, 1);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.contactId, 'batch-1');
  assert.equal(batch.skippedSamples[0]?.reason, 'missing_images');
  assert.equal(first.rawText, 'MARIO ROSSI\nVECCHIA AZIENDA');
});

test('V80: Rielabora tutti non applica campi che il parser ha marcato review', async () => {
  const current = savedCard({
    id: 'batch-review-safe',
    images: ['scan://degraded'],
    company: 'Azienda precedente verificata',
  });
  const degraded = `School of ManirygnGRI OSSERVATORLLNET
Chrisian Mondim`;
  const direct = await buildBusinessCardReocrProposal(current, {
    scanImage: async () => ({ text: degraded, lines: [], quality: QUALITY }),
    resolveImage: (uri) => uri,
  });
  assert.equal(direct.status, 'ready');
  assert.ok(direct.proposal?.candidate.extractionReview?.reviewFields.includes('company'));

  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [current],
    scanImage: async () => ({ text: degraded, lines: [], quality: QUALITY }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.next.company, 'Azienda precedente verificata');
});

test('V84: Rielabora tutti applica una company review solo con brand OCR e dominio della stessa carta', async () => {
  const current = savedCard({
    id: 'batch-proven-company',
    images: ['scan://proven-company'],
    company: 'Agricoltura, Alimentazione, Ambiente Spa',
  });
  const raw = `e-mail: andrea.verdi@cerealdocks.it
www.cerealdocks.it
Agricoltura, Alimentazione, Ambiente
Spa
CEREAL DOCKS`;
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [current],
    scanImage: async () => ({ text: raw, lines: [], quality: QUALITY }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items.length, 1);
  assert.match(batch.items[0]?.next.company ?? '', /^Cereal Docks\b/i);
});

test('V85: il ri-OCR ricompone brand, descrittore e forma legale osservati', async () => {
  const parsedInitial = savedCard({
    id: 'batch-legal-shell-regression',
    company: 'Derga S.r.l.',
    title: 'Derga S.r.l. - Stefano Pasin',
    firstName: 'Stefano',
    lastName: 'Pasin',
    emails: ['stefano.pasin@derga.it'],
    website: 'www.derga.it',
  });
  const current = {
    ...parsedInitial,
    company: 'GmbH S.r.l.',
    title: 'GmbH S.r.l. - Stefano Pasin',
  };
  const raw = `DERGAE
(0 N SULTING
GMBH SRL
SAP Consultant
STEFANO PASIN
stefano.pasin@derga.it
Italia
CONSULTING`;
  const direct = await buildBusinessCardReocrProposal(current, {
    scanImage: async () => ({ text: raw, lines: [], quality: QUALITY }),
    resolveImage: (uri) => uri,
  });
  assert.equal(direct.proposal?.candidate.company, 'Derga Consulting GMBH SRL');
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [current],
    scanImage: async () => ({ text: raw, lines: [], quality: QUALITY }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.next.company, 'Derga Consulting GMBH SRL');
});

test('V85: il dominio separato e il duplicato OCR migliore mantengono il brand leggibile', async () => {
  const threeA = savedCard({
    id: 'batch-domain-separated-brand',
    company: '3astrategy',
    images: ['scan://threea'],
    website: 'www.3a-strategy.com',
    emails: ['a.pohl@3a-strategy.com'],
  });
  const institute = savedCard({
    id: 'batch-near-duplicate-company',
    company: 'istituto Zooprofllattico',
    images: ['scan://institute'],
    website: 'www.izsvenezie.it',
    emails: ['a.ponzoni@izsvenezie.it'],
  });
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [threeA, institute],
    scanImage: async (uri) => ({
      text: uri.includes('threea')
        ? '3ASTRATEGY\nwww.3A-Strategy.com\naPohl@3A-Strategy.com'
        : 'istituto Zooprofllattico\nIstituto Zooprofilattico Sperimentale delle Venezie\na.ponzoni@izsvenezie.it',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.company, '3A Strategy');
  assert.equal(batch.items[1]?.next.company, 'Istituto Zooprofilattico Sperimentale delle Venezie');
});

test('V85: un nome con cifre OCR viene recuperato solo dopo etichetta Nome/Name', async () => {
  const current = savedCard({
    id: 'batch-labelled-name-ocr',
    firstName: '',
    lastName: 'Chiozza',
  });
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [current],
    scanImage: async () => ({
      text: 'Cognome - Family name\nCHIOZZA\nNome - First Names\n610VANNI',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.firstName, 'Giovanni');
});

test('V86: uno spazio nel cognome del titolare viene ripristinato solo con conferma nella stessa ragione sociale', async () => {
  const proprietor = savedCard({
    id: 'batch-owner-surname-spacing',
    company: 'DalCollo& Partners di Paola Dal Collo',
    firstName: 'Paola',
    lastName: 'Dal Collo',
    images: ['scan://owner-company'],
  });
  const compactBrand = savedCard({
    id: 'batch-compact-brand-safe',
    company: 'DeLonghi S.p.A.',
    firstName: 'Mario',
    lastName: 'De Longhi',
    images: ['scan://compact-brand'],
  });
  const direct = await buildBusinessCardReocrProposal(proprietor, {
    scanImage: async () => ({
      text: 'dott.ssa Paola Dal Collo\nDalCollo& Partners di Paola Dal Collo\npaola.dalcollo@example.it',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(direct.proposal?.candidate.firstName, 'Paola');
  assert.equal(direct.proposal?.candidate.lastName, 'Dal Collo');
  assert.equal(direct.proposal?.candidate.company, 'Dal Collo & Partners di Paola Dal Collo');
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [proprietor, compactBrand],
    scanImage: async (uri) => ({
      text: uri.includes('owner-company')
        ? 'dott.ssa Paola Dal Collo\nDalCollo& Partners di Paola Dal Collo\npaola.dalcollo@example.it'
        : 'Mario De Longhi\nDeLonghi S.p.A.\nmario@example.it',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.firstName, 'Paola');
  assert.equal(batch.items[0]?.next.lastName, 'Dal Collo');
  assert.equal(batch.items[0]?.next.company, 'Dal Collo & Partners di Paola Dal Collo');
  assert.equal(batch.items[1]?.next.company, 'DeLonghi S.p.A.');
});

test('V87: un blocco aziendale isolato non prolunga il ruolo e un’attivita non diventa azienda', async () => {
  const roleCard = savedCard({
    id: 'detached-role-noise',
    images: ['scan://detached-role'],
    company: 'Zecca Ufficio SPA',
  });
  const activityCard = savedCard({
    id: 'activity-not-company',
    images: ['scan://activity-not-company'],
    company: 'SERRAMENTI',
  });
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [roleCard, activityCard],
    scanImage: async (uri) => ({
      text: uri.includes('detached-role')
        ? 'ROBERTO CHIESA\nResponsabile Software\nAFOREFINANCE\nZECCA UFFICIO SPA'
        : 'di FLEACA\nSERRAMENTI\nMONTAGGIO E VENDITA\nemail: bfinfissi@example.it',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.role, 'Responsabile Software');
  assert.match(batch.items[0]?.next.company ?? '', /^Zecca Ufficio S\.?p\.?A\.?$/i);
  assert.equal(batch.items[1]?.next.company, '');
});

test('V87: non svuota un marchio monolemma senza la doppia prova di attivita e titolare', async () => {
  const current = savedCard({
    id: 'single-word-brand-safe',
    images: ['scan://single-word-brand'],
    company: 'Servoy',
  });
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [current],
    scanImage: async () => ({
      text: 'Servoy\nResponsabile Servoy Italia\nwww.servoy.com',
      lines: [],
      quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.company, 'Servoy');
});
