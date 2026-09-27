import fs from 'fs';
import { extractCardV5 } from '../lib/parser-v5/engine.ts';

function runRaw(raw, label) {
  const lines = raw.split('\n').map((text, i) => ({
    text,
    confidence: 0.85,
    boundingBox: { x: 30, y: 20 + i * 18, width: 500, height: 16 },
  }));
  const r = extractCardV5([{ rawText: raw, lines }]);
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);
  console.log(label, {
    firstName: v(r.firstName),
    lastName: v(r.lastName),
    company: v(r.company),
    emails: v(r.emails),
  });
}

const domo = fs.readFileSync(
  'scripts/qa-import/export-2026-07-14-device/raw-text/60f5405e-cc6d-4f89-afdc-94fe0f60428b.txt',
  'utf8'
);
const tagliabue = fs.readFileSync(
  'scripts/qa-import/export-2026-07-14-device/raw-text/8ee17f33-211e-442a-a830-b3068444c995.txt',
  'utf8'
);

runRaw(domo, 'domo-device');
runRaw(tagliabue, 'tagliabue-device');

const tagliabueBad = `ORIUM
Dott. Mlarco Tagliabue
Amministratore Delegato
Tel. 068413222
E-mail: tagliabue@oriiun-srl.it
Via Savoia, 78 -00198 Roma`;

runRaw(tagliabueBad, 'tagliabue-oriiun');

const domoSlogan = `A facile
È DOMO/acile
348.2655838 DANIELA
dgavasso@domofacile.com
GAVASSO
Dormcfacile srL`;

runRaw(domoSlogan, 'domo-slogan-trap');
