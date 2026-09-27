import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInternationalDate } from '../lib/document-international-values';
import { classifyMoneyLabel, sameAmountCannotBeTotalAndVat } from '../lib/document-money-semantics';
import { repairStructuredLineItemNumerics } from '../lib/document-line-item-numeric-repair';
import { isLegalOrBankFooterText, isNonCommercialItemDescription } from '../lib/document-item-validity';
import { decideFallbackReplacement } from '../lib/document-field-quality';
import { resolveExclusivePartyRoles, shouldReplacePartyValue } from '../lib/document-party-roles';
import {
  createSharedScanDeadlineAfterOcr,
  createStructuredProcessDeadline,
  SINGLE_PAGE_PROCESS_HARD_MS,
} from '../lib/scan-process-deadline';
import { resolvePortraitQuarterTurnRotation } from '../lib/document-orientation-evidence';

test('written Spanish and English issue dates parse', () => {
  assert.equal(parseInternationalDate('20 de mayo de 2025', 'es').normalizedValue, '2025-05-20');
  assert.equal(parseInternationalDate('16 May 2025', 'en').normalizedValue, '2025-05-16');
});

test('TOTAL label outranks net taxable language', () => {
  assert.equal(classifyMoneyLabel('Base imponible neta'), 'net_taxable');
  assert.equal(classifyMoneyLabel('TOTAL:'), 'grand_total');
  assert.equal(classifyMoneyLabel('TOTAL DUE'), 'grand_total');
  assert.equal(sameAmountCannotBeTotalAndVat(1908.9, 10998.9), false);
});

test('arithmetic recovers explicit quantity when default 1 mismatches', () => {
  const manodopera = repairStructuredLineItemNumerics({
    quantity: 1,
    unitPrice: 50.4414,
    total: 353.09,
    sourceLines: ['MANODOPERA INTERNA', '7 h', '50,4414', '353,09'],
  });
  assert.equal(manodopera?.quantity, 7);
  const modules = repairStructuredLineItemNumerics({
    quantity: 1,
    unitPrice: 129,
    total: 3421.2,
    discount: 5,
    sourceLines: ['Módulo fotovoltaico 550 Wp', '28 ud', '129,00', '5,00%', '3.421,20'],
  });
  assert.equal(modules?.quantity, 28);
  const noToken = repairStructuredLineItemNumerics({
    quantity: 1,
    unitPrice: 50.4414,
    total: 353.09,
    sourceLines: ['MANODOPERA INTERNA', 'H', '50,4414', '353,09'],
  });
  assert.equal(noToken?.quantity, 1);
});

test('legal footer and IBAN cannot be commercial items', () => {
  assert.equal(isLegalOrBankFooterText('Inscrita en el Registro Mercantil de Alicante, Tomo 4001'), true);
  assert.equal(isNonCommercialItemDescription('IBAN: ES44 2100 1234 5602 0012 3456 Registro Mercantil'), true);
});

test('fallback cannot replace a coherent total or customer', () => {
  assert.equal(decideFallbackReplacement('COHERENT', 'WEAK'), 'fallback_rejected_weaker');
  assert.equal(decideFallbackReplacement('EMPTY', 'STRONG'), 'fallback_fill');
  assert.equal(shouldReplacePartyValue('St. Raphael Community Clinic', 'Medisupply Horizon GmbH - EU Branch'), false);
  const exclusive = resolveExclusivePartyRoles({
    issuer: 'Medisupply Horizon GmbH - EU Branch',
    customer: 'Medisupply Horizon GmbH - EU Branch',
  });
  assert.equal(exclusive.customer, null);
});

test('structured deadline is independent of simulated OCR consumption', () => {
  const before = Date.now();
  const structured = createStructuredProcessDeadline(1);
  const sharedAfterOcr = createSharedScanDeadlineAfterOcr(1, 8_500);
  assert.ok(structured - before >= SINGLE_PAGE_PROCESS_HARD_MS - 50);
  assert.ok(sharedAfterOcr - before < 2_000);
});

test('close 90 vs 270 prefers the rotation with header ink at top', () => {
  const decision = resolvePortraitQuarterTurnRotation(
    { topInk: 0.10, bottomInk: 0.40 },
    { topInk: 0.42, bottomInk: 0.08 },
  );
  assert.equal(decision.rotation, 270);
});
