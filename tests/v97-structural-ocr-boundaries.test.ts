import assert from 'node:assert/strict';
import test from 'node:test';
import { isOcrImageDimensionEligible } from '../lib/ocr';
import { recoverCompanyFromStructuralEvidence, recoverStandaloneRoleFromRaw } from '../lib/contact-reparse';
import { tryAssembleItalianSedeOperativaAddress } from '../lib/parser-v5/address-assembly';
import { buildBusinessCardReocrProposal } from '../lib/contact-reparse';
import { initializeParsedContactReviewState } from '../lib/contact-review-state';

test('V97: JPEG degenerati non arrivano mai al riconoscitore nativo', () => {
  assert.equal(isOcrImageDimensionEligible({ width: 1800, height: 2 }), false);
  assert.equal(isOcrImageDimensionEligible({ width: 3000, height: 4 }), false);
  assert.equal(isOcrImageDimensionEligible({ width: 1644, height: 1055 }), true);
});

test('V97: dominio osservato separa brand fuso e batte il logo non corroborato', () => {
  assert.equal(
    recoverCompanyFromStructuralEvidence(
      'SPEGDARIK',
      ['piero@speedmark.it', 'info@speedmark.it'],
      'www.speedmark.it',
      'SPEGDARIK\npiero@speedmark.it\ninfo@speedmark.it\nwww.speedmark.it',
    ),
    'Speedmark',
  );
  assert.equal(
    recoverCompanyFromStructuralEvidence(
      'ORIUM', ['manzoni@corium-mi.it'], undefined,
      'ORIUM\nmanzoni@corium-mi.it',
    ),
    'CORIUM',
  );
  assert.equal(
    recoverCompanyFromStructuralEvidence(
      '3astrategy', ['apohl@3a-strategy.com'], 'www.3a-strategy.com',
      '3ASTRATEGY\napohl@3a-strategy.com\nwww.3a-strategy.com',
    ),
    '3A Strategy',
  );
});

test('V97: frase societaria osservata collegata al dominio non viene sostituita da rumore', () => {
  assert.equal(
    recoverCompanyFromStructuralEvidence(
      'SANDS', ['paola@dalcolloepartners.com'], 'www.dalcolloepartners.com',
      'DalCollo & Partners di Paola Dal Collo\nwww.dalcolloepartners.com',
    ),
    'DalCollo & Partners',
  );
});

test('V97: civico italiano composto resta completo', () => {
  const parsed = tryAssembleItalianSedeOperativaAddress([
    { id: 1, page: 0, indexInPage: 0, text: 'Sede operativa' },
    { id: 2, page: 0, indexInPage: 1, text: 'Via Lambruschini, 4b ed. 26B' },
    { id: 3, page: 0, indexInPage: 2, text: '20156 Milano (MI)' },
  ]);
  assert.match(parsed?.full ?? '', /4b ed\. 26B/i);
  assert.equal(parsed?.civicNumber, '4b ed. 26B');
});

test('V97: ruolo isolato in maiuscolo resta ruolo con contesto testuale', () => {
  assert.equal(
    recoverStandaloneRoleFromRaw(
      '', 'TURETTA GIANCARLO',
      'TURETTA GIANCARLO\nPavimenti e Rivestimenti\nPOSATORE\n328.21.92.117',
    ),
    'POSATORE',
  );
});

test('V97: mailbox fusa usa soltanto sito e nominativo osservati', async () => {
  const rawText = 'ISIS\nAlesSIO GIullano\nalesSIO.gILullanoOISISware.Com\nWww.ISISware.com';
  const card = initializeParsedContactReviewState({
    id: 'v97-mail', type: 'business_card', title: 'ISIS', images: ['scan://front'], rawText: 'old',
    firstName: '', lastName: '', role: '', company: 'ISIS', emails: [], phones: [], confidence: {},
    createdAt: new Date(), updatedAt: new Date(),
  });
  const result = await buildBusinessCardReocrProposal(card, {
    resolveImage: (uri) => uri,
    scanImage: async () => ({ text: rawText, quality: { heuristicQuality: 0.9, confidenceType: 'heuristic' as const, qualityReasons: [], requiresReview: false }, lines: rawText.split('\n').map((text, index) => ({ text, confidence: 0.95, boundingBox: { x: 0, y: index * 20, width: 300, height: 18 } })) }),
  });
  assert.ok(result.proposal);
  assert.ok(result.proposal.candidate.emails.includes('alessio.giullano@isisware.com'), JSON.stringify(result.proposal.candidate.emails));
});

test('V97: mailbox fusa usa il nominativo gia confermato se la foto non lo ripete', async () => {
  const rawText = 'ISIS\nalesSIO.gILullanoOISISware.Com\nWww.ISISware.com';
  const card = initializeParsedContactReviewState({
    id: 'v97-mail-existing', type: 'business_card', title: 'ISIS', images: ['scan://front'], rawText: 'old',
    firstName: 'Alessio', lastName: 'Giullano', role: '', company: 'ISIS', emails: [], phones: [], confidence: {},
    createdAt: new Date(), updatedAt: new Date(),
  });
  const result = await buildBusinessCardReocrProposal(card, {
    resolveImage: (uri) => uri,
    scanImage: async () => ({ text: rawText, quality: { heuristicQuality: 0.9, confidenceType: 'heuristic' as const, qualityReasons: [], requiresReview: false }, lines: rawText.split('\n').map((text, index) => ({ text, confidence: 0.95, boundingBox: { x: 0, y: index * 20, width: 300, height: 18 } })) }),
  });
  assert.ok(result.proposal);
  assert.ok(result.proposal.candidate.emails.includes('alessio.giullano@isisware.com'), JSON.stringify(result.proposal.candidate.emails));
});
