import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import {
  extractBusinessCardV5,
  parseCardFromPagesV5,
} from '../lib/parser-v5';
import {
  extractCardV5,
  type CardPageV5,
  type V5Result,
} from '../lib/parser-v5/engine';
import {
  collectEmailEvidence,
  type EmailEvidenceLine,
} from '../lib/parser-v5/email-evidence';
import {
  collectNumericEvidence,
  resolveNumericEvidence,
  type NumericEvidenceLine,
} from '../lib/parser-v5/numeric-evidence';

interface PageOptions {
  prominentLineIndexes?: readonly number[];
}

const REQUIRED_SCENARIO_COUNT = 22;
let registeredScenarioCount = 0;

function scenario(name: string, body: () => void): void {
  registeredScenarioCount += 1;
  test(name, body);
}

function page(
  textLines: readonly string[],
  options: PageOptions = {}
): CardPageV5 {
  const prominent = new Set(options.prominentLineIndexes ?? [0]);
  return {
    lines: textLines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: {
          x: 4,
          y: index * 38,
          width: Math.max(90, text.length * 7),
          height: prominent.has(index) ? 32 : 20,
        },
      })
    ),
    rawText: textLines.join('\n'),
  };
}

function key(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function host(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[.,;:]+$/, '');
}

function phoneDigits(result: V5Result): string[] {
  return (result.phones.value ?? []).map((phone) =>
    phone.number.replace(/\D/g, '')
  );
}

function emailLine(
  rawOcr: string,
  overrides: Partial<EmailEvidenceLine> = {}
): EmailEvidenceLine {
  return {
    lineId: 0,
    pageIndex: 0,
    rawOcr,
    confidence: 0.93,
    ...overrides,
  };
}

function numericLines(lines: readonly string[]): NumericEvidenceLine[] {
  return lines.map((text, lineId) => ({
    lineId,
    pageIndex: 0,
    text,
  }));
}

scenario(
  'BEU-01 claim non prevale sul dominio di una email business osservata',
  () => {
    const result = extractCardV5([
      page(
        [
          'INNOVATION FOR EVERYONE',
          'Nora Vale',
          'Managing Director',
          'nora.vale@aerolith-labs.example',
        ],
        { prominentLineIndexes: [0] }
      ),
    ]);

    assert.equal(key(result.company.value), 'aerolithlabs');
    assert.notEqual(
      key(result.company.value),
      key('INNOVATION FOR EVERYONE')
    );
    assert.deepEqual(result.emails.value, [
      'nora.vale@aerolith-labs.example',
    ]);
  }
);

scenario('BEU-02 claim non prevale su un sito business osservato', () => {
  const result = extractCardV5([
    page(
      [
        'DIGITAL SOLUTIONS FOR THE FUTURE',
        'Elena North',
        'Commercial Director',
        'Web: www.meridian-works.example.com',
      ],
      { prominentLineIndexes: [0] }
    ),
  ]);

  assert.equal(key(result.company.value), 'meridianworks');
  assert.notEqual(
    key(result.company.value),
    key('DIGITAL SOLUTIONS FOR THE FUTURE')
  );
  assert.equal(host(result.website.value), 'meridian-works.example.com');
});

scenario(
  'BEU-03 logo OCR ambiguo viene riconciliato quando email e sito concordano',
  () => {
    const result = extractCardV5([
      page(
        [
          'N0RTHSTAR LABS',
          'Elena North',
          'Operations Director',
          'elena@northstar-labs.example.com',
          'www.northstar-labs.example.com',
        ],
        { prominentLineIndexes: [0] }
      ),
    ]);

    assert.equal(key(result.company.value), 'northstarlabs');
    assert.equal(host(result.website.value), 'northstar-labs.example.com');
  }
);

scenario(
  'BEU-04 logo OCR ambiguo accetta una singola evidenza business forte',
  () => {
    const result = extractCardV5([
      page(
        [
          'AEROL1TH',
          'Nora Vale',
          'Chief Executive Officer',
          'nora.vale@aerolith.example',
        ],
        { prominentLineIndexes: [0] }
      ),
    ]);

    assert.equal(key(result.company.value), 'aerolith');
    assert.deepEqual(result.emails.value, ['nora.vale@aerolith.example']);
  }
);

scenario(
  'BEU-05 logo OCR ambiguo senza evidenze non viene corretto per invenzione',
  () => {
    const result = extractBusinessCardV5([
      page(
        [
          'AEROL1TH',
          'Nora Vale',
          'Chief Executive Officer',
          'Mobile: +44 7700 900 111',
        ],
        { prominentLineIndexes: [0] }
      ),
    ]);

    assert.notEqual(key(result.company.value), 'aerolith');
    assert.equal(result.needsReview, true);
    assert.ok(result.reviewFields.includes('company'));
  }
);

scenario(
  'BEU-06 provider email generico non diventa azienda o sito business',
  () => {
    const result = extractCardV5([
      page([
        'Nora Vale',
        'Independent Designer',
        'nora.vale@gmail.com',
        'Mobile: +44 7700 900 112',
      ]),
    ]);

    assert.deepEqual(result.emails.value, ['nora.vale@gmail.com']);
    assert.notEqual(key(result.company.value), 'gmail');
    assert.notEqual(host(result.website.value), 'gmail.com');
  }
);

scenario(
  'BEU-07 telefono internazionale etichettato non contamina indirizzo',
  () => {
    const result = extractCardV5([
      page([
        'ORBITAL WORKS LTD.',
        'Nora Vale',
        'Sales Director',
        'nora@orbital-works.example',
        'Mobile: +44 7700 900 321',
        '25 Meridian Road, London SW1A 1AA, United Kingdom',
      ]),
    ]);
    const address = result.address.value?.full ?? '';

    assert.ok(phoneDigits(result).includes('447700900321'));
    assert.match(address, /Meridian Road/i);
    assert.doesNotMatch(address.replace(/\D/g, ''), /447700900321/);
  }
);

scenario(
  'BEU-08 due telefoni completi separati da slash restano due recapiti',
  () => {
    const result = extractCardV5([
      page([
        'ORBITAL WORKS LTD.',
        'Nora Vale',
        'Sales Director',
        'Tel: +44 20 7123 4000 / +44 20 7123 4001',
        'nora@orbital-works.example',
      ]),
    ]);
    const digits = new Set(phoneDigits(result));

    assert.ok(digits.has('442071234000'));
    assert.ok(digits.has('442071234001'));
    assert.equal(digits.size, 2);
  }
);

scenario('BEU-09 P.O. Box resta parte dell’indirizzo', () => {
  const result = extractCardV5([
    page([
      'MERIDIAN GEAR LTD.',
      'Nora Vale',
      'Export Manager',
      'nora@meridian-gear.example',
      'P.O. Box 2671, 10 Meridian Road, Sialkot 51310, Pakistan',
      'Tel: +92 52 6123456',
    ]),
  ]);
  const address = result.address.value?.full ?? '';

  assert.match(address, /P\.?\s*O\.?\s*Box\s*2671/i);
  assert.match(address, /Sialkot/i);
  assert.match(address, /51310/);
});

scenario(
  'BEU-10 Road, città, CAP e paese formano un indirizzo coerente',
  () => {
    const result = extractBusinessCardV5([
      page([
        'MERIDIAN WORKS S.R.L.',
        'Elena North',
        'Sales Manager',
        'elena@meridian-works.example',
        '24 Meridian Road, 20100 Milano, Italy',
      ]),
    ]);
    const address = result.address.value;

    assert.ok(address);
    assert.match(address.full ?? '', /Meridian Road/i);
    assert.equal(address.postalCode, '20100');
    assert.match(address.city ?? address.full ?? '', /Milano/i);
    assert.match(address.country ?? address.full ?? '', /IT|Italy/i);
  }
);

scenario('BEU-11 P.IVA etichettata non viene emessa come telefono', () => {
  const result = extractCardV5([
    page([
      'MERIDIAN WORKS S.R.L.',
      'Elena North',
      'Sales Manager',
      'P.IVA 12345678903',
      'Tel: +39 02 5555 0101',
    ]),
  ]);

  assert.equal(result.vatNumber.value, '12345678903');
  assert.equal(phoneDigits(result).includes('12345678903'), false);
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted.find(
      (candidate) => candidate.normalizedValue === '12345678903'
    )?.evidenceType,
    'vat'
  );
});

scenario(
  'BEU-12 etichetta e valore fiscale non vengono interpretati come persona',
  () => {
    const result = extractCardV5([
      page([
        'NORTHSTAR SERVICES S.R.L.',
        'C.F. RSSMRA80A01F205X',
        'www.northstar-services.example',
        'Tel: +39 02 5555 0102',
      ]),
    ]);

    assert.equal(result.taxCode.value, 'RSSMRA80A01F205X');
    assert.equal(result.firstName.value, null);
    assert.equal(result.lastName.value, null);
  }
);

scenario(
  'BEU-13 nome chiaramente osservato resta invariato dal parser',
  () => {
    const result = extractCardV5([
      page([
        'NORTHSTAR LABS LTD.',
        'Michael Chang',
        'General Manager',
        'michael.chang@northstar-labs.example',
        'www.northstar-labs.example',
      ]),
    ]);

    assert.equal(result.firstName.value, 'Michael');
    assert.equal(result.lastName.value, 'Chang');
  }
);

scenario('BEU-14 una riga ruolo non viene promossa a persona', () => {
  const result = extractCardV5([
    page([
      'ORBITAL WORKS LTD.',
      'Chief Executive Officer',
      'info@orbital-works.example',
      'www.orbital-works.example',
      'Tel: +44 20 7123 4100',
    ]),
  ]);

  assert.equal(result.firstName.value, null);
  assert.equal(result.lastName.value, null);
  assert.match(result.role.value ?? '', /Chief Executive Officer/i);
});

scenario(
  'BEU-15 spazio attorno a @ produce repair tracciata e review',
  () => {
    const rawOcr = 'Email: nora.vale @ aerolith-labs.example';
    const evidence = collectEmailEvidence([emailLine(rawOcr)]);

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.value, 'nora.vale@aerolith-labs.example');
    assert.equal(evidence[0]?.origin, 'repaired');
    assert.equal(evidence[0]?.rawOcr, rawOcr);
    assert.ok(
      evidence[0]?.transformations.includes('remove_spaces_around_at')
    );
    assert.equal(evidence[0]?.requiresReview, true);
    assert.equal(evidence[0]?.confirmed, false);
  }
);

scenario(
  'BEU-16 icona OCR davanti alla email viene rimossa con provenance e review',
  () => {
    const rawOcr = '✉ nora.vale@aerolith-labs.example';
    const evidence = collectEmailEvidence([emailLine(rawOcr)]);

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.value, 'nora.vale@aerolith-labs.example');
    assert.equal(evidence[0]?.rawOcr, rawOcr);
    assert.equal(evidence[0]?.origin, 'repaired');
    assert.equal(evidence[0]?.requiresReview, true);
    assert.equal(evidence[0]?.confirmed, false);
    assert.ok(evidence[0]?.transformations.length);
  }
);

scenario(
  'BEU-17 email incompleta non viene inventata da nome e sito',
  () => {
    const lines = [
      'AEROLITH LABS LTD.',
      'Nora Vale',
      'Managing Director',
      'Email: nora.vale@',
      'www.aerolith-labs.example',
    ];
    const evidence = collectEmailEvidence(
      lines.map((rawOcr, lineId) =>
        emailLine(rawOcr, { lineId })
      )
    );
    const result = extractCardV5([page(lines)]);

    assert.deepEqual(evidence, []);
    assert.deepEqual(result.emails.value, []);
    assert.doesNotMatch(
      JSON.stringify(result.emailEvidence),
      /nora\.vale@aerolith-labs\.example/i
    );
  }
);

scenario(
  'BEU-18 due indirizzi reali restano alternativi e non vengono fusi',
  () => {
    const pages = [
      page([
        'MERIDIAN WORKS S.R.L.',
        'Elena North',
        'Managing Director',
        'elena@meridian-works.example',
        'Head Office: 10 Meridian Road, 20100 Milano, Italy',
        'Branch Office: 77 Aurora Avenue, 00100 Roma, Italy',
      ]),
    ];
    const result = extractCardV5(pages);
    const persisted = parseCardFromPagesV5(pages);
    const full = result.address.value?.full ?? '';
    const selectedMilano =
      /Meridian Road/i.test(full) &&
      /20100/.test(full) &&
      /Milano/i.test(full);
    const selectedRoma =
      /Aurora Avenue/i.test(full) &&
      /00100/.test(full) &&
      /Roma/i.test(full);

    assert.ok(result.address.value);
    assert.ok(selectedMilano || selectedRoma, full);
    assert.equal(/Milano/i.test(full) && /Roma/i.test(full), false);
    assert.equal(result.addressAlternatives.length, 1);
    assert.match(result.addressAlternatives[0]?.full ?? '', /Roma/i);
    assert.equal(
      persisted.extractionReview?.addressAlternatives?.length,
      1
    );
    assert.match(
      persisted.extractionReview?.addressAlternatives?.[0]?.full ?? '',
      /Roma/i
    );
    assert.equal(persisted.notes, undefined);
    assert.match(result.rawText, /Head Office:[^\n]+Milano/i);
    assert.match(result.rawText, /Branch Office:[^\n]+Roma/i);
  }
);

scenario(
  'BEU-19 fronte e retro coerenti vengono inclusi e consolidati',
  () => {
    const result = extractCardV5([
      page([
        'NORTHSTAR LABS LTD.',
        'Nora Vale',
        'Sales Director',
        'nora.vale@northstar-labs.com',
      ]),
      page([
        'NORTHSTAR LABS LTD.',
        'www.northstar-labs.com',
        'Tel: +44 20 7123 4200',
        '25 Meridian Road, London SW1A 1AA, United Kingdom',
      ]),
    ]);

    assert.equal(result.pageCoherence.decision, 'match');
    assert.deepEqual(result.pageCoherence.includedPageIndexes, [0, 1]);
    assert.deepEqual(result.pageCoherence.pendingPageIndexes, []);
    assert.equal(result.firstName.value, 'Nora');
    assert.deepEqual(result.emails.value, [
      'nora.vale@northstar-labs.com',
    ]);
    assert.equal(host(result.website.value), 'northstar-labs.com');
    assert.match(result.address.value?.full ?? '', /Meridian Road/i);
  }
);

scenario(
  'BEU-20 decisione multipagina ambiguous richiede review ma non restituisce un contatto vuoto',
  () => {
    const result = extractCardV5([
      page([
        'AEROLITH LABS LTD.',
        'Nora Vale',
        'Managing Director',
        'nora.vale@aerolith-labs.example',
        '10 Meridian Road, 20100 Milano',
      ]),
      page(['10 Meridian Road, 20100 Milano']),
    ]);
    const semanticValues = [
      result.firstName.value,
      result.lastName.value,
      result.company.value,
      ...(result.emails.value ?? []),
      ...(result.phones.value ?? []).map((phone) => phone.number),
      result.website.value,
      result.address.value?.full,
    ].filter((value) => typeof value === 'string' && value.trim().length > 0);

    assert.equal(result.pageCoherence.decision, 'ambiguous');
    assert.equal(result.pageCoherence.requiresReview, true);
    assert.ok(semanticValues.length > 0, 'ambiguous non deve azzerare il contatto');
  }
);

scenario(
  'BEU-21 sito osservato non viene sostituito dal dominio della email',
  () => {
    const result = extractBusinessCardV5([
      page([
        'RIVERGATE MOTORS LTD.',
        'Paolo Neri',
        'Sales Manager',
        'sales@rivergate-shop.example.com',
        'www.rivergate-motors.example.com',
        'Tel: +39 049 555 0103',
      ]),
    ]);

    assert.equal(host(result.website.value), 'rivergate-motors.example.com');
    assert.notEqual(host(result.website.value), 'rivergate-shop.example.com');
  }
);

scenario(
  'BEU-22 prefisso telefonico internazionale non assorbe il CAP',
  () => {
    const lines = [
      'Mobile: +92 333 8609110',
      'P.O. Box 2671, 10 Meridian Road, Sialkot 51310, Pakistan',
    ];
    const resolution = resolveNumericEvidence(
      collectNumericEvidence(numericLines(lines))
    );
    const result = extractCardV5([
      page([
        'MERIDIAN GEAR LTD.',
        'Nora Vale',
        ...lines,
        'nora@meridian-gear.example',
      ]),
    ]);

    assert.equal(
      resolution.accepted.find(
        (candidate) => candidate.normalizedValue === '923338609110'
      )?.evidenceType,
      'phone'
    );
    assert.equal(
      resolution.accepted.find(
        (candidate) => candidate.normalizedValue === '51310'
      )?.evidenceType,
      'postalCode'
    );
    assert.doesNotMatch(
      (result.address.value?.full ?? '').replace(/\D/g, ''),
      /923338609110/
    );
  }
);

test(
  'BEU-99 riepilogo: sono registrati tutti i 22 scenari universali richiesti',
  () => {
    assert.equal(registeredScenarioCount, REQUIRED_SCENARIO_COUNT);
  }
);
