import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import {
  extractCardV5,
  type CardPageV5,
} from '../lib/parser-v5/engine';
import {
  collectNumericEvidence,
  resolveNumericEvidence,
  type NumericEvidence,
  type NumericEvidenceLine,
  type NumericEvidenceType,
} from '../lib/parser-v5/numeric-evidence';
import { analyzePageCoherence } from '../lib/parser-v5/page-coherence';

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: {
          x: 0,
          y: index * 24,
          width: Math.max(80, text.length * 7),
          height: 20,
        },
      })
    ),
    rawText: lines.join('\n'),
  };
}

function evidenceLines(
  pages: readonly (readonly string[])[]
): NumericEvidenceLine[] {
  let lineId = 0;
  return pages.flatMap((lines, pageIndex) =>
    lines.map((text) => ({
      lineId: lineId++,
      pageIndex,
      text,
    }))
  );
}

function classify(lines: readonly string[]): {
  all: readonly NumericEvidence[];
  accepted: readonly NumericEvidence[];
  ambiguous: readonly NumericEvidence[];
  rejected: readonly NumericEvidence[];
} {
  const all = collectNumericEvidence(evidenceLines([lines]));
  return { all, ...resolveNumericEvidence(all) };
}

function acceptedOfType(
  lines: readonly string[],
  evidenceType: NumericEvidenceType
): NumericEvidence[] {
  return classify(lines).accepted.filter(
    (candidate) => candidate.evidenceType === evidenceType
  ) as NumericEvidence[];
}

test('P.IVA italiana valida con etichetta conserva provenance completa', () => {
  const candidates = acceptedOfType(
    ['ALPHA S.R.L.', 'P.IVA: 12345678903'],
    'vat'
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    {
      rawValue: candidates[0]?.rawValue,
      normalizedValue: candidates[0]?.normalizedValue,
      lineId: candidates[0]?.lineId,
      pageIndex: candidates[0]?.pageIndex,
      evidenceType: candidates[0]?.evidenceType,
      validationStatus: candidates[0]?.validationStatus,
    },
    {
      rawValue: '12345678903',
      normalizedValue: '12345678903',
      lineId: 1,
      pageIndex: 0,
      evidenceType: 'vat',
      validationStatus: 'valid',
    }
  );
  assert.ok((candidates[0]?.confidence ?? 0) >= 0.9);
  assert.match(candidates[0]?.reason ?? '', /explicit_vat_label/);
  assert.match(candidates[0]?.reason ?? '', /checksum_valid/);
});

test('P.IVA valida senza etichetta richiede contesto fiscale forte', () => {
  const candidates = acceptedOfType(
    [
      'ALPHA INDUSTRIES S.R.L.',
      'Sede legale e Registro Imprese Milano',
      '12345678903',
    ],
    'vat'
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.normalizedValue, '12345678903');
  assert.equal(candidates[0]?.lineId, 2);
  assert.match(candidates[0]?.reason ?? '', /strong_business_context/);
  assert.equal(candidates[0]?.validationStatus, 'valid');
});

test('etichette P.VA, PJVA e Part. VA degradate da OCR restano fiscali', () => {
  for (const [line, expected] of [
    ['P.VA 01797270244', '01797270244'],
    ['PJVA O2493530352', '02493530352'],
    ['Part. VA 03876570247', '03876570247'],
  ] as const) {
    const candidates = acceptedOfType([line], 'vat');
    assert.equal(candidates.length, 1, line);
    assert.equal(candidates[0]?.normalizedValue, expected, line);
    assert.equal(candidates[0]?.validationStatus, 'valid', line);
    assert.match(candidates[0]?.reason ?? '', /explicit_vat_label/, line);
  }
});

test('le etichette fiscali compatte P.I. e PI non contaminano il valore', () => {
  for (const line of ['P.I. 00743110157', 'PI 00743110157']) {
    const candidates = acceptedOfType([line], 'vat');
    assert.equal(candidates.length, 1, line);
    assert.equal(candidates[0]?.rawValue, '00743110157', line);
    assert.equal(candidates[0]?.normalizedValue, '00743110157', line);
    assert.match(candidates[0]?.reason ?? '', /explicit_vat_label/, line);
  }
});

test('prefisso paese IT non altera la P.IVA normalizzata', () => {
  const candidates = acceptedOfType(
    ['P.IVA IT 12345678903'],
    'vat'
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.rawValue, 'IT 12345678903');
  assert.equal(candidates[0]?.normalizedValue, '12345678903');
});

test('P.IVA a cifre tutte uguali viene rifiutata anche se passa il checksum', () => {
  const result = classify(['P.IVA 00000000000']);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.evidenceType, 'vat');
  assert.equal(result.rejected[0]?.validationStatus, 'invalid');
});

test('CAP numerico con lunghezza errata resta diagnostico ma non accettato', () => {
  const result = classify(['CAP: 12345678903']);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.evidenceType, 'postalCode');
  assert.match(result.rejected[0]?.reason ?? '', /postal_length_invalid/);
});

test('CAP con zero iniziale non viene scambiato per prefisso telefonico', () => {
  const result = classify(['CAP: 00161']);
  assert.deepEqual(
    result.accepted.map((candidate) => candidate.evidenceType),
    ['postalCode']
  );
});

test('numero documento con doppio zero iniziale resta documento', () => {
  const result = classify(['Numero documento: 00123456789']);
  assert.deepEqual(
    result.accepted.map((candidate) => candidate.evidenceType),
    ['documentNumber']
  );
});

test('date con separatori non vengono accettate come telefoni', () => {
  for (const value of ['01/01/1957', '2026/07/25']) {
    const result = classify([value]);
    assert.equal(
      result.accepted.some(
        (candidate) => candidate.evidenceType === 'phone'
      ),
      false,
      value
    );
    assert.equal(
      result.all[0]?.evidenceType,
      'unknownNumericIdentifier',
      value
    );
  }
});

test('codice fiscale numerico non verificato non diventa identitÃ  forte', () => {
  const result = classify(['C.F.: 12345678903']);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ambiguous[0]?.evidenceType, 'taxCode');
  assert.equal(result.ambiguous[0]?.validationStatus, 'unverified');
});

test('etichetta fiscale combinata conserva VAT e tax code separati', () => {
  const result = classify(['C.F./P.IVA: 12345678903']);
  assert.deepEqual(
    result.all.map((candidate) => candidate.evidenceType),
    ['taxCode', 'vat']
  );
  assert.equal(result.accepted[0]?.evidenceType, 'vat');
  assert.equal(result.ambiguous[0]?.evidenceType, 'taxCode');
});

test('P.I. e C.F. combinati sono simmetrici in entrambi gli ordini', () => {
  for (const line of [
    'P.I./C.F. 00743110157',
    'PI/CF 00743110157',
    'C.F./P.I. 00743110157',
    'CF/PI 00743110157',
  ]) {
    const result = classify([line]);
    assert.deepEqual(
      result.all.map((candidate) => candidate.evidenceType),
      ['taxCode', 'vat'],
      line
    );
    assert.equal(result.accepted[0]?.evidenceType, 'vat', line);
    assert.equal(result.accepted[0]?.normalizedValue, '00743110157', line);
    assert.equal(result.ambiguous[0]?.evidenceType, 'taxCode', line);
  }
});

test('provider email generico non crea da solo contesto VAT forte', () => {
  const result = classify([
    'ALPHA S.R.L.',
    'info@gmail.com',
    '12345678903',
  ]);
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
});

test('estensione documento non crea contesto VAT forte', () => {
  const result = classify([
    'ALPHA S.R.L.',
    'catalog.pdf',
    '12345678903',
  ]);
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
});

test('telefono italiano di 11 cifre prevale anche se passa il checksum VAT', () => {
  const result = classify(['Tel: 12345678903']);
  assert.deepEqual(
    result.accepted.map((candidate) => candidate.evidenceType),
    ['phone']
  );
  assert.equal(result.accepted[0]?.normalizedValue, '12345678903');
  assert.equal(result.accepted[0]?.validationStatus, 'not_applicable');
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
});

test('raggruppamento telefonico prevale sul fallback VAT senza etichetta', () => {
  const result = extractCardV5([
    page([
      'ALPHA S.R.L.',
      'www.alpha.example',
      '123 456 789 03',
    ]),
  ]);
  assert.equal(result.vatNumber.value, null);
  assert.equal(
    result.phones.value?.some(
      (phone) => phone.number.replace(/\D/g, '') === '12345678903'
    ),
    true
  );
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted.find(
      (candidate) => candidate.normalizedValue === '12345678903'
    )?.evidenceType,
    'phone'
  );
});

test('telefono internazionale è classificato come phone e non VAT', () => {
  const result = classify(['Mobile: +39 333 123 4567']);
  assert.equal(result.accepted[0]?.evidenceType, 'phone');
  assert.equal(result.accepted[0]?.normalizedValue, '393331234567');
  assert.match(
    result.accepted[0]?.reason ?? '',
    /explicit_phone_label|international_phone_prefix/
  );
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
});

test('fax di 11 cifre è fax e non P.IVA', () => {
  const result = classify(['Fax: 02 1234 56789']);
  assert.equal(result.accepted[0]?.evidenceType, 'fax');
  assert.equal(result.accepted[0]?.normalizedValue, '02123456789');
  assert.match(result.accepted[0]?.reason ?? '', /explicit_fax_label/);
});

test('numero documento di 11 cifre non alimenta le P.IVA', () => {
  const result = classify(['Numero documento: 12345678903']);
  assert.equal(result.accepted[0]?.evidenceType, 'documentNumber');
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
});

test('codice postale è distinto dagli altri identificativi numerici', () => {
  const result = classify(['CAP: 20100', 'Milano']);
  assert.equal(result.accepted[0]?.evidenceType, 'postalCode');
  assert.equal(result.accepted[0]?.normalizedValue, '20100');
  assert.equal(result.accepted[0]?.validationStatus, 'valid');
});

test('codice fiscale alfanumerico conserva tipo e provenienza', () => {
  const result = classify(['C.F.: RSSMRA80A01F205X']);
  const taxCode = result.accepted.find(
    (candidate) => candidate.evidenceType === 'taxCode'
  );
  assert.equal(taxCode?.normalizedValue, 'RSSMRA80A01F205X');
  assert.equal(taxCode?.lineId, 0);
  assert.equal(taxCode?.pageIndex, 0);
  assert.equal(taxCode?.validationStatus, 'valid');
});

test('fronte e retro della stessa persona producono match', () => {
  const pages = [
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario.rossi@alpha.example',
    ]),
    page([
      'ALPHA S.R.L.',
      'mario.rossi@alpha.example',
      'www.alpha.example',
      'P.IVA: 12345678903',
    ]),
  ];
  const result = analyzePageCoherence(pages, evidenceLines([
    pages[0].rawText.split('\n'),
    pages[1].rawText.split('\n'),
  ]));
  assert.equal(result.decision, 'match');
  assert.deepEqual(result.includedPages, [0, 1]);
  assert.deepEqual(result.excludedPages, []);
  assert.deepEqual(result.pendingPages, []);
  assert.equal(result.requiresReview, false);
  assert.ok(result.confidence >= 0.85);
  assert.ok(result.decisionReasons.length > 0);
});

test('dominio personale e ragione sociale sul retro formano un ponte organizzativo', () => {
  const result = analyzePageCoherence([
    page([
      'Evanna Kearins',
      'ekearins@jaspersoft.com',
      'Rainsford Street',
    ]),
    page(['Jaspersoft GmbH', '3 rue du Colonel Moll', '60322 Frankfurt']),
  ]);
  assert.equal(result.decision, 'match');
  assert.deepEqual(result.includedPages, [0, 1]);
  assert.match(
    result.decisionReasons.join(' '),
    /logo\/azienda|complementare/
  );
});

test('sedi globali e persona sul fronte restano collegate senza città-persona', () => {
  const result = analyzePageCoherence([
    page([
      'Jaspersoft Ltd',
      'Jaspersoft Corporation',
      'Digital Court',
      '350 Rhode Island St - Ste 250',
      'Rainsford Street',
      'San Francisco',
      'Dublin 8',
      'www.jaspersoft.com',
      'Jaspersoft GmbH',
    ]),
    page([
      'Evanna Kearins',
      'Director Marketing, EMEA',
      'ekearins@jaspersoft.com',
      'OJAS PERSOFT',
      '+353 87 289 6579',
    ]),
  ]);
  assert.equal(
    result.decision,
    'match',
    result.decisionReasons.join(' | ')
  );
});

test('registered office sul retro non viene scambiato per una persona', () => {
  const result = analyzePageCoherence([
    page([
      'Stucchi',
      'Marco Rivoltella',
      'Supply Chain Manager',
      'mrivoltella@stucchi.it',
      'Via della Lira Italiana, snc',
    ]),
    page([
      'Stucchi S.p.A.',
      'Registered Office',
      'Via Galileo Galilei, 1',
      'stucchi.it',
    ]),
  ]);
  assert.equal(
    result.decision,
    'match',
    result.decisionReasons.join(' | ')
  );
});

test('logo OCR e ragione sociale fuzzy convergono senza eccezioni nominali', () => {
  const result = analyzePageCoherence([
    page([
      'INFODATI',
      'FILIPPO DE GUIO',
      'filippo.deguio@infodati.it',
    ]),
    page([
      'INFODAI S.P.A.',
      'Galleria Crispi',
      'info@infodati.it',
    ]),
  ]);
  assert.equal(result.decision, 'match');
  assert.deepEqual(result.includedPages, [0, 1]);
});

test('forma giuridica spezzata si collega a un header organizzativo debole', () => {
  const result = analyzePageCoherence([
    page([
      'Wise',
      'Alessandro Pesenti',
      'Software Solutions Manager',
    ]),
    page([
      'Wise Ingegneria',
      'e Soluzioni Software S.r.l.',
      'www.wiseingegneria.it',
    ]),
  ]);
  assert.equal(result.decision, 'match');
  assert.deepEqual(result.includedPages, [0, 1]);
});

test('forma giuridica spezzata con descrizione sul fronte resta fronte/retro', () => {
  const result = analyzePageCoherence([
    page([
      'Wise',
      'Ingegneria e Soluzioni Software',
      'Alessandro Pesenti',
      'Software Solutions Manager',
      'pesenti.alessandro@wiseingegneriait',
    ]),
    page([
      'Wise Ingegneria',
      'e Soluzioni Software S.r.l.',
      'via Artigiani, 22',
      '24060 Brusaporto (BG) Italy',
      'www.wiseingegneria.it',
    ]),
  ]);
  assert.equal(
    result.decision,
    'match',
    result.decisionReasons.join(' | ')
  );
});

test('badge partner sul retro non viene scambiato per una seconda persona', () => {
  const result = analyzePageCoherence([
    page([
      'SERENISSIMA',
      'Filippo Filippi',
      'Agente di Vendita PMI',
      'filippo.filippi@serinf. it',
    ]),
    page([
      'Microsoft',
      'GOLD CERTIFIED',
      'Partner',
      'Serenissima Informatica SpA',
      'Via Croce Rossa, 5 - 35129 Padova PD - Italy',
    ]),
  ]);
  assert.equal(
    result.decision,
    'match',
    result.decisionReasons.join(' | ')
  );
});

test('logo e indirizzo condivisi sono due evidenze fronte/retro', () => {
  const result = analyzePageCoherence([
    page([
      'Alfio Dorigo',
      'ICM.S',
      'Via A. Pacinotti 1',
      'alfio.dorigo@icms.it',
    ]),
    page([
      'ICM.S',
      'Via A. Pacinotti 1',
      'Tel. +39 0422 618624',
    ]),
  ]);
  assert.equal(result.decision, 'match');
  assert.deepEqual(result.includedPages, [0, 1]);
});

test('sito e testo distintivo OCR convergenti producono match', () => {
  const result = analyzePageCoherence([
    page([
      'Asim Nayyer',
      'Inspire the Neat',
      'www.atrox-gear.com',
    ]),
    page([
      'Inspire the Next',
      'www.atrox-gear.com',
      'P.O. Box 2671, Sialkot',
    ]),
  ]);
  assert.equal(result.decision, 'match');
  assert.match(result.decisionReasons.join(' '), /testo distintivo/);
});

test('stessa azienda e stesso dominio senza un fronte personale restano insufficienti', () => {
  const result = analyzePageCoherence([
    page(['ALPHA S.R.L.', 'www.alpha.example']),
    page(['ALPHA S.R.L.', 'www.alpha.example']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.equal(result.requiresReview, true);
});

test('P.IVA validate distinte prevalgono su telefono e indirizzo condivisi', () => {
  const result = analyzePageCoherence([
    page([
      'Piva Gomme',
      "Via dell'Industria 44",
      'Tel. 0445 510748',
      'P.VA 01797270244',
    ]),
    page([
      'AUTOTECH S.R.L.',
      "Via dell'Industria 44",
      'Tel. 0445 510748',
      'Part. VA 03876570247',
    ]),
  ]);
  assert.equal(result.decision, 'mismatch');
  assert.equal(result.includedPages.length, 1);
  assert.equal(result.excludedPages.length, 1);
  assert.match(result.decisionReasons.join(' '), /P\.IVA validate distinte/);
});

test('il runtime usa la classificazione numerica nella decisione multipagina', () => {
  const result = extractCardV5([
    page(['ALPHA S.R.L.', 'Tel: 12345678903']),
    page(['ALPHA S.R.L.', 'Tel: 00743110157']),
  ]);
  assert.equal(result.pageCoherence.decision, 'ambiguous');
  assert.deepEqual(result.pageCoherence.pendingPageIndexes, [0, 1]);
  assert.deepEqual(
    result.pageCoherence.numericEvidence?.accepted.map(
      (candidate) => candidate.evidenceType
    ),
    ['phone', 'phone']
  );
});

test('il runtime espone una P.IVA valida senza etichetta con contesto forte', () => {
  const result = extractCardV5([
    page([
      'ALPHA INDUSTRIES S.R.L.',
      'Sede legale e Registro Imprese Milano',
      '12345678903',
    ]),
  ]);
  assert.equal(result.vatNumber.value, '12345678903');
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted.find(
      (candidate) => candidate.evidenceType === 'vat'
    )?.normalizedValue,
    '12345678903'
  );
});

test('più P.IVA validate incompatibili non producono una scelta silenziosa', () => {
  const result = extractCardV5([
    page([
      'ALPHA S.R.L.',
      'P.IVA 12345678903',
      'P.IVA 00743110157',
    ]),
  ]);
  assert.equal(result.vatNumber.value, null);
  assert.equal(result.pageCoherence.requiresReview, true);
  assert.match(
    result.pageCoherence.decisionReasons.join(' '),
    /più P\.IVA/
  );
});

test('P.I. e P.IVA discordanti restano entrambe evidence e richiedono review', () => {
  const result = extractCardV5([
    page([
      'ALPHA S.R.L.',
      'P.I. 00743110157',
      'P.IVA 12345678903',
    ]),
  ]);
  assert.equal(result.vatNumber.value, null);
  assert.equal(result.pageCoherence.requiresReview, true);
  assert.deepEqual(
    result.pageCoherence.numericEvidence?.accepted
      .filter((candidate) => candidate.evidenceType === 'vat')
      .map((candidate) => candidate.normalizedValue)
      .sort(),
    ['00743110157', '12345678903']
  );
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted.some(
      (candidate) =>
        candidate.evidenceType === 'phone' &&
        candidate.normalizedValue.includes('00743110157')
    ),
    false
  );
});

test('una P.IVA validata prevale sul candidato legacy con checksum invalido', () => {
  const result = extractCardV5([
    page([
      'ALPHA INDUSTRIES S.R.L.',
      'P.IVA 12345678901',
      'Sede legale e Registro Imprese Milano',
      '12345678903',
    ]),
  ]);
  assert.equal(result.vatNumber.value, '12345678903');
  assert.equal(result.pageCoherence.requiresReview, true);
  assert.match(
    result.pageCoherence.decisionReasons.join(' '),
    /candidato fiscale non valido/
  );
});

test('il runtime conserva un telefono etichettato anche se supera il checksum VAT', () => {
  const result = extractCardV5([
    page(['ALPHA S.R.L.', 'Tel: 12345678903']),
  ]);
  assert.equal(
    result.phones.value?.some(
      (phone) => phone.number.replace(/\D/g, '') === '12345678903'
    ),
    true
  );
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted[0]?.evidenceType,
    'phone'
  );
});

test('il runtime non recupera come VAT un numero documento classificato', () => {
  const result = extractCardV5([
    page([
      'ALPHA S.R.L.',
      'www.alpha.example',
      'Numero documento: 12345678903',
    ]),
  ]);
  assert.equal(result.vatNumber.value, null);
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted.find(
      (candidate) => candidate.normalizedValue === '12345678903'
    )?.evidenceType,
    'documentNumber'
  );
});

test('colleghi della stessa azienda non vengono fusi', () => {
  const pages = [
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario.rossi@alpha.example',
      'P.IVA: 12345678903',
    ]),
    page([
      'ALPHA S.R.L.',
      'Giulia Bianchi',
      'giulia.bianchi@alpha.example',
      'P.IVA: 12345678903',
    ]),
  ];
  const result = analyzePageCoherence(pages);
  assert.equal(result.decision, 'mismatch');
  assert.equal(result.includedPages.length, 1);
  assert.equal(result.excludedPages.length, 1);
  assert.deepEqual(result.pendingPages, []);
  assert.equal(result.requiresReview, true);
  assert.match(result.decisionReasons.join(' '), /identità personali/);
});

test('colleghi senza email con recapiti aziendali condivisi restano ambiguous', () => {
  const result = analyzePageCoherence([
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'Tel: +39 02 1234 5678',
      'Via Roma 10',
    ]),
    page([
      'ALPHA S.R.L.',
      'Giulia Bianchi',
      'Tel: +39 02 1234 5678',
      'Via Roma 10',
    ]),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.includedPages, []);
  assert.deepEqual(result.excludedPages, []);
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.match(result.decisionReasons.join(' '), /persone distinte/);
});

test('cognome uguale al brand non nasconde persone differenti', () => {
  const result = analyzePageCoherence([
    page([
      'ROSSI S.R.L.',
      'Mario Rossi',
      'Tel: +39 02 1234 5678',
    ]),
    page([
      'ROSSI S.R.L.',
      'Luigi Rossi',
      'Tel: +39 02 1234 5678',
    ]),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
});

test('stesso dominio con persone differenti non prova match', () => {
  const result = analyzePageCoherence([
    page(['Mario Rossi', 'mario.rossi@shared.example']),
    page(['Giulia Bianchi', 'giulia.bianchi@shared.example']),
  ]);
  assert.equal(result.decision, 'mismatch');
  assert.equal(result.requiresReview, true);
  assert.match(result.decisionReasons.join(' '), /email personali distinte/);
});

test('mailbox di ruolo differenti non vengono trattate come persone', () => {
  const result = analyzePageCoherence([
    page(['ALPHA S.R.L.', 'jobs@alpha.example']),
    page(['ALPHA S.R.L.', 'press@alpha.example']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.doesNotMatch(
    result.decisionReasons.join(' '),
    /email personali distinte/
  );
});

test('sottodomini sibling di hosting condiviso non provano lo stesso dominio', () => {
  const result = analyzePageCoherence([
    page([
      'ALPHA S.R.L.',
      'www.alice.github.io',
      'Tel: +39 02 1234 5678',
    ]),
    page([
      'OMEGA S.R.L.',
      'www.bob.github.io',
      'Tel: +39 02 1234 5678',
    ]),
  ]);
  assert.equal(result.decision, 'mismatch');
  assert.match(result.decisionReasons.join(' '), /aziende incompatibili/);
});

test('un nome file con estensione documento non diventa un dominio', () => {
  const result = analyzePageCoherence([
    page(['ALPHA', 'catalog.pdf', 'Tel: +39 02 1234 5678']),
    page(['OMEGA', 'catalog.pdf', 'Tel: +39 02 1234 5678']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
});

test('due freelance con provider generici e identità differenti non vengono fusi', () => {
  const result = analyzePageCoherence([
    page(['Paolo Verdi', 'paolo.verdi@gmail.com']),
    page(['Sara Neri', 'sara.neri@yahoo.com']),
  ]);
  assert.equal(result.decision, 'mismatch');
  assert.equal(result.includedPages.length, 1);
  assert.equal(result.excludedPages.length, 1);
  assert.equal(result.requiresReview, true);
});

test('retro con solo indirizzo resta ambiguous con una sola evidenza', () => {
  const result = analyzePageCoherence([
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario@alpha.example',
      'Via Roma 10',
    ]),
    page(['Via Roma 10']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.includedPages, []);
  assert.deepEqual(result.excludedPages, []);
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.equal(result.requiresReview, true);
});

test('retro con solo telefono resta ambiguous con una sola evidenza', () => {
  const result = analyzePageCoherence([
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario@alpha.example',
      'Tel: +39 02 1234 5678',
    ]),
    page(['Tel: +39 02 1234 5678']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.match(result.decisionReasons.join(' '), /solo telefono/);
});

test('retro con sola P.IVA resta ambiguous con una sola evidenza', () => {
  const result = analyzePageCoherence([
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario@alpha.example',
      'P.IVA: 12345678903',
    ]),
    page(['P.IVA: 12345678903']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.match(result.decisionReasons.join(' '), /solo P.IVA/);
});

test('evidenze personali convergenti e aziende contraddittorie sono ambiguous', () => {
  const result = analyzePageCoherence([
    page([
      'ALPHA S.R.L.',
      'mario.rossi@identity.example',
      'P.IVA: 12345678903',
      'www.alpha.example',
    ]),
    page([
      'OMEGA S.P.A.',
      'mario.rossi@identity.example',
      'P.IVA: 10987654323',
      'www.omega.example',
    ]),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.equal(result.requiresReview, true);
  assert.match(result.decisionReasons.join(' '), /contraddittorie/);
});

test('decisione ambiguous non include o esclude silenziosamente pagine', () => {
  const result = analyzePageCoherence([
    page(['www.shared.example']),
    page(['www.shared.example']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.activePages, []);
  assert.deepEqual(result.includedPages, []);
  assert.deepEqual(result.excludedPages, []);
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.equal(result.pageMismatch, false);
  assert.equal(result.requiresReview, true);
});

test('tre pagine mantengono il fronte/retro ed escludono quella estranea', () => {
  const pages = [
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario@alpha.example',
      'P.IVA: 12345678903',
    ]),
    page([
      'ALPHA S.R.L.',
      'www.alpha.example',
      'P.IVA: 12345678903',
      'Via Roma 10',
    ]),
    page([
      'OMEGA S.P.A.',
      'Giulia Bianchi',
      'giulia@omega.example',
      'P.IVA: 10987654323',
    ]),
  ];
  const result = analyzePageCoherence(pages);
  assert.equal(result.decision, 'mismatch');
  assert.deepEqual(result.includedPages, [0, 1]);
  assert.deepEqual(result.excludedPages, [2]);
  assert.deepEqual(result.pendingPages, []);
  assert.equal(result.requiresReview, true);

  const repeated = analyzePageCoherence(pages);
  assert.deepEqual(repeated, result);
});

test('telefono e P.IVA sulla stessa pagina restano due evidenze distinte', () => {
  const result = classify([
    'ALPHA S.R.L.',
    'Tel: 12345678903',
    'P.IVA: 00743110157',
  ]);
  assert.deepEqual(
    result.accepted.map((candidate) => [
      candidate.evidenceType,
      candidate.normalizedValue,
    ]),
    [
      ['phone', '12345678903'],
      ['vat', '00743110157'],
    ]
  );
});

test('assenza di evidenza sufficiente produce ambiguous fail-closed', () => {
  const result = analyzePageCoherence([
    page(['Mario Rossi']),
    page(['Via Sconosciuta 99']),
  ]);
  assert.equal(result.decision, 'ambiguous');
  assert.deepEqual(result.pendingPages, [0, 1]);
  assert.equal(result.requiresReview, true);
  assert.ok(result.confidence >= 0);
  assert.ok(result.confidence <= 1);
  assert.ok(result.decisionReasons.length > 0);
});

test('11 cifre isolate e checksum invalido restano identificativo sconosciuto', () => {
  const result = classify(['12345678901']);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(
    result.ambiguous[0]?.evidenceType,
    'unknownNumericIdentifier'
  );
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
});

test('micro-closure: P.VA OCR damage keeps fiscal VAT without VA country prefix', () => {
  const candidates = acceptedOfType(['P.VA 01797270244'], 'vat');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.normalizedValue, '01797270244');
  assert.notEqual(candidates[0]?.normalizedValue?.startsWith('VA'), true);
  assert.match(candidates[0]?.reason ?? '', /explicit_vat_label/);
});

test('micro-closure: C.F. stays taxCode and is not fax', () => {
  const result = classify(['C.F.: RSSMRA80A01F205X']);
  assert.equal(result.accepted[0]?.evidenceType, 'taxCode');
  assert.equal(
    result.all.some((candidate) => candidate.evidenceType === 'fax'),
    false
  );
});

test('micro-closure: normal Italian P.IVA stays labeled VAT', () => {
  const candidates = acceptedOfType(['P.IVA 12345678903'], 'vat');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.normalizedValue, '12345678903');
});

test('micro-closure: foreign VAT country prefix is preserved', () => {
  const all = collectNumericEvidence(
    evidenceLines([['VAT DE 123456789']])
  );
  const vat = all.find((candidate) => candidate.evidenceType === 'vat');
  assert.ok(vat);
  assert.match(vat?.normalizedValue ?? '', /^DE/);
});

test('micro-closure: damaged P.VA tail with invalid Italian checksum is not accepted as foreign VAT', () => {
  const result = classify(['P.VA 12345678901']);
  const vat = result.all.find((candidate) => candidate.evidenceType === 'vat');

  assert.ok(vat);
  assert.equal(vat?.validationStatus, 'invalid');
  assert.equal(
    result.accepted.some((candidate) => candidate.evidenceType === 'vat'),
    false
  );
  assert.doesNotMatch(
    vat?.reason ?? '',
    /explicit_foreign_vat_observed/
  );
});

test('micro-closure: ordinary phone stays phone', () => {
  const candidates = acceptedOfType(['Tel. 02 12345678'], 'phone');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.evidenceType, 'phone');
});

test('micro-closure: ordinary document number stays documentNumber', () => {
  const candidates = acceptedOfType(
    ['Numero documento 12345678901'],
    'documentNumber'
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.evidenceType, 'documentNumber');
});

test('micro-closure: numeric value followed by later fiscal label does not inherit that label', () => {
  const afterVat = classify(['01797270244 P.IVA']);
  assert.equal(
    afterVat.all.some(
      (candidate) =>
        candidate.evidenceType === 'vat' &&
        /explicit_vat_label/.test(candidate.reason)
    ),
    false,
    'digits before a later P.IVA must not inherit explicit_vat_label'
  );

  const afterCf = classify(['12345678903 C.F. RSSMRA80A01F205X']);
  const digitSpan = afterCf.all.find(
    (candidate) => candidate.normalizedValue === '12345678903'
  );
  assert.ok(digitSpan);
  assert.notEqual(digitSpan?.evidenceType, 'taxCode');
  assert.equal(
    /explicit_tax_code_label|explicit_vat_label/.test(digitSpan?.reason ?? ''),
    false
  );
});
