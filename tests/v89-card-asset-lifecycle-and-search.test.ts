import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { BusinessCard } from '../types';
import { contactMatchesQuery } from '../lib/contact-search';
import { imagePipelineUris } from '../lib/image-preparation';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

function card(company: string): BusinessCard {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'business_card',
    title: company,
    images: [],
    rawText: company,
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    firstName: 'Alexander',
    lastName: 'Pohl',
    role: '',
    company,
    emails: [],
    phones: [],
  };
}

test('V89: il ritaglio resta foto mostrata, originale separato per ri-OCR', () => {
  const uris = imagePipelineUris('file:///cache/original.jpg', 'file:///cache/crop.jpg');
  assert.equal(uris.previewUri, 'file:///cache/crop.jpg');
  assert.equal(uris.persistenceSourceUri, 'file:///cache/crop.jpg');
  assert.notEqual(uris.originalUri, uris.persistenceSourceUri);

  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const workflow = read('lib/scan-process-workflow.ts');
  const persistence = read('lib/persistence.ts');
  const reocr = read('lib/contact-reparse.ts');
  assert.match(scanner, /copyImageToDraftStorage\(imageUris\.persistenceSourceUri\)/);
  assert.match(scanner, /copyImageToDraftStorage\(imageUris\.originalUri\)/);
  assert.match(scanner, /originalImageUris: cardOriginalImageUris/);
  assert.match(workflow, /originalImages: \[\.\.\.originalImageUris\]/);
  assert.match(persistence, /collectDocumentAssetUris\(contact\)/);
  assert.match(reocr, /const reocrImages/);
});

test('V89: le sigle alfanumeriche di due caratteri sono ricercabili', () => {
  const threeA = card('3A Strategy');
  assert.equal(contactMatchesQuery(threeA, '3A'), true);
  assert.equal(contactMatchesQuery(card('Altro'), '3A'), false);
  assert.equal(contactMatchesQuery(threeA, 'al'), true);
});
