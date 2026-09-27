import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5, type V5Result } from '../lib/parser-v5/engine';

/**
 * BUSINESS SCANNER UNIVERSAL STRESS GATE
 *
 * Deterministic generative/metamorphic suite. It deliberately does NOT encode
 * any real card, person, company or fixture. Every identity is synthesized.
 * A failing seed is printed so the exact case can be reproduced.
 */

const DEFAULT_CASES = Number(process.env.BS_STRESS_CASES ?? '4096');
const MASTER_SEED = Number(process.env.BS_STRESS_SEED ?? '120926');

class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]!; }
  bool(p = 0.5): boolean { return this.next() < p; }
  shuffle<T>(a: readonly T[]): T[] {
    const out = [...a];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1); [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

const FIRST = ['Avery','Mina','Omar','Lea','Noah','Sora','Dario','Iris','Nadia','Kenji','Yuna','Arun','Maya','Luis','Zoe','Tariq'];
const LAST = ['Lane','Street','Road','Park','King','Young','Black','Green','Hill','West','East','Stone','March','May','Long','Cross'];
const BRAND = ['North Arc','Delta Forge','Blue Peak','Vertex Lab','Orbit Works','Nova Grid','Cedar Systems','Mosaic Tech','Atlas Motion','Bright Field'];
const LEGAL = ['S.r.l.','S.p.A.','Ltd.','LLC','GmbH','B.V.','A.G.','S.A.','A/S','Kft'];
const ROLES = ['Chief Operating Officer','Global Sales Director','Research Engineer','Account Manager','Vice President Partnerships','Industrial Designer','General Manager','Technical Consultant'];
const STREETS = ['Market Street','King Road','Park Lane','Industriestrasse','Rue du Lac','Avenida Central','Via delle Rose','Sakura-dori'];
const CITIES = ['Boston','Schio','Berlin','Osaka','Lyon','Sialkot','Seoul','Warsaw','Lisbon','Dublin'];
const COUNTRIES = ['Italy','Germany','Japan','France','Pakistan','Korea','Poland','Portugal','Ireland','USA'];
const CJK_NOISE = ['株式会社','東京','営業部','서울','부산','有限公司','上海'];
const BG_NOISE = ['PACIFIC','NORTH','OCEAN','ANDS','CERTIFIED','QUALITY','GLOBAL','GROUP'];

function page(lines: readonly string[], rng: Rng): CardPageV5 {
  return {
    lines: lines.map((text, i): OcrLine => ({
      text,
      confidence: 0.72 + rng.next() * 0.27,
      boundingBox: { x: 8 + rng.int(40), y: i * (20 + rng.int(9)), width: Math.max(60, text.length * 7), height: 18 + rng.int(11) },
    })),
    rawText: lines.join('\n'),
  };
}

function digits(s: string): string { return s.replace(/\D/g, ''); }
function phoneDigits(r: V5Result): string[] { return (r.phones.value ?? []).map(p => digits(p.number)).filter(Boolean).sort(); }
function emails(r: V5Result): string[] { return [...(r.emails.value ?? [])].map(v => v.toLowerCase()).sort(); }
function websites(r: V5Result): string[] { const v=r.website.value; return v ? [v.toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'')] : []; }
function key(s: string | null | undefined): string { return (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,''); }
function addressText(r: V5Result): string {
  const a = r.address.value;
  if (!a) return '';
  return [a.full, a.street, a.civicNumber, a.postalCode, a.city, a.region, a.country, ...(a.rawLines ?? [])]
    .filter((v): v is string => Boolean(v && String(v).trim()))
    .join(' | ');
}

function mkPhone(rng: Rng): { shown: string; canon: string } {
  const cc = rng.pick(['+1','+33','+39','+49','+44','+81','+82','+92']);
  const a = String(200 + rng.int(700));
  const b = String(100 + rng.int(900));
  const c = String(1000 + rng.int(9000));
  const canon = digits(cc+a+b+c);
  const fmt = rng.int(6);
  const shown = fmt === 0 ? `${cc} ${a} ${b} ${c}` :
    fmt === 1 ? `${cc}-${a}-${b}-${c}` :
    fmt === 2 ? `${cc} (${a}) ${b}-${c}` :
    fmt === 3 ? `${cc}.${a}.${b}.${c}` :
    fmt === 4 ? `${cc}/${a}/${b}/${c}` : `${cc}${a}${b}${c}`;
  return { shown, canon };
}

function mutateWhitespace(s: string, rng: Rng): string {
  return s.split(/\s+/).map(t => rng.bool(.25) ? ` ${t} ` : t).join(rng.bool() ? ' ' : '  ').trim();
}
function mutateEmailWhitespace(email: string, rng: Rng): string {
  const [local, dom] = email.split('@');
  if (!local || !dom) return email;
  const [d1, ...rest] = dom.split('.');
  return `${local}${rng.bool()?' ':' '}@${rng.bool()?' ':' '}${d1}${rng.bool()?' ':''}.${rng.bool()?' ':''}${rest.join('.')}`;
}
function flipHarmlessCase(s: string, rng: Rng): string {
  return [...s].map(ch => /[a-z]/i.test(ch) && rng.bool(.18) ? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : ch).join('');
}

interface SyntheticCard {
  lines: string[];
  first: string; last: string; company: string; role: string;
  email: string; web: string; phone: { shown: string; canon: string };
  vat: string; postal: string; city: string;
}
function synth(rng: Rng): SyntheticCard {
  const first = rng.pick(FIRST), last = rng.pick(LAST);
  const brand = rng.pick(BRAND), legal = rng.pick(LEGAL), company = `${brand} ${legal}`;
  const role = rng.pick(ROLES);
  const root = brand.toLowerCase().replace(/[^a-z0-9]+/g,'');
  const email = `${first}.${last}@${root}.example`.toLowerCase();
  const web = `www.${root}.example`;
  const phone = mkPhone(rng);
  const vat = String(10000000000 + rng.int(899999999));
  const postal = String(10000 + rng.int(89999));
  const city = rng.pick(CITIES);
  const street = rng.pick(STREETS);
  const civic = String(1 + rng.int(199));
  const country = rng.pick(COUNTRIES);
  return { first,last,company,role,email,web,phone,vat,postal,city,
    lines: [`${first} ${last}`, role, company, `Email: ${email}`, `Web: ${web}`, `Tel: ${phone.shown}`, `VAT: ${vat}`, `${street} ${civic}`, `${postal} ${city}`, country] };
}

function assertStructuredStable(a: V5Result, b: V5Result, label: string): void {
  assert.deepEqual(emails(b), emails(a), `${label}: email changed`);
  assert.deepEqual(phoneDigits(b), phoneDigits(a), `${label}: phone changed`);
  assert.deepEqual(websites(b), websites(a), `${label}: website changed`);
  assert.equal(b.vatNumber.value, a.vatNumber.value, `${label}: VAT changed`);
}

function runFamily(rng: Rng, family: number, seed: number): void {
  const c = synth(rng);
  const base = extractCardV5([page(c.lines, rng)]);
  const prefix = `seed=${seed} family=${family}`;

  switch (family) {
    case 0: { // line-order invariance for structured fields
      const perm = rng.shuffle(c.lines);
      const r = extractCardV5([page(perm, rng)]);
      assertStructuredStable(base, r, `${prefix} order`);
      break;
    }
    case 1: { // duplicates must not create duplicate channels
      const dups = [...c.lines, c.lines[3]!, c.lines[5]!, c.lines[6]!];
      const r = extractCardV5([page(rng.shuffle(dups), rng)]);
      assert.equal(new Set(emails(r)).size, emails(r).length, `${prefix} duplicate email`);
      assert.equal(new Set(phoneDigits(r)).size, phoneDigits(r).length, `${prefix} duplicate phone`);
      assert.equal(phoneDigits(r).filter(x => x === c.phone.canon).length <= 1, true, `${prefix} duplicated same phone`);
      break;
    }
    case 2: { // international phone punctuation invariance
      const alt = mkPhone(new Rng(seed ^ 0xa5a5a5a5));
      const sameDigits = c.phone.canon;
      const ccLen = sameDigits.startsWith('1') ? 1 : 2;
      const rest = sameDigits.slice(ccLen);
      const shown = `+${sameDigits.slice(0,ccLen)} (${rest.slice(0,3)}) ${rest.slice(3,6)}-${rest.slice(6)}`;
      const lines = c.lines.map(x => x.startsWith('Tel:') ? `Tel: ${shown}` : x);
      const r = extractCardV5([page(lines, rng)]);
      assert.ok(phoneDigits(r).includes(sameDigits), `${prefix} phone punctuation lost ${shown}`);
      void alt;
      break;
    }
    case 3: { // VAT must never resurrect as phone
      const lines = c.lines.filter(x => !x.startsWith('Tel:'));
      const r = extractCardV5([page(lines, rng)]);
      assert.equal(phoneDigits(r).includes(c.vat), false, `${prefix} VAT became phone`);
      break;
    }
    case 4: { // postal/civic/P.O. Box collision
      const box = String(1000 + rng.int(8000));
      const civic5 = String(10000 + rng.int(80000));
      const lines = [`${c.first} ${c.last}`, c.company, `No. ${civic5} ${rng.pick(STREETS)}`, `P.O. Box ${box}`, `${c.postal} ${c.city}`, `Email: ${c.email}`];
      const r = extractCardV5([page(lines, rng)]);
      assert.notEqual(r.address.value?.postalCode, box, `${prefix} PO Box became postal`);
      assert.notEqual(r.address.value?.postalCode, civic5, `${prefix} labeled civic became postal`);
      break;
    }
    case 5: { // registry numbers must not become address/postal
      const reg = String(100000 + rng.int(800000));
      const lines = [`${c.first} ${c.last}`, c.company, `REA ${reg}`, `${c.postal} ${c.city}`, `${rng.pick(STREETS)} ${1+rng.int(99)}`];
      const r = extractCardV5([page(lines, rng)]);
      assert.notEqual(r.address.value?.postalCode, reg, `${prefix} registry became postal`);
      assert.equal(addressText(r).toLowerCase().includes(`rea ${reg}`.toLowerCase()), false, `${prefix} registry contaminated address`);
      break;
    }
    case 6: { // email whitespace mutation may normalize, never invent local part
      const mutated = mutateEmailWhitespace(c.email, rng);
      const lines = c.lines.map(x => x.startsWith('Email:') ? `Email: ${mutated}` : x);
      const r = extractCardV5([page(lines, rng)]);
      for (const e of emails(r)) assert.equal(key(e.split('@')[0]), key(c.email.split('@')[0]), `${prefix} email local-part invented`);
      break;
    }
    case 7: { // malformed missing @ cannot be reconstructed from person name alone
      const dom = c.email.split('@')[1]!;
      const lines = c.lines.map(x => x.startsWith('Email:') ? `Email: ${c.email.replace('@','')}` : x).filter(x => !x.startsWith('Web:'));
      const r = extractCardV5([page(lines, rng)]);
      for (const e of emails(r)) {
        assert.equal(e.endsWith(`@${dom}`) && key(e.split('@')[0]) === key(`${c.first}.${c.last}`), false, `${prefix} invented email from person`);
      }
      break;
    }
    case 8: { // role/company separation under casing and descriptor noise
      const role = flipHarmlessCase(c.role.toUpperCase(), rng);
      const company = mutateWhitespace(c.company.toUpperCase(), rng);
      const r = extractCardV5([page([`${c.first} ${c.last}`, role, company, `Email: ${c.email}`, `Web: ${c.web}`], rng)]);
      assert.equal(key(r.company.value).includes(key(c.role)), false, `${prefix} role became company`);
      assert.equal(key(r.role.value).includes(key(c.company)), false, `${prefix} company became role`);
      break;
    }
    case 9: { // person surnames that are address/common words need exact personal evidence
      const r = extractCardV5([page([`${c.first} ${c.last}`, c.role, c.company, `Email: ${c.email}`], rng)]);
      assert.equal(key(`${r.firstName.value}${r.lastName.value}`).includes(key(`${c.first}${c.last}`)), true, `${prefix} common-word surname lost`);
      break;
    }
    case 10: { // ambiguous legal suffix + separators: no unjustified high confidence
      const phrase = `${rng.pick(['REVISION','REPORT','MESSAGE','STATUS'])}:${rng.pick(['X1','R2','Q7'])} ${rng.pick(['A.G.','S.A.','B.V.'])}`;
      const r = extractCardV5([page([`${c.first} ${c.last}`, phrase, c.role], rng)]);
      if (key(r.company.value) === key(phrase)) assert.ok(r.company.score < 0.70, `${prefix} ambiguous separator overconfident score=${r.company.score}`);
      break;
    }
    case 11: { // CJK/Latin mixed noise must not corrupt structured channels
      const lines = [...c.lines, rng.pick(CJK_NOISE), rng.pick(CJK_NOISE)];
      const r = extractCardV5([page(rng.shuffle(lines), rng)]);
      assertStructuredStable(base, r, `${prefix} CJK coexistence`);
      break;
    }
    case 12: { // background-like words must not displace strongly evidenced identity
      const lines = [rng.pick(BG_NOISE), ...c.lines, rng.pick(BG_NOISE)];
      const r = extractCardV5([page(lines, rng)]);
      assert.equal(key(r.company.value).includes(key(c.company.split(' ')[0])), true, `${prefix} background displaced company`);
      assert.equal(BG_NOISE.some(n => key(r.role.value) === key(n)), false, `${prefix} background became role`);
      break;
    }
    case 13: { // missing evidence should not increase confidence (metamorphic monotonicity)
      const full = extractCardV5([page(c.lines, rng)]);
      const reducedLines = c.lines.filter(x => !x.startsWith('Web:') && !x.startsWith('Email:'));
      const reduced = extractCardV5([page(reducedLines, rng)]);
      if (key(full.company.value) && key(full.company.value) === key(reduced.company.value)) {
        assert.ok(reduced.company.score <= full.company.score + 1e-9, `${prefix} company confidence increased after evidence removal ${full.company.score}->${reduced.company.score}`);
      }
      break;
    }
    case 14: { // two-page conflict must not silently merge identities
      const c2 = synth(new Rng(seed ^ 0x6d2b79f5));
      const r = extractCardV5([page(c.lines, rng), page(c2.lines, rng)]);
      const person = key(`${r.firstName.value}${r.lastName.value}`);
      const p1 = key(`${c.first}${c.last}`), p2 = key(`${c2.first}${c2.last}`);
      assert.equal(person.includes(p1) && person.includes(p2), false, `${prefix} merged two people`);
      break;
    }
    case 15: { // room/suite/building details should survive if address exists
      const room = `Room ${1+rng.int(40)}${String.fromCharCode(65+rng.int(6))}`;
      const lines = [`${c.first} ${c.last}`, c.company, `${rng.pick(STREETS)} ${1+rng.int(99)}`, room, `${c.postal} ${c.city}`];
      const r = extractCardV5([page(lines, rng)]);
      if (r.address.value) assert.ok(addressText(r).toLowerCase().includes('room'), `${prefix} room lost from address`);
      break;
    }

    case 16: { // observed identity next to role beats a conflicting email-local identity
      const altFirst = rng.pick(FIRST.filter((v) => v !== c.first));
      const altLast = rng.pick(LAST.filter((v) => v !== c.last));
      const domain = c.email.split('@')[1]!;
      const conflictingEmail = `${altFirst}.${altLast}@${domain}`.toLowerCase();
      const r = extractCardV5([page([`${c.first} ${c.last}`, c.role, c.company, `Email: ${conflictingEmail}`, `Web: ${c.web}`], rng)]);
      assert.equal(key(`${r.firstName.value}${r.lastName.value}`), key(`${c.first}${c.last}`), `${prefix} observed identity displaced by email local-part`);
      break;
    }
    case 17: { // owner formula with surname-first ordering must resolve without card-specific names
      const first = rng.pick(['Marco','Luca','Maya','Nadia','Arun','Kenji']);
      const last = rng.pick(['Rossi','Bianchi','Stone','Cross','West','Green']);
      const brand = `${rng.pick(['Orbit','Nova','Cedar','Atlas'])} Type`;
      const consonants = (value: string) => key(value).toUpperCase().replace(/[AEIOU]/g, '');
      const vowels = (value: string) => key(value).toUpperCase().replace(/[^AEIOU]/g, '');
      const surnameCode = ((consonants(last) + vowels(last) + 'XXX').slice(0, 3));
      const firstCons = consonants(first);
      const givenCode = firstCons.length >= 4
        ? `${firstCons[0]}${firstCons[2]}${firstCons[3]}`
        : (firstCons + vowels(first) + 'XXX').slice(0, 3);
      const fiscalCode = `${surnameCode}${givenCode}80A01H501Z`;
      const r = extractCardV5([page([brand.toUpperCase(), `di ${last.toUpperCase()} ${first.toUpperCase()}`, `C.F. ${fiscalCode}`, `Email: info@${key(brand)}.example`, `Tel: ${c.phone.shown}`], rng)]);
      assert.equal(key(r.firstName.value), key(first), `${prefix} owner first name/order lost`);
      assert.equal(key(r.lastName.value), key(last), `${prefix} owner surname/order lost`);
      assert.equal(key(r.company.value).includes(key(brand)), true, `${prefix} owner brand lost`);
      break;
    }
    case 18: { // professional firm with multiple offices must keep offices separate
      const pc2 = String(10000 + rng.int(89999));
      const pc3 = String(10000 + rng.int(89999));
      const r = extractCardV5([page([
        'STUDIO PROFESSIONALE ASSOCIATO',
        `${c.first} ${c.last}`,
        'Avvocato',
        `${rng.pick(STREETS)} ${1+rng.int(90)}, ${c.postal} ${c.city}`,
        `Tel: ${c.phone.shown}`,
        `${rng.pick(STREETS)} ${91+rng.int(90)}, ${pc2} ${rng.pick(CITIES)}`,
        `Tel: ${mkPhone(rng).shown}`,
        `${rng.pick(STREETS)} ${181+rng.int(90)}, ${pc3} ${rng.pick(CITIES)}`,
      ], rng)]);
      const all = [r.address.value, ...(r.addressAlternatives ?? [])].filter(Boolean);
      assert.ok(all.length >= 2, `${prefix} multiple offices fused/lost`);
      assert.match(r.company.value ?? '', /Studio|Professionale|Associato/i, `${prefix} professional firm header lost`);
      break;
    }
    case 19: { // qualified role survives nearby graphic/logo-like noise
      const role = rng.pick(['Certified Trainer Level 1','Senior Technical Consultant','Area Marketing Manager','Head of Product Development']);
      const noise = rng.pick(['PIXIES','BADGE','ICONIC','SYMBOL']);
      const r = extractCardV5([page([`${c.first} ${c.last}`, role, `Email: ${c.email}`, noise], rng)]);
      assert.equal(key(r.role.value).includes(key(role)), true, `${prefix} qualified role lost`);
      if (key(r.company.value) === key(noise)) {
        assert.ok(r.company.score < 0.5, `${prefix} isolated graphic/logo noise became confident company`);
      }
      break;
    }
    case 20: { // observed surname-particle spacing must beat fused email local-part
      const particle = rng.pick(['De','Da','Van','Von']);
      const family = rng.pick(['Vecchi','Riva','Berg','Stein','Costa']);
      const observedLast = `${particle} ${family}`;
      const localLast = `${particle}${family}`.toLowerCase();
      const first = rng.pick(['Fabio','Maya','Nadia','Kenji','Arun']);
      const r = extractCardV5([page([`${first} ${observedLast}`, c.role, c.company, `Email: ${first.toLowerCase()}.${localLast}@${key(c.company)}.example`], rng)]);
      assert.equal(key(r.lastName.value), key(observedLast), `${prefix} particle surname letters changed`);
      assert.ok((r.lastName.value ?? '').includes(' '), `${prefix} observed particle spacing fused`);
      break;
    }
    case 21: { // letter-spaced business descriptor may repair only with corroborating domain
      const brand = rng.pick(['ORBIT','NOVA','CEDAR','ATLAS','MOSAIC']);
      const activity = rng.pick(['CONSULTING','SERVICES','SYSTEMS']);
      const spaced = activity.split('').join(' ');
      const host = `${brand.toLowerCase()}.com`;
      const r = extractCardV5([page([`${c.first} ${c.last}`, c.role, `${brand} ${spaced}`, `Web: www.${host}`], rng)]);
      assert.equal(key(r.company.value).includes(key(brand)), true, `${prefix} corroborated brand lost`);
      assert.equal(key(r.company.value).includes(key(activity)), true, `${prefix} letter-spaced activity not recovered`);
      assert.ok(r.company.score < 0.8, `${prefix} OCR activity repair overconfident`);
      break;
    }
    case 22: { // labeled OCR-dirty phones must not contaminate address
      const lines = [
        `${c.first} ${c.last}`, c.company,
        'T +39 045 21 O00 84',
        'F +39 045 21 O00 B5',
        `${rng.pick(STREETS)} ${1+rng.int(90)}, ${c.postal} ${c.city}`,
      ];
      const r = extractCardV5([page(lines, rng)]);
      assert.ok(phoneDigits(r).some(v => v.endsWith('390452100084')), `${prefix} OCR-dirty phone not recovered`);
      assert.ok(phoneDigits(r).some(v => v.endsWith('390452100085')), `${prefix} OCR-dirty fax not recovered`);
      assert.doesNotMatch(addressText(r), /21\s*[Oo0]{2,}|T\s*\+39|F\s*\+39/i, `${prefix} phone residue contaminated address`);
      break;
    }
    case 23: { // international postal codes must never be resurrected as phones
      const jp = `${100+rng.int(899)}-${1000+rng.int(8999)}`;
      const eu = String(1000 + rng.int(8999));
      const r = extractCardV5([page([`${c.first} ${c.last}`, c.company, `Tokyo ${jp} Japan`, `Lisbon ${eu} Portugal`, `Email: ${c.email}`], rng)]);
      const p = phoneDigits(r);
      assert.equal(p.includes(digits(jp)), false, `${prefix} JP postal became phone`);
      assert.equal(p.includes(eu), false, `${prefix} EU postal became phone`);
      break;
    }
  }
}

test(`UNIVERSAL STRESS GATE — ${DEFAULT_CASES} deterministic synthetic/metamorphic cases`, { timeout: 180_000 }, () => {
  assert.ok(Number.isInteger(DEFAULT_CASES) && DEFAULT_CASES >= 240, 'BS_STRESS_CASES must be >= 240');
  const familyCount = 24;
  const totals = Array.from({ length: familyCount }, () => 0);
  const failed = Array.from({ length: familyCount }, () => 0);
  const samples: string[][] = Array.from({ length: familyCount }, () => []);

  for (let i = 0; i < DEFAULT_CASES; i++) {
    const seed = (MASTER_SEED + Math.imul(i + 1, 2654435761)) >>> 0;
    const family = i % familyCount;
    totals[family] += 1;
    try {
      runFamily(new Rng(seed), family, seed);
    } catch (err) {
      failed[family] += 1;
      if (samples[family]!.length < 6) {
        samples[family]!.push(
          `case=${i} seed=${seed} :: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  const totalFailures = failed.reduce((sum, value) => sum + value, 0);
  const summary = failed
    .map((count, family) => {
      const total = totals[family] || 1;
      const pct = ((count / total) * 100).toFixed(1);
      return `family=${family} failures=${count}/${total} (${pct}%)`;
    })
    .join('\n');

  if (totalFailures) {
    const details = failed
      .map((count, family) =>
        count > 0
          ? `\nFAMILY ${family} — ${count}/${totals[family]} FAIL\n${samples[family]!.join('\n')}`
          : ''
      )
      .join('');
    assert.fail(
      `UNIVERSAL STRESS FAIL total=${totalFailures}/${DEFAULT_CASES}\n${summary}${details}`
    );
  }
});
