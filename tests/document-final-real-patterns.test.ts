import assert from 'node:assert/strict';
import test from 'node:test';
import { planCapturedDocumentOrientation } from '../lib/document-capture-orientation';
import { needsPortraitQuarterTurnProbe } from '../lib/document-orientation-evidence';
import { isPersistableCommercialItem } from '../lib/document-item-validity';
import { repairStructuredLineItemNumerics } from '../lib/document-line-item-numeric-repair';


test('Android processed: portrait intent + landscape bitmap + missing EXIF keeps visual quarter-turn eligible', () => {
  const input = {
    width: 4080,
    height: 3060,
    exifOrientation: null,
    deviceOrientationAtCapture: 'portrait' as const,
    previewOrientation: 'portrait' as const,
    platform: 'android' as const,
    cameraProcessingApplied: true,
  };
  const plan = planCapturedDocumentOrientation(input);
  assert.equal(plan.rotationRequired, 0);
  assert.equal(needsPortraitQuarterTurnProbe(input, plan), true);
});

test('settlement/deposit rows never become commercial items merely because they contain amounts', () => {
  assert.equal(isPersistableCommercialItem({
    description: 'Acconto ricevuto EUR 2.000,00',
    quantity: 1,
    unitPrice: 2000,
    lineTotal: 2000,
    sourceLines: ['Acconto ricevuto', 'EUR 2.000,00'],
  }), false);
  assert.equal(isPersistableCommercialItem({
    description: 'Balance due',
    lineTotal: 13731.59,
    sourceLines: ['Balance due', '13,731.59'],
  }), false);
});

test('split cents are recovered only when strict qty x price arithmetic supports them', () => {
  const repaired = repairStructuredLineItemNumerics({
    quantity: 306,
    unitPrice: 76.61,
    total: 44,
    quantityRaw: '306',
    unitPriceRaw: '76.61',
    lineTotalRaw: '44',
    sourceLines: ['Component', '76.61', '306', '44'],
  });
  assert.deepEqual(repaired, {
    quantity: 4,
    unitPrice: 76.61,
    total: 306.44,
    reason: 'split_cent_line_total_recovered',
  });
});

test('unrelated adjacent integers are not merged into a monetary total', () => {
  const repaired = repairStructuredLineItemNumerics({
    quantity: 306,
    unitPrice: 76.61,
    total: 44,
    quantityRaw: '306',
    unitPriceRaw: '76.61',
    lineTotalRaw: '44',
    sourceLines: ['Component', '76.61', '305', '44'],
  });
  assert.notEqual(repaired?.reason, 'split_cent_line_total_recovered');
});
