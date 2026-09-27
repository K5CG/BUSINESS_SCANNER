import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, Phone } from '../types';
import { mergeReparseWithQualityGate } from '../lib/reparse-quality-gate';

function phone(number: string, type: Phone['type'] = 'work'): Phone { return { number, type }; }
function card(fields: Partial<BusinessCard>): BusinessCard {
  return { id: 'qa', type: 'business_card', title: '', images: [], rawText: '', firstName: '', lastName: '', company: '', role: '', emails: [], phones: [], confidence: {}, createdAt: new Date(), updatedAt: new Date(), ...fields } as BusinessCard;
}

test('V101: telefoni binari e corti vengono scartati', () => {
  const result = mergeReparseWithQualityGate(
    card({ phones: [phone('+39 346 5012416', 'mobile')] }),
    card({ phones: [phone('0001001'), phone('1160001'), phone('+39 346 5012416', 'mobile')] }),
  );
  assert.deepEqual(result.card.phones.map((item) => item.number), ['+39 346 5012416']);
});

test('V101: conserva telefoni precedenti se tutti i nuovi sono rumore', () => {
  const result = mergeReparseWithQualityGate(
    card({ phones: [phone('+39 02 1234567')] }),
    card({ phones: [phone('0001001'), phone('0000100')] }),
  );
  assert.equal(result.card.phones[0]?.number, '+39 02 1234567');
});

test('V101: telefono internazionale reale non viene scartato', () => {
  const result = mergeReparseWithQualityGate(card({ phones: [] }), card({ phones: [phone('+81359017770')] }));
  assert.equal(result.card.phones[0]?.number, '+81359017770');
});

test('V101: ruolo specchio del nominativo viene rifiutato', () => {
  const result = mergeReparseWithQualityGate(
    card({ firstName: 'Stefano', lastName: 'Pasin', role: 'Area Manager' }),
    card({ firstName: 'Stefano', lastName: 'Pasin', role: 'STEFANO PASIN' }),
  );
  assert.equal(result.card.role, 'Area Manager');
});

test('V101: affiliazione universitaria non diventa ruolo', () => {
  const result = mergeReparseWithQualityGate(
    card({ role: 'ICT & Management' }), card({ role: 'POLITECNICO DI MILANO' }),
  );
  assert.equal(result.card.role, 'ICT & Management');
});

test('V101: garbage maiuscolo non sostituisce un ruolo valido', () => {
  const result = mergeReparseWithQualityGate(
    card({ role: 'Responsabile Commerciale' }), card({ role: 'AFOREFINANCE' }),
  );
  assert.equal(result.card.role, 'Responsabile Commerciale');
});

test('V101: CEO resta un ruolo valido', () => {
  const result = mergeReparseWithQualityGate(card({ role: '' }), card({ role: 'CEO' }));
  assert.equal(result.card.role, 'CEO');
});
