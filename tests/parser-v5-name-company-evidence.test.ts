import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeCompanyValue,
  finalizePersonFields,
} from '../lib/parser-v5/finalize';
import { isMarketingSloganCompanyLine } from '../lib/parser-v5/semantic-class';

test('nome osservato e claim aziendale rispettano la gerarchia delle evidenze', () => {
  assert.deepEqual(
    finalizePersonFields(
      'Piero',
      'Rossi',
      'Piero Rossi',
      ['pietro.rossi@north-labs.example'],
      [
        'NORTH LABS LTD.',
        'Piero Rossi',
        'Sales Director',
        'pietro.rossi@north-labs.example',
      ].join('\n'),
      'North Labs Ltd.'
    ),
    { firstName: 'Piero', lastName: 'Rossi' }
  );

  assert.deepEqual(
    finalizePersonFields(
      'Michael',
      'Chang',
      'Michael Chang',
      ['michela.chang@north-labs.example'],
      'Michael Chang\nmichela.chang@north-labs.example',
      'North Labs Ltd.'
    ),
    { firstName: 'Michael', lastName: 'Chang' }
  );

  assert.deepEqual(
    finalizePersonFields(
      'Marco',
      'Ferrati',
      'FERRATI MARCO',
      [],
      'FERRATI MARCO\nManaging Director',
      'North Labs Ltd.'
    ),
    { firstName: 'Marco', lastName: 'Ferrati' }
  );

  assert.equal(isMarketingSloganCompanyLine('Inspire the Next'), true);
  assert.equal(
    finalizeCompanyValue(
      'Inspire the Next',
      [],
      'Inspire the Next\nWeb: www.meridian-works.example'
    ),
    'Meridian Works'
  );
  assert.equal(
    finalizeCompanyValue(
      null,
      [],
      'Inspire the Next\nWeb: www.meridian-works.example'
    ),
    'Meridian Works'
  );
  assert.equal(
    finalizeCompanyValue(
      'Inspire the Next',
      ['piero.rossi@gmail.com'],
      'Inspire the Next\npiero.rossi@gmail.com'
    ),
    null
  );
});
