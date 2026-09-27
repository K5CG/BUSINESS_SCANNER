import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard } from '../types';
import { mergeReparseWithQualityGate } from '../lib/reparse-quality-gate';

function card(fields: Partial<BusinessCard>): BusinessCard {
  return {
    id: 'qa', type: 'business_card', title: '', images: [], rawText: '',
    firstName: '', lastName: '', company: '', role: '', emails: [], phones: [],
    confidence: {}, createdAt: new Date(), updatedAt: new Date(),
    ...fields,
  } as BusinessCard;
}

test('V98: ri-OCR non scambia professione e azienda', () => {
  const result = mergeReparseWithQualityGate(
    card({ company: 'Garbin', role: 'Dottore Commercialista' }),
    card({ company: 'Revisore Contabile', role: 'GARBIN' }),
  );
  assert.equal(result.card.company, 'Garbin');
  assert.equal(result.card.role, 'Dottore Commercialista');
  assert.ok(result.decisions.some((item) => item.field === 'company' && item.decision === 'keep_old'));
  assert.ok(result.decisions.some((item) => item.field === 'role' && item.decision === 'keep_old'));
});

test('V98: ri-OCR non mette il nominativo nel ruolo', () => {
  const result = mergeReparseWithQualityGate(
    card({ firstName: 'Filippo', lastName: 'De Guio', company: 'Infodati S.p.A.', role: 'Sales Manager' }),
    card({ firstName: 'Filippo', lastName: 'De Guio', company: 'Infodati S.p.A.', role: 'FILIPPO DE GUIO' }),
  );
  assert.equal(result.card.role, 'Sales Manager');
});

test('V98: un vero miglioramento aziendale resta applicabile', () => {
  const result = mergeReparseWithQualityGate(
    card({ company: 'SPEGDARIK', role: '' }),
    card({ company: 'Speedmark S.r.l.', role: '' }),
  );
  assert.equal(result.card.company, 'Speedmark S.r.l.');
});

test('V99: conserva il cognome iniziale contro una regressione OCR di una lettera', () => {
  const result = mergeReparseWithQualityGate(
    card({
      firstName: 'Luigi', lastName: 'De Francesoh', rawText: 'D.F. Interni di De Franceschi Luigi & C. SAS.',
      contactReviewState: { tracking: 'parsed', manualOverrides: {}, parsedInitial: { lastName: 'De Franceschi' } } as any,
    }),
    card({ firstName: 'Luigi', lastName: 'De Francesoh' }),
  );
  assert.equal(result.card.lastName, 'De Franceschi');
});

test('V99: conserva ruolo iniziale quando il candidato è un frammento della società', () => {
  const result = mergeReparseWithQualityGate(
    card({
      company: 'GARBIN & Maule', role: 'GARBIN',
      contactReviewState: { tracking: 'parsed', manualOverrides: {}, parsedInitial: { company: 'Garbin', role: 'Dottore Commercialista' } } as any,
    }),
    card({ company: 'GARBIN & Maule', role: 'GARBIN' }),
  );
  assert.equal(result.card.role, 'Dottore Commercialista');
});

test('V100: applica lo snapshot dopo la fusione contro un brand dominio incollato', () => {
  const result = mergeReparseWithQualityGate(
    card({
      company: 'OSSERVATORI.NETICT& Managenment', rawText: 'OSSERVATORI.NET\nICT & Management',
      contactReviewState: { tracking: 'parsed', manualOverrides: {}, parsedInitial: { company: 'OSSERVATORI.NET' } } as any,
    }),
    card({ company: 'OSSERVATORI.NETICT& Managenment' }),
  );
  assert.equal(result.card.company, 'OSSERVATORI.NET');
});
