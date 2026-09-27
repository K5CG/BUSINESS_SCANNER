import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine, OcrQualityMetadata } from '../types';
import {
  reconcileBusinessCardAngleConsensus,
  type OcrAngleAttempt,
  type OcrScanResult,
} from '../lib/ocr';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

const QUALITY: OcrQualityMetadata = { confidenceType: 'unknown', qualityReasons: [], requiresReview: false };
const ANGLES = [0, 90, 180, 270] as const;

function scan(text: string, rotationDegrees: 0 | 90 | 180 | 270): OcrScanResult {
  const lines = text.split('\n').map((value, index): OcrLine => ({
    text: value,
    confidence: 0.96,
    boundingBox: { x: 10, y: index * 28, width: Math.max(100, value.length * 7), height: 22 },
  }));
  return { lines, text, quality: QUALITY, rotationDegrees };
}

function pageFromRotations(rotations: readonly string[], selectedAngle: 0 | 90 | 180 | 270): CardPageV5 {
  const attempts: OcrAngleAttempt[] = rotations.map((text, index) => ({
    angle: ANGLES[index]!,
    result: scan(text, ANGLES[index]!),
  }));
  const selected = attempts.find((attempt) => attempt.angle === selectedAngle)!.result;
  const reconciled = reconcileBusinessCardAngleConsensus(selected, attempts);
  return { lines: reconciled.lines, rawText: reconciled.text };
}

const SAGE = [
`DANTE CHIERICO
PERITO INDUSTRIALE
S,A. GE. MA. s.n.c.
SISTEMI AUTOMATICI GENERALI E MACCHINE
36015 SCHIO (Vicenza) ITALY
Via Molise, 12 Z. I.
Codice Flscale 00255760241
Telefono (0445) 671155
Partita lVA 00255760241`,
`Telefono (0445) 671155
Via Molise, 12 Z. I.
36015 SCHIO (Vicenza) ITALY
DANTE CHIERICO
PERITO INDUSTRIALE
S.A.GE. MA, s. n.c.
Codice Flscale 00255760241
Partita IVA 00255760241`,
`Partita IVA 00255760241
Telefono (0445) 671155
Codice Fiscale 00255760241
Via Molise, 12 Z. I.
36015 SCHIO (Vicenza) ITALY
S.A.GE. MA, 6.n.c.
PERITO INDUSTRIALE
DANTE CHIERICO`,
`Codice Fiscale 00255760241
00255760241
S.A.GE. MA, 6.n.c.
Partita IVA
DANTE CHIERICO
36015 SCHIO (Vicenza) ITALY
PERITO INDUSTRIALE
Telefono (0445) 671155
Via Molise, 12 Z.I.`,
] as const;

const ONLY_TYPE = [
`"Only Type"
di Balduzzo Raimondo
Sede: S.S. Pasubio, 9-Costabissara (VI)
Tel. 0444 557031 - Cell. 371 4437185
onlytype @libero.it
P. IVA 02310100249 - C.F. BLDRND69A13L840W`,
`"Only Type"
P. IVA 023101002 49 - C.F. BLDRND69A13L840W
Tel. 0444 557031 - Cell. 371 4437185
di Balduzzo Raimondo
Pasubio, 9 - Costabissara (VI)
onlytype @libero.it`,
`P. IVA 02310100249 -C.F. BLDRND69A13L840W
onlytype @libero.it
Tel. 0444 557031 - Cell. 371 4437185
Sede: S.S. Pasubio,9-Costabissara (VI)
di Balduzzo Raimondo
"Only Type"`,
`"Only Type"
Tel. 0444 557031 - Cell. 37I 4437185
P. IVA 02310100249 -C.F. BLDRND69A13L84OW
9-Costabissara (VI)
di Balduzzo Raimondo
onlytype @ libero.it
Sede: S.S. Pasubio`,
] as const;

const CORIUM = [
`CORIUM
Dott. Marco Tagliabue
Amministratore Delegato
Via Correggio, 19 - 20149 Milano Via Savoia, 78- 00198 Rona
Tel. 02480143 17
Tel. 068413222
E-mail: tagliabue@coriunm-srl.it`,
`B-mail: tagliabue@eorium-srl.it
Via Correggio, 19 - 20149 Milano
Tel. 02418014317
Dott. Marco Tagliabue
Amministratore Delegato
CORIUVM
Tel. 068413222
Via Savoia, 78 - 00198 Roma`,
`E-mail: tagliabue @eorium-srl.it
Tel. 068413222
Tel. 0248014317
Via Savoia, 78 -00198 Roma
Via Correggio. 19 - 20149 Milano
Amministratore Delegato
Dott. Marco Tagliabue
ORIUM`,
`Via Savoia, 78- 00198 Roma
Dott. Marco Tagliabue
ORIUM
Amministratore Delegato
Via Correggio, 19 - 20149 Milano
E-mail: tagliabue Oeorium-srl.it
Tel. 0248014317`,
] as const;

const ATROX_BACK = [
`Inspire the Next
P.O.Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan
www.atrox-gear.com`,
`P.O. Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan
Inspire the Next
www.atrox-gear.com`,
`www.atrox-gear.com
2 P.O.Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan
Inspire the Next`,
`P.O. Box-2671, 10-Km Sambrial Road, Sialkot-51310, Pakistan
www.atrox-gear.com
Inspire the Next`,
] as const;

const INTERCASA_BACK = [
`www.intercasanet. it
Intercasa s.r.i.u.
36015_Schio_VI
Via Carnpo Sportivo_30
Tel_0445.512.360
Fax_0445.512.391
info@intercasanet.it
8477@pec.fiaip.it
P.I. 02 8 1 7290246`,
`P.I. 02817290246
Fax_0445.512.391
Tel_0445.512.360
Via Carnpo Sportivo_30
36015_Schio_Vi
Intercasa s.r.l.u.
www.intercasanet. it`,
`P.I. 02817290246
Fax_0445.512.391
Tel_0445.512.360
Via Campo Sportivo_30
36015_ Schio_VI
Intercasa s.r.l.u.
www.intercasanet.it`,
`Intercasa s.r.l.U.
36015_Schio_VI
Via Campo SportiVo_30
Tel_0445.512.360
Fax_0445.512.391
info@intercasanet.it
8477@pec.fiaip.it
P.I. 02817290246
www.intercasanet.it`,
] as const;

test('V34 phone corpus: consenso reale completo SAGE', () => {
  const result = extractCardV5([pageFromRotations(SAGE, 0)]);
  assert.match(result.company.value ?? '', /^S\.A\.GE\.MA\. S\.n\.c\.$/i);
  assert.equal(result.firstName.value, 'Dante');
  assert.equal(result.lastName.value, 'Chierico');
  assert.equal(result.vatNumber.value, '00255760241');
  assert.match(result.address.value?.street ?? '', /Molise/i);
});

test('V34 phone corpus: consenso reale completo Only Type', () => {
  const result = extractCardV5([pageFromRotations(ONLY_TYPE, 0)]);
  assert.equal(result.company.value, 'Only Type');
  assert.equal(result.firstName.value, 'Raimondo');
  assert.equal(result.lastName.value, 'Balduzzo');
  assert.equal(result.taxCode.value, 'BLDRND69A13L840W');
  assert.equal(result.vatNumber.value, '02310100249');
});

test('V34 phone corpus: email CORIUM senza quorum corretto non diventa falsa certezza', () => {
  const result = extractCardV5([pageFromRotations(CORIUM, 0)]);
  assert.equal(result.company.value, 'CORIUM');
  assert.equal(result.firstName.value, 'Marco');
  assert.equal(result.lastName.value, 'Tagliabue');
  assert.ok(result.emails.score < 0.75, `email OCR discordante marcata troppo alta: ${result.emails.score}`);
  assert.ok(result.emails.value.every((email) => !/eorium|coriunm/i.test(email)) || result.emails.score < 0.7);
});

test('V34 phone corpus: P.O. Box e CAP reale restano distinti in tutte le rotazioni', () => {
  for (const raw of ATROX_BACK) {
    const result = extractCardV5([{ lines: scan(raw, 0).lines, rawText: raw }]);
    assert.equal(result.address.value?.postalCode, '51310');
    assert.match(result.address.value?.full ?? '', /Box-2671/i);
  }
});

test('V34 phone corpus: maggioranza reale corregge Campo Sportivo e conserva fiscali', () => {
  const reconciledPage = pageFromRotations(INTERCASA_BACK, 0);
  const result = extractCardV5([reconciledPage]);
  assert.equal(result.company.value, 'Intercasa S.r.l.u.');
  assert.equal(result.address.value?.postalCode, '36015');
  assert.match(result.address.value?.street ?? '', /Via Campo Sportivo/i);
  assert.equal(result.vatNumber.value, '02817290246');
});
