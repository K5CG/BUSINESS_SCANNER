import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard } from '../types';
import { reparseBusinessCardWithDecisions } from '../lib/contact-reparse';
import { initializeParsedContactReviewState } from '../lib/contact-review-state';

function savedCard(rawText: string, company: string): BusinessCard {
  return initializeParsedContactReviewState({
    id: `v44-${company}`,
    type: 'business_card',
    title: company,
    images: ['scan://front'],
    rawText,
    firstName: '',
    lastName: '',
    role: '',
    company,
    emails: [],
    phones: [],
    confidence: {
      firstName: 0.9, lastName: 0.9, company: 0.9, role: 0.9,
      emails: 0.9, phones: 0.9, website: 0.9, address: 0.9,
    },
    createdAt: new Date('2026-09-18T00:00:00.000Z'),
    updatedAt: new Date('2026-09-18T00:00:00.000Z'),
  });
}

test('V44 bulk reparse recupera email fuse dal raw OCR gia salvato', () => {
  const technical = reparseBusinessCardWithDecisions(savedCard(
    `TECHNICAL TOUCH bvba
e-mail: info@technical-touch.com-www.technical-touch.com`,
    'TECHNICAL TOUCH BVBA'
  )).card;
  assert.ok(technical.emails.includes('info@technical-touch.com'));

  const isis = reparseBusinessCardWithDecisions({
    ...savedCard(
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
Www.ISISware.com`,
      'ISIS'
    ),
    firstName: 'Alessio',
    lastName: 'Giullano',
  }).card;
  assert.ok(isis.emails.includes('alessio.giullano@isisware.com'));
});
