import { extractExplicitLabelFields } from '../lib/parser-v5/explicit-labels.ts';

const t = [
  'Cognome - Family name',
  'CHIOZZA',
  'Nome - First Names',
  'GI0VANHI',
].join('\n');

console.log(extractExplicitLabelFields(t));
