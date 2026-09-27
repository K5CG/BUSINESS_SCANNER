import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMoneyLabel,
  isVatExcludedLanguage,
  resolveDocumentDiscountVsVat,
  sameAmountCannotBeTotalAndVat,
  type DocumentMoneyCandidate,
} from '../lib/document-money-semantics';
import { findSemanticDocumentTotals } from '../lib/document-semantic-fallback';
import { sanitizeDocumentMonetaryFields } from '../lib/document-monetary-guardrails';

function candidate(
  partial: Partial<DocumentMoneyCandidate> & Pick<DocumentMoneyCandidate, 'semanticClass' | 'value'>,
): DocumentMoneyCandidate {
  return {
    rawText: String(partial.value),
    sign: 1,
    confidence: 0.8,
    ...partial,
  };
}

test('15 total net of VAT + VAT excluded does not invent a VAT amount', () => {
  assert.equal(isVatExcludedLanguage('I prezzi si intendono al netto di IVA 22%'), true);
  assert.equal(classifyMoneyLabel('al netto di IVA 22%'), 'net_taxable');
  const totals = findSemanticDocumentTotals([
    'TOTALE TRIENNALE: €4.914,00',
    'I prezzi si intendono al netto di IVA 22%',
  ]);
  assert.equal(totals.total, 4914);
  assert.equal(totals.vat, undefined);
});

test('16 explicit VAT amount is kept', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({ semanticClass: 'net_taxable', value: 169500, label: 'Imponibile' }),
    candidate({ semanticClass: 'vat_amount', value: 37290, label: 'Importo IVA' }),
    candidate({ semanticClass: 'grand_total', value: 206790, label: 'TOTALE COMPLESSIVO' }),
  ]);
  assert.equal(resolved.vatAmount, 37290);
  assert.equal(resolved.netTaxable, 169500);
});

test('17 VAT rate only, no VAT amount', () => {
  assert.equal(classifyMoneyLabel('IVA 22%'), 'vat_rate');
  const totals = findSemanticDocumentTotals([
    'Totale 1.400,00€',
    'IVA 22%',
  ]);
  assert.equal(totals.total, 1400);
  assert.equal(totals.vat, undefined);
});

test('18 same number cannot become total + VAT', () => {
  assert.equal(sameAmountCannotBeTotalAndVat(4914, 4914), true);
  const sanitized = sanitizeDocumentMonetaryFields({
    total: 4914,
    vatAmount: 4914,
  });
  assert.equal(sanitized.total, 4914);
  assert.equal(sanitized.vatAmount, undefined);
});

test('19 discount + net taxable + VAT + total stays consistent', () => {
  const resolved = resolveDocumentDiscountVsVat([
    candidate({ semanticClass: 'gross', value: 1000, label: 'Lordo' }),
    candidate({ semanticClass: 'discount', value: 100, label: 'Sconto merce' }),
    candidate({ semanticClass: 'net_taxable', value: 900, label: 'Imponibile' }),
    candidate({ semanticClass: 'vat_amount', value: 198, label: 'Importo IVA' }),
    candidate({ semanticClass: 'grand_total', value: 1098, label: 'Totale documento' }),
  ]);
  assert.equal(resolved.discount, -100);
  assert.equal(resolved.netTaxable, 900);
  assert.equal(resolved.vatAmount, 198);
});

test('20 summary total with no subtotal keeps the total and no fabricated VAT', () => {
  const totals = findSemanticDocumentTotals(['Totale 1.400,00€']);
  assert.equal(totals.total, 1400);
  assert.equal(totals.subtotal, undefined);
  assert.equal(totals.vat, undefined);
});
