import { extractCardV5 } from '../lib/parser-v5/engine.ts';

const cases = [
  ['orientaform', `OrientaForm
formazione@orientaform.it
www.orientaform.it
Formazione e Orientamento
Ente accreditato per i servizi al lavoro
presso la Regione Veneto
OrientoForm snc CF /PNA 03674360247 Loc Ponte d'oro 8/E Schio (VI)`],
  ['technical-touch', `KYB
TECHNICAL TOUCH bvba
IZ Kristalpark - Ondernemersstraat 20- 3920 Lommel (Belgium)
Tel. 0032-11-54.96.96
e-mail: info@technical-touch.com - www.technical-touch.com`],
  ['arata', `ServOV Next Generation Platform
Enrico Arata
Corso Massimo d'Azeglio, 8
Responsabile Servoy Italia
IO15 Torino
direct tel +39 335 29 59 65
earataaservoy com
www.servoy.com`],
  ['themis', `Potonio Gaboardk
Senior Partner
mobile 39 392 17 21 116
agaboardi@thenissoluzioni it
www themissoluzioni it
info@ themissoluzioni it`],
  ['cts', `Membership Card 2003
Cognome - Family name
CHIOZZA
Nome - First Names
G10VARRI
Centro Turistico Studentesco e Giovanile
Presidenza Nazionale via A. Vesalio, 6 -00161 Roma`],
];

for (const [name, raw] of cases) {
  const lines = raw.split('\n').map((text, i) => ({ text, confidence: 0.9, boundingBox: { x: 0, y: i * 20, width: 300, height: 16 } }));
  const r = extractCardV5([{ rawText: raw, lines }]);
  console.log('\n===', name, '===');
  console.log(JSON.stringify({
    first: r.firstName.value,
    last: r.lastName.value,
    company: r.company.value,
    role: r.role.value,
    emails: r.emails.value,
    phones: r.phones.value?.map(p => p.number),
    address: r.address.value?.full,
  }, null, 2));
}
