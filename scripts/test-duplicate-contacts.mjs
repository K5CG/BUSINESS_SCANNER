import assert from 'node:assert/strict';
import {
  findContactDuplicate,
  areDistinctPeople,
} from '../lib/duplicate-contacts-core.ts';
function card(partial) {
  const value = {
    id: partial.id ?? `test-${Math.random().toString(36).slice(2, 10)}`,
    type: 'business_card',
    title: '',
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    rawText: '',
    firstName: '',
    lastName: '',
    role: '',
    company: '',
    emails: [],
    phones: [],
    ...partial,
  };
  value.emailEvidence ??= value.emails.map((email) => ({
    value: email.toLowerCase(),
    rawValue: email,
    origin: 'user',
    pageIndex: null,
    lineId: null,
    rawOcr: email,
    transformations: ['test_user_confirmed'],
    confidence: 1,
    validationStatus: 'valid',
    requiresReview: false,
    confirmed: true,
  }));
  return value;
}

const serenissimaPhone = '+39 049 8291111';
const existing = [
  card({
    firstName: 'Filippo',
    lastName: 'Filippi',
    company: 'Serenissima Informatica S.p.A',
    emails: ['filippo.filippi@serinf.it'],
    phones: [{ number: serenissimaPhone, type: 'work' }],
  }),
];

const colleague = card({
  firstName: 'Orazio',
  lastName: 'Roverato',
  company: 'Serenissima Informatica S.p.A',
  emails: ['orazio.roverato@serinf.it'],
  phones: [{ number: serenissimaPhone, type: 'work' }],
});

assert.equal(areDistinctPeople(existing[0], colleague), true);
assert.equal(findContactDuplicate(colleague, existing), null, 'colleagues with shared switchboard phone');

const trueDup = card({
  firstName: 'Filippo',
  lastName: 'Filippi',
  company: 'Serenissima Informatica S.p.A',
  emails: ['filippo.filippi@serinf.it'],
});
assert.ok(findContactDuplicate(trueDup, existing)?.reason === 'email', 'same person same email');

const sameNameOnly = card({
  firstName: 'Filippo',
  lastName: 'Filippi',
  company: 'Altra Azienda',
});
assert.ok(findContactDuplicate(sameNameOnly, existing)?.reason === 'name', 'medium duplicate on name only');

console.log('duplicate-contacts: 4/4 OK');
