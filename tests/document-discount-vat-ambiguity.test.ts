import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMoneyLabel,
  looksLikeVatRateNotAmount,
  resolveDocumentDiscountVsVat,
  type DocumentMoneyCandidate,
} from '../lib/document-money-semantics';

function candidate(
  partial: Partial<DocumentMoneyCandidate> & Pick<DocumentMoneyCandidate, 'semanticClass' | 'value'>,
): DocumentMoneyCandidate {
  return {
    rawText: String(partial.value),
    sign: partial.semanticClass === 'discount' ? -1 : 1,
    confidence: 0.8,
    ...partial,
  };
}

test('label classification keeps discount, VAT amount, labor and rates distinct', () => {
  assert.equal(classifyMoneyLabel('Sconto merce'), 'discount');
  assert.equal(classifyMoneyLabel('IVA 22%'), 'vat_rate');
  assert.equal(classifyMoneyLabel('Importo IVA'), 'vat_amount');
  assert.equal(classifyMoneyLabel('Manodopera'), 'labor');
  assert.equal(classifyMoneyLabel('Sconto'), 'unknown');
});

test('a value near 22 is a rate, not a VAT amount', () => {
  assert.equal(looksLikeVatRateNotAmount(22, '22'), true);
  assert.equal(looksLikeVatRateNotAmount(133.86, '133,86'), false);
});

test('discount equal to VAT amount is dropped', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({ semanticClass: 'discount', value: 122, label: 'Sconto' }),
    candidate({ semanticClass: 'vat_amount', value: 122, label: 'IVA' }),
    candidate({ semanticClass: 'grand_total', value: 1400, label: 'Totale documento' }),
  ]);
  assert.equal(resolved.discount, undefined);
  assert.equal(resolved.vatAmount, 122);
  assert.equal(resolved.reason, 'discount_equals_vat_amount_dropped_discount');
});

test('gross minus discount equals taxable when labels agree', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({ semanticClass: 'gross', value: 1000, label: 'Lordo' }),
    candidate({ semanticClass: 'discount', value: 100, label: 'Sconto merce' }),
    candidate({ semanticClass: 'net_taxable', value: 900, label: 'Imponibile' }),
    candidate({ semanticClass: 'vat_amount', value: 198, label: 'IVA' }),
    candidate({ semanticClass: 'grand_total', value: 1098, label: 'Totale documento' }),
  ]);
  assert.equal(resolved.discount, -100);
  assert.equal(resolved.netTaxable, 900);
  assert.equal(resolved.vatAmount, 198);
});

test('unlabeled negative amount is not promoted to discount', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({ semanticClass: 'unknown', value: -122, rawText: '-122', confidence: 0.9 }),
    candidate({ semanticClass: 'grand_total', value: 1400, label: 'Totale' }),
  ]);
  assert.equal(resolved.discount, undefined);
  assert.equal(resolved.reason, 'no_safe_discount_or_vat_semantics');
});

test('row-level remise percent does not become a document discount', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({
      semanticClass: 'unknown',
      value: 10355,
      rawText: '10 355,00',
      label: 'Remise %',
      confidence: 0.8,
    }),
    candidate({ semanticClass: 'vat_amount', value: 7929.8, label: 'TVA' }),
    candidate({ semanticClass: 'grand_total', value: 47578.8, label: 'TOTAL TTC' }),
  ]);
  assert.equal(resolved.discount, undefined);
});

test('unlabeled line total is not a document discount', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({ semanticClass: 'unknown', value: 10355, rawText: '10 355,00' }),
    candidate({ semanticClass: 'vat_amount', value: 7929.8, label: 'TVA' }),
    candidate({ semanticClass: 'net_taxable', value: 39649, label: 'TOTAL HT' }),
    candidate({ semanticClass: 'grand_total', value: 47578.8, label: 'TOTAL TTC' }),
  ]);
  assert.equal(resolved.discount, undefined);
});

test('percentage is not a VAT amount', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({
      semanticClass: 'vat_amount',
      value: 22,
      rawText: '22%',
      label: 'IVA',
      confidence: 0.9,
    }),
    candidate({ semanticClass: 'grand_total', value: 1400, label: 'Totale' }),
  ]);
  assert.equal(resolved.vatAmount, undefined);
});
