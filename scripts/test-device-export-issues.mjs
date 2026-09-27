import { extractCardV5 } from '../lib/parser-v5/engine.ts';

function run(raw, label) {
  const lines = raw.split('\n').map((text, i) => ({
    text,
    confidence: 0.85,
    boundingBox: { x: 30, y: 20 + i * 18, width: 500, height: 16 },
  }));
  const r = extractCardV5([{ rawText: raw, lines }]);
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);
  console.log('\n===', label, '===');
  console.log({
    firstName: v(r.firstName),
    lastName: v(r.lastName),
    company: v(r.company),
    role: v(r.role),
    emails: v(r.emails),
    website: v(r.website),
  });
}

const gandh = `G&HNTERNATIONAL CO, LTD.
Overseas Sales Dept/Goneral Manager
Deana
82-10-7396-3837
Head Otfice /2F, 69, CheonhO-chera Gwengin-g Seoul 0493 Korea
T, 82-2-455-1823(Fep) F 82-2455-1824 Web wwwQƏNdheak
Daegu Factory /1, Seongseo-o 34-9il, Dalseo-gu Daegu 42704, Korea
T. 82-53-587-18234 F 8253-587-1826E deanaandh ea kr`;

const software4u = `SOFTWARE Franco Adami Carbonara
Responsabile Marketing e Vendite
Cel. 329 78751I3
FuLL BUNESS SoLuTIONE e-mail fadami@software4u.it
SOFTWARE
4U s.rl.
Via G. da Cascia, 27 50127 Firenze
Italy
Tel. +39(0)55 355540 Fax +39(0) 55 0510535
e-mail info@software4u.it www.software4uit - www.o2gen.net`;

run(gandh, 'G&H Deana');
run(software4u, 'Software4u Franco Adami');

const domofacile = `IL MERCATO IMMOBILIA
A facile
È DOMO/acile
IL RESTOÈ DIFFICILE
348.2655838 DANIELA
dgavasso@domofacile.com
GAVASSO
www.domofacile.it
Dormcfacile srLSocieta Unipersonale
Sede Legale 36040 Torri diQuartesolo (Vi Via Roma 137
crizicne ruolo mediatorn33e5 CCiAA diVicenza`;

run(domofacile, 'Domofacile Daniela Gavasso');
