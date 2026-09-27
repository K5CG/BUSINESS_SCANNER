import assert from 'node:assert/strict';
import test from 'node:test';
import {
  customerExportBcp47,
  formatCustomerDocumentDate,
  formatCustomerExportDecimal,
  formatCustomerExportMoney,
  formatCustomerExportMoneyWithCurrency,
  formatCustomerExportPercent,
  formatCustomerExportQuantity,
  formatCustomerExportTimestamp,
  toCustomerExcelDate,
} from '../lib/export-customer-format.ts';

test('Italian and English locales use it-IT and en-US', () => {
  assert.equal(customerExportBcp47('it'), 'it-IT');
  assert.equal(customerExportBcp47('en'), 'en-US');
});

test('Italian numeric format uses . thousands and , decimals', () => {
  assert.equal(formatCustomerExportDecimal(1000.13, 'it', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), '1.000,13');
  assert.equal(formatCustomerExportMoney(169500, 'it'), '169.500,00');
  assert.equal(formatCustomerExportMoney(18500, 'it'), '18.500,00');
});

test('English numeric format uses , thousands and . decimals', () => {
  assert.equal(formatCustomerExportDecimal(1000.13, 'en', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), '1,000.13');
  assert.equal(formatCustomerExportMoney(169500, 'en'), '169,500.00');
});

test('percent and quantity formatting keep locale separators', () => {
  assert.equal(formatCustomerExportPercent(22, 'it'), '22%');
  assert.equal(formatCustomerExportPercent(22.5, 'it'), '22,5%');
  assert.equal(formatCustomerExportPercent(22, 'en'), '22%');
  assert.equal(formatCustomerExportQuantity(2, 'it'), '2');
  assert.equal(formatCustomerExportQuantity(2.5, 'it'), '2,5');
});

test('currency code is appended and never assumed to be EUR', () => {
  assert.equal(formatCustomerExportMoneyWithCurrency(18500, 'it', 'EUR'), '18.500,00 EUR');
  assert.equal(formatCustomerExportMoneyWithCurrency(18500, 'en', 'usd'), '18,500.00 USD');
  assert.equal(formatCustomerExportMoneyWithCurrency(18500, 'it', undefined), '18.500,00');
});

test('document dates omit midnight time and follow locale order', () => {
  const date = new Date(2025, 4, 23, 0, 0, 0);
  assert.equal(formatCustomerDocumentDate(date, 'it'), '23/05/2025');
  assert.equal(formatCustomerDocumentDate(date, 'en'), '05/23/2025');
});

test('created/updated timestamps keep date and time', () => {
  const date = new Date(2026, 7, 14, 10, 5, 0);
  assert.equal(formatCustomerExportTimestamp(date, 'it'), '14/08/2026 10:05');
  assert.equal(formatCustomerExportTimestamp(date, 'en'), '08/14/2026 10:05');
});

test('Excel date helper keeps calendar day and optional time', () => {
  const midnight = new Date(2025, 4, 23, 0, 0, 0);
  const dateOnly = toCustomerExcelDate(midnight, 'date');
  const dateTime = toCustomerExcelDate(new Date(2026, 7, 14, 10, 5, 0), 'datetime');
  assert.ok(dateOnly instanceof Date);
  assert.equal(dateOnly.getDate(), 23);
  assert.equal(dateOnly.getHours(), 12);
  assert.ok(dateTime instanceof Date);
  assert.equal(dateTime.getHours(), 10);
  assert.equal(dateTime.getMinutes(), 5);
  assert.equal(toCustomerExcelDate(undefined, 'date'), '');
});
