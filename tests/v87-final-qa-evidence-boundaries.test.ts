import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, OcrQualityMetadata } from '../types';
import { prepareBusinessCardReocrBatch } from '../lib/contact-reparse';
import { initializeParsedContactReviewState } from '../lib/contact-review-state';

const QUALITY: OcrQualityMetadata = {
  heuristicQuality: 0.9,
  confidenceType: 'heuristic',
  qualityReasons: [],
  requiresReview: false,
};

function card(id: string, company: string, image: string): BusinessCard {
  return initializeParsedContactReviewState({
    id,
    type: 'business_card',
    title: company,
    images: [image],
    rawText: company,
    confidence: { firstName: 0, lastName: 0, company: 0.7, role: 0, emails: 0, phones: 0 },
    createdAt: new Date('2026-09-25T12:00:00.000Z'),
    updatedAt: new Date('2026-09-25T12:00:00.000Z'),
    firstName: '',
    lastName: '',
    role: '',
    company,
    emails: [],
    phones: [],
  });
}

test('V87: blocco grafico separato non contamina il ruolo', async () => {
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [card('v87-role', 'Zecca Ufficio SPA', 'scan://role')],
    scanImage: async () => ({
      text: 'ROBERTO CHIESA\nResponsabile Software\nAFOREFINANCE\nZECCA UFFICIO SPA',
      lines: [], quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.role, 'Responsabile Software');
});

test('V87: descrittore di attivita senza brand resta vuoto, marchio monolemma resta', async () => {
  const batch = await prepareBusinessCardReocrBatch(undefined, {
    contacts: [
      card('v87-activity', 'SERRAMENTI', 'scan://activity'),
      card('v87-brand', 'Servoy', 'scan://brand'),
    ],
    scanImage: async (uri) => ({
      text: uri.includes('activity')
        ? 'di FLEACA\nSERRAMENTI\nMONTAGGIO E VENDITA\nemail: bfinfissi@example.it'
        : 'Servoy\nResponsabile Servoy Italia\nwww.servoy.com',
      lines: [], quality: QUALITY,
    }),
    resolveImage: (uri) => uri,
  });
  assert.equal(batch.items[0]?.next.company, '');
  assert.equal(batch.items[1]?.next.company, 'Servoy');
});
