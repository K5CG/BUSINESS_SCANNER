import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCardV5 } from '../lib/parser-v5/engine';
import type { OcrLine } from '../types';
// Synthetic OCR inputs: they exercise the parser, not the phone recognizer.
const cases = [
  {
    "label": "S. A.GE. MA, s.n,G / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S. A.GE. MA, s.n,G",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S. A.GE. MA, S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S. A.GE. MA, s.n,G / brand-first",
    "input": [
      "S. A.GE. MA, s.n,G",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S. A.GE. MA, S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A. GE. MA, s.n,G / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A. GE. MA, s.n,G",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A. GE. MA, S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A. GE. MA, s.n,G / brand-first",
    "input": [
      "S.A. GE. MA, s.n,G",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A. GE. MA, S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA. S.n.c. / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A.GE.MA. S.n.c.",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA. S.n.c. / brand-first",
    "input": [
      "S.A.GE.MA. S.n.c.",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA, S.n.c. / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A.GE.MA, S.n.c.",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA, S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA, S.n.c. / brand-first",
    "input": [
      "S.A.GE.MA, S.n.c.",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA, S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA. S N C / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A.GE.MA. S N C",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA. S N C / brand-first",
    "input": [
      "S.A.GE.MA. S N C",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA. s.n.e. / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A.GE.MA. s.n.e.",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "S.A.GE.MA. s.n.e. / brand-first",
    "input": [
      "S.A.GE.MA. s.n.e.",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "SO.GE.MA. S.n.c. / name-first",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SO.GE.MA. S.n.c.",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "SO.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "SO.GE.MA. S.n.c. / brand-first",
    "input": [
      "SO.GE.MA. S.n.c.",
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "SO.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "DERGAE CONS ULT ING / separate",
    "input": [
      "DERGAE",
      "CONS ULT ING",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE CONS ULT ING / inline",
    "input": [
      "DERGAE CONS ULT ING",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE CON SULT ING / separate",
    "input": [
      "DERGAE",
      "CON SULT ING",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE CON SULT ING / inline",
    "input": [
      "DERGAE CON SULT ING",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE C O N S U L T I N G / separate",
    "input": [
      "DERGAE",
      "C O N S U L T I N G",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE C O N S U L T I N G / inline",
    "input": [
      "DERGAE C O N S U L T I N G",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE C0NSULT ING / separate",
    "input": [
      "DERGAE",
      "C0NSULT ING",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "DERGAE C0NSULT ING / inline",
    "input": [
      "DERGAE C0NSULT ING",
      "Fabrizio Lorigiola",
      "Account Manager",
      "fabrizio.lorigiola a derga. it",
      "www.derga.it"
    ],
    "expected": "DERGA Consulting",
    "first": "Fabrizio",
    "last": "Lorigiola",
    "role": "Account Manager"
  },
  {
    "label": "uncertain S.A.GE.MA. s.n,X",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A.GE.MA. s.n,X",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA. S.n.c.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  },
  {
    "label": "uncertain S.A.GE.MA. s.r,Q",
    "input": [
      "DANTE CHIERICO",
      "PERITO INDUSTRIALE",
      "S.A.GE.MA. s.r,Q",
      "SISTEMI AUTOMATICI GENERALI E MACCHINE",
      "Tel. (0445) 671155"
    ],
    "expected": "S.A.GE.MA.",
    "first": "Dante",
    "last": "Chierico",
    "role": "PERITO INDUSTRIALE"
  }
];
for (const fixture of cases) {
  test('V28.1 output: '+fixture.label, () => {
    const lines: OcrLine[] = fixture.input.map((text,index) => ({text, confidence:0.96,
      boundingBox:{x:20,y:index*34,width:Math.max(140,text.length*8),height:index===0?42:22}}));
    const r=extractCardV5([{lines,rawText:fixture.input.join('\n')}]);
    assert.equal(r.company.value,fixture.expected);
    assert.equal(r.firstName.value,fixture.first);
    assert.equal(r.lastName.value,fixture.last);
    assert.equal(r.role.value,fixture.role);
    assert.ok(r.company.score <= 0.69, 'OCR repair requires review');
  });
}

for (const brand of ['A.B.CD.', 'E.F.GH.']) {
  for (const [tail, suffix] of [['s.n,G', 'S.n.c.'], ['s.n.e', 'S.n.c.'], ['B.n.c', 'S.n.c.'], ['s.r,Q', ''], ['l.l,X', '']]) {
    test(`V28.1 generic acronym: ${brand} ${tail}`, () => {
      const texts = [`${brand} ${tail}`, 'Jane Doe', 'Account Manager', 'INDUSTRIAL AUTOMATION AND ENGINEERING'];
      const lines: OcrLine[] = texts.map((text,i) => ({text,confidence:0.96,
        boundingBox:{x:20,y:i*34,width:Math.max(140,text.length*8),height:i===0?42:22}}));
      const r = extractCardV5([{lines,rawText:texts.join('\n')}]);
      assert.equal(r.company.value, `${brand} ${suffix}`.trim());
      assert.ok(r.company.score <= 0.69);
    });
  }
}

test('V28.2 real-device glyph: legal tail is repaired without inventing brand punctuation', () => {
  const texts = [
    'DANTE CHIERICO',
    'PERITO INDUSTRIALE',
    'S.A.GE.MA, B.n.c',
    'SISTEMI AUTOMATICI GENERALI E MACCHINE',
    'Telefono (0445) 671155',
  ];
  const lines: OcrLine[] = texts.map((text, index) => ({
    text,
    confidence: 0.96,
    boundingBox: {
      x: 20,
      y: index * 34,
      width: Math.max(140, text.length * 8),
      height: index === 0 ? 42 : 22,
    },
  }));
  const result = extractCardV5([{ lines, rawText: texts.join('\n') }]);
  assert.equal(result.company.value, 'S.A.GE.MA, S.n.c.');
  assert.equal(result.firstName.value, 'Dante');
  assert.equal(result.lastName.value, 'Chierico');
  assert.equal(result.role.value, 'PERITO INDUSTRIALE');
  assert.ok(result.company.score <= 0.69);
});
