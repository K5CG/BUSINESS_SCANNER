/**
 * Audit bulk export QA: confronta rawText OCR vs campi salvati.
 *
 * Uso:
 *   npx tsx scripts/audit-qa-export.mjs "C:/path/to/qa-contacts-export_1_30_....zip" ...
 *   npm run audit:qa -- "C:/Users/giova/Downloads/*.zip"
 *
 * Con analisi AI (Gemini diretto):
 *   EXPO_PUBLIC_GEMINI_API_KEY=... npm run audit:qa -- file1.zip file2.zip
 *
 * Con Supabase structure-business-card (confronto estrazione AI vs salvato):
 *   npm run audit:qa -- --ai-supabase file1.zip
 */

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';
import type { BusinessCard, OcrLine } from '../types';
import { fieldInRaw } from '../lib/parser-engine/validators/common/fieldMatcher';
import { hasCompanyEvidence } from '../lib/parser-engine/validators/common/hasCompanyEvidence';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const PHONE_DIGITS_MIN = 8;

const AUDIT_PROMPT = `Sei un revisore QA per biglietti da visita.
Ti passo il testo OCR grezzo e i campi già estratti/salvati dall'app (senza AI automatica in scansione).
Per ogni problema trovato, rispondi SOLO con JSON valido (array, nessun markdown):
[
  {
    "field": "emails|phones|company|firstName|lastName|role|website|address|vatNumber|taxCode",
    "severity": "high|medium|low",
    "issue": "missing|wrong|hallucinated|partial|format",
    "stored": "valore salvato o vuoto",
    "evidence": "citazione breve dal testo OCR che supporta o contraddice",
    "explanation": "perché è un errore o perché non è stato estratto"
  }
]
Regole:
- "missing": informazione chiaramente leggibile nell'OCR ma assente o vuota nei campi salvati
- "wrong": valore salvato non corrisponde all'OCR o è assegnato al campo sbagliato (es. ruolo in azienda)
- "hallucinated": valore salvato senza supporto nell'OCR
- "partial": valore troncato, dominio email errato per OCR (es. fuentisCom), telefono incompleto
- Non segnalare campi corretti. Se tutto ok, rispondi [].
- NON inventare dati non presenti nell'OCR.`;

type Issue = {
  field: string;
  severity: 'high' | 'medium' | 'low';
  issue: string;
  stored?: string;
  evidence?: string;
  explanation?: string;
  source: 'deterministic' | 'parser-replay' | 'ai-gemini' | 'ai-supabase';
};

type ContactAudit = {
  id: string;
  title: string;
  batchRange?: string;
  rawTextLength: number;
  issues: Issue[];
};

function pagesFromRawText(rawText: string): CardPageV5[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [{ lines: [], rawText: '' }];

  const chunks = trimmed.split(/\n\n+/).filter((chunk) => chunk.trim());
  const pageTexts = chunks.length > 0 ? chunks : [trimmed];

  return pageTexts.map((pageText) => {
    const lines: OcrLine[] = pageText
      .split('\n')
      .map((text, lineIndex) => ({
        text: text.trim(),
        confidence: 0.85,
        boundingBox: { x: 30, y: 20 + lineIndex * 18, width: 500, height: 16 },
      }))
      .filter((line) => line.text);
    return { lines, rawText: pageText };
  });
}

function v5ToSnapshot(result: ReturnType<typeof extractCardV5>): Record<string, string> {
  const addr = result.address.value;
  return {
    firstName: result.firstName.value ?? '',
    lastName: result.lastName.value ?? '',
    role: result.role.value ?? '',
    company: result.company.value ?? '',
    emails: (result.emails.value ?? []).join('; '),
    phones: (result.phones.value ?? []).map((p) => p.number).join('; '),
    website: result.website.value ?? '',
    address: addr?.full ?? [addr?.street, addr?.postalCode, addr?.city].filter(Boolean).join(', '),
    vatNumber: result.vatNumber.value ?? '',
    taxCode: result.taxCode.value ?? '',
  };
}
function loadEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9@.+]/g, '');
}

function extractEmailsFromRaw(raw: string): string[] {
  const found = new Set<string>();
  const matches = raw.match(EMAIL_REGEX) ?? [];
  for (const m of matches) found.add(m.toLowerCase());

  // OCR tipici: @ → spazio, dominio .Com, [at]
  const relaxed = raw
    .replace(/\[at\]|\(at\)|\s+at\s+/gi, '@')
    .replace(/(\w)Com\b/gi, '$1.com')
    .replace(/(\w)it\b/gi, (m, p1) => (p1.length > 2 ? `${p1}.it` : m));
  for (const m of relaxed.match(EMAIL_REGEX) ?? []) found.add(m.toLowerCase());

  return [...found];
}

function extractPhoneDigitStrings(raw: string): string[] {
  const candidates = raw.match(/(?:\+?\d[\d\s().\-/]{6,}\d)/g) ?? [];
  return candidates
    .map((c) => normalizeDigits(c))
    .filter((d) => d.length >= PHONE_DIGITS_MIN);
}

function phoneInRaw(number: string, raw: string): boolean {
  const digits = normalizeDigits(number);
  if (digits.length < PHONE_DIGITS_MIN) return false;
  const rawDigits = normalizeDigits(raw);
  return rawDigits.includes(digits) || rawDigits.includes(digits.slice(-9));
}

// fieldInRaw implementation moved to common utilities; using imported function.

function cardSnapshot(card: BusinessCard): Record<string, string> {
  const addr = card.address;
  return {
    firstName: card.firstName ?? '',
    lastName: card.lastName ?? '',
    role: card.role ?? '',
    company: card.company ?? '',
    emails: (card.emails ?? []).join('; '),
    phones: (card.phones ?? []).map((p) => p.number).join('; '),
    website: card.website ?? '',
    address: addr?.full ?? [addr?.street, addr?.postalCode, addr?.city].filter(Boolean).join(', '),
    vatNumber: card.vatNumber ?? '',
    taxCode: card.taxCode ?? '',
  };
}

function deterministicAudit(card: BusinessCard): Issue[] {
  const issues: Issue[] = [];
  const raw = card.rawText ?? '';
  if (!raw.trim()) return issues;

  const storedEmails = (card.emails ?? []).map((e) => e.toLowerCase());
  const rawEmails = extractEmailsFromRaw(raw);

  for (const email of rawEmails) {
    const storedMatch = storedEmails.some(
      (s) => s === email || s.includes(email.split('@')[0] ?? '') || email.includes(s.split('@')[0] ?? '')
    );
    if (!storedMatch) {
      issues.push({
        field: 'emails',
        severity: 'high',
        issue: 'missing',
        stored: storedEmails.join('; ') || '(vuoto)',
        evidence: email,
        explanation: 'Email leggibile nel testo OCR ma non presente nei campi salvati.',
        source: 'deterministic',
      });
    }
  }

  for (const email of storedEmails) {
    if (!rawEmails.some((r) => r === email) && !fieldInRaw(email, raw)) {
      issues.push({
        field: 'emails',
        severity: 'medium',
        issue: 'hallucinated',
        stored: email,
        evidence: '',
        explanation: 'Email salvata ma non chiaramente supportata dal testo OCR.',
        source: 'deterministic',
      });
    }
  }

  const storedPhones = (card.phones ?? []).map((p) => p.number);
  const rawPhoneDigits = extractPhoneDigitStrings(raw);

  if (storedPhones.length === 0 && rawPhoneDigits.length > 0) {
    issues.push({
      field: 'phones',
      severity: 'high',
      issue: 'missing',
      stored: '(vuoto)',
      evidence: rawPhoneDigits[0],
      explanation: 'Numeri di telefono nell\'OCR ma nessun telefono salvato.',
      source: 'deterministic',
    });
  }

  for (const phone of storedPhones) {
    if (!phoneInRaw(phone, raw)) {
      issues.push({
        field: 'phones',
        severity: 'medium',
        issue: 'wrong',
        stored: phone,
        evidence: '',
        explanation: 'Telefono salvato non verificabile nel testo OCR (possibile errore o OCR corrotto).',
        source: 'deterministic',
      });
    }
  }

  const textFields: Array<{ key: keyof ReturnType<typeof cardSnapshot>; label: string }> = [
    { key: 'company', label: 'company' },
    { key: 'firstName', label: 'firstName' },
    { key: 'lastName', label: 'lastName' },
    { key: 'role', label: 'role' },
    { key: 'website', label: 'website' },
    { key: 'vatNumber', label: 'vatNumber' },
    { key: 'taxCode', label: 'taxCode' },
  ];

  const snap = cardSnapshot(card);
  for (const { key, label } of textFields) {
    const value = snap[key];
    if (!value.trim()) continue;
    if (!fieldInRaw(value, raw)) {
      issues.push({
        field: label,
        severity: label === 'company' || label === 'role' ? 'medium' : 'low',
        issue: 'hallucinated',
        stored: value,
        evidence: '',
        explanation: `Campo "${label}" valorizzato ma debolemente supportato dall'OCR grezzo.`,
        source: 'deterministic',
      });
    }
  }

  if (!snap.company.trim()) {
    // Use hasCompanyEvidence to detect company evidence in OCR raw text
    const hasEvidence = hasCompanyEvidence(snap.company, raw, storedEmails);
    if (hasEvidence) {
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      const companyLike = lines.find((l) => /\b(s\.?r\.?l\.?|s\.?p\.?a\.?|gmbh|ltd|inc|sas|snc)\b/i.test(l));
      issues.push({
        field: 'company',
        severity: 'high',
        issue: 'missing',
        stored: '(vuoto)',
        evidence: companyLike ? companyLike.slice(0, 80) : '',
        explanation: "Ragione sociale probabile nell'OCR ma campo azienda vuoto.",
        source: 'deterministic',
      });
    }
  }

  if (!snap.role.trim()) {
    const roleLine = raw
      .split('\n')
      .find((l) =>
        /\b(ceo|cto|manager|director|presidente|direttore|responsabile|consulente|ingegnere|commercial|account)\b/i.test(
          l
        )
      );
    if (roleLine) {
      issues.push({
        field: 'role',
        severity: 'medium',
        issue: 'missing',
        stored: '(vuoto)',
        evidence: roleLine.slice(0, 80),
        explanation: 'Ruolo probabile nell\'OCR ma campo ruolo vuoto.',
        source: 'deterministic',
      });
    }
  }

  return issues;
}

function parserReplayAudit(card: BusinessCard): Issue[] {
  const raw = card.rawText ?? '';
  if (!raw.trim()) return [];

  const pages = pagesFromRawText(raw);
  const replayed = extractCardV5(pages);
  const issues: Issue[] = [];
  const stored = cardSnapshot(card);
  const replaySnap = v5ToSnapshot(replayed);

  for (const key of Object.keys(replaySnap) as Array<keyof typeof replaySnap>) {
    const s = stored[key].trim();
    const r = replaySnap[key].trim();
    if (!r || r === s) continue;
    if (!s && r) {
      issues.push({
        field: key,
        severity: 'medium',
        issue: 'missing',
        stored: '(vuoto)',
        evidence: r,
        explanation: `Il parser v5 attuale estrarrebbe "${r}" dallo stesso OCR, ma il salvato è vuoto.`,
        source: 'parser-replay',
      });
    } else if (s && r && s !== r) {
      issues.push({
        field: key,
        severity: 'low',
        issue: 'wrong',
        stored: s,
        evidence: r,
        explanation: `Parser replay differisce dal salvato (possibile regressione o edit manuale).`,
        source: 'parser-replay',
      });
    }
  }

  return issues;
}

async function callGeminiAudit(
  raw: string,
  stored: Record<string, string>,
  apiKey: string,
  model: string
): Promise<Issue[]> {
  const body = {
    contents: [
      {
        parts: [
          {
            text: `${AUDIT_PROMPT}\n\n=== OCR GREZZO ===\n${raw.slice(0, 12000)}\n\n=== CAMPI SALVATI ===\n${JSON.stringify(stored, null, 2)}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
  const parsed = JSON.parse(text) as Array<Partial<Issue>>;
  return parsed
    .filter((i) => i.field && i.issue)
    .map((i) => ({
      field: String(i.field),
      severity: (i.severity as Issue['severity']) ?? 'medium',
      issue: String(i.issue),
      stored: i.stored,
      evidence: i.evidence,
      explanation: i.explanation,
      source: 'ai-gemini' as const,
    }));
}

async function callSupabaseStructure(
  raw: string,
  env: Record<string, string>
): Promise<Record<string, string> | null> {
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const response = await fetch(`${url}/functions/v1/structure-business-card`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ ocrText: raw.slice(0, 12000) }),
  });

  if (!response.ok) return null;
  const data = (await response.json()) as Record<string, unknown>;
  return {
    firstName: String(data.firstName ?? ''),
    lastName: String(data.lastName ?? ''),
    role: String(data.role ?? ''),
    company: String(data.company ?? ''),
    emails: Array.isArray(data.emails) ? data.emails.join('; ') : '',
    phones: Array.isArray(data.phones)
      ? data.phones.map((p) => (typeof p === 'object' && p && 'number' in p ? String((p as { number?: string }).number ?? '') : '')).filter(Boolean).join('; ')
      : '',
    website: String(data.website ?? ''),
    vatNumber: String(data.vatNumber ?? ''),
    taxCode: String(data.taxCode ?? ''),
  };
}

function supabaseCompareAudit(
  stored: Record<string, string>,
  ai: Record<string, string>
): Issue[] {
  const issues: Issue[] = [];
  for (const key of Object.keys(ai)) {
    const s = stored[key]?.trim() ?? '';
    const a = ai[key]?.trim() ?? '';
    if (!a) continue;
    if (!s) {
      issues.push({
        field: key,
        severity: 'medium',
        issue: 'missing',
        stored: '(vuoto)',
        evidence: a,
        explanation: 'Gemini (structure-business-card) estrarrebbe questo valore dall\'OCR, ma il salvato è vuoto.',
        source: 'ai-supabase',
      });
    } else if (s !== a && !normalizeLoose(s).includes(normalizeLoose(a).slice(0, 8))) {
      issues.push({
        field: key,
        severity: 'low',
        issue: 'wrong',
        stored: s,
        evidence: a,
        explanation: 'Differenza tra salvato e estrazione AI Supabase sullo stesso OCR.',
        source: 'ai-supabase',
      });
    }
  }
  return issues;
}

function loadContactsFromZip(zipPath: string): BusinessCard[] {
  const buf = fs.readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(buf));
  const jsonBytes = entries['contacts.json'];
  if (!jsonBytes) throw new Error(`contacts.json mancante in ${zipPath}`);
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as BusinessCard[];
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const i of issues) {
    const key = `${i.field}|${i.issue}|${i.stored}|${i.evidence}|${i.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

function toCsvRow(values: string[]): string {
  return values.map((v) => `"${v.replace(/"/g, '""')}"`).join(',');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useSupabaseAi = args.includes('--ai-supabase');
  const zipPaths = args.filter((a) => !a.startsWith('--'));

  const defaults = [
    'C:/Users/giova/Downloads/qa-contacts-export-2026-07-09T19-08-34-417Z.zip',
    'C:/Users/giova/Downloads/qa-contacts-export_31_60_2026-07-09T19-23-53-192Z.zip',
    'C:/Users/giova/Downloads/qa-contacts-export_61_90_2026-07-09T19-24-44-101Z.zip',
    'C:/Users/giova/Downloads/qa-contacts-export_91_100_2026-07-09T19-44-11-034Z.zip',
  ];

  const files = (zipPaths.length > 0 ? zipPaths : defaults).filter((p) => fs.existsSync(p));
  if (files.length === 0) {
    console.error('Nessun file ZIP trovato. Passa i path come argomenti.');
    process.exit(1);
  }

  const env = loadEnvFile();
  const geminiKey = env.EXPO_PUBLIC_GEMINI_API_KEY || process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
  const geminiModel = env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash';
  const useGemini = Boolean(geminiKey);

  const allAudits: ContactAudit[] = [];
  let index = 0;

  for (const zipPath of files) {
    const contacts = loadContactsFromZip(zipPath);
    console.log(`\n📦 ${path.basename(zipPath)} — ${contacts.length} contatti`);

    for (const card of contacts) {
      index++;
      const stored = cardSnapshot(card);
      let issues = [...deterministicAudit(card), ...parserReplayAudit(card)];

      if (useGemini && card.rawText?.trim()) {
        try {
          const aiIssues = await callGeminiAudit(card.rawText, stored, geminiKey, geminiModel);
          issues.push(...aiIssues);
          await sleep(400);
        } catch (error) {
          console.warn(`  AI skip ${card.id}:`, error instanceof Error ? error.message : error);
        }
      } else if (useSupabaseAi && card.rawText?.trim()) {
        const ai = await callSupabaseStructure(card.rawText, env);
        if (ai) issues.push(...supabaseCompareAudit(stored, ai));
        await sleep(300);
      }

      issues = dedupeIssues(issues);
      allAudits.push({
        id: card.id,
        title: card.title ?? card.company ?? card.id,
        rawTextLength: card.rawText?.length ?? 0,
        issues,
      });

      if (issues.length > 0) {
        console.log(`  [${index}] ${(card.title ?? '?').slice(0, 40)} — ${issues.length} issue`);
      }
    }
  }

  const outDir = path.join(process.cwd(), 'qa-audit-report');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const reportPath = path.join(outDir, `audit-report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(allAudits, null, 2), 'utf8');

  const csvPath = path.join(outDir, `audit-summary-${stamp}.csv`);
  const csvLines = [
    toCsvRow(['id', 'title', 'field', 'severity', 'issue', 'stored', 'evidence', 'explanation', 'source']),
  ];
  for (const c of allAudits) {
    for (const i of c.issues) {
      csvLines.push(
        toCsvRow([
          c.id,
          c.title,
          i.field,
          i.severity,
          i.issue,
          i.stored ?? '',
          i.evidence ?? '',
          i.explanation ?? '',
          i.source,
        ])
      );
    }
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
// Copy generated CSV to scripts/qa folder for bulk comparison tools
const qaErrorsDir = path.join(__dirname, 'qa');
if (!fs.existsSync(qaErrorsDir)) {
  fs.mkdirSync(qaErrorsDir, { recursive: true });
}
const qaErrorsPath = path.join(qaErrorsDir, 'business-scanner-qa-errors.csv');
try {
  fs.copyFileSync(csvPath, qaErrorsPath);
} catch (e) {
  console.warn('Unable to copy QA errors CSV:', e);
}

  const high = allAudits.reduce((n, c) => n + c.issues.filter((i) => i.severity === 'high').length, 0);
  const medium = allAudits.reduce((n, c) => n + c.issues.filter((i) => i.severity === 'medium').length, 0);
  const withIssues = allAudits.filter((c) => c.issues.length > 0).length;

  const summaryPath = path.join(outDir, `audit-summary-${stamp}.txt`);
  const summary = [
    `Audit QA export — ${allAudits.length} contatti`,
    `Contatti con almeno 1 issue: ${withIssues}`,
    `Issue high: ${high} | medium: ${medium}`,
    `AI Gemini: ${useGemini ? 'sì' : 'no (imposta EXPO_PUBLIC_GEMINI_API_KEY in .env)'}`,
    `AI Supabase: ${useSupabaseAi ? 'sì' : 'no (usa --ai-supabase)'}`,
    '',
    'Top problemi per campo:',
    ...Object.entries(
      allAudits
        .flatMap((c) => c.issues)
        .reduce<Record<string, number>>((acc, i) => {
          acc[i.field] = (acc[i.field] ?? 0) + 1;
          return acc;
        }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .map(([field, count]) => `  - ${field}: ${count}`),
    '',
    `Report: ${reportPath}`,
    `CSV: ${csvPath}`,
  ].join('\n');
  fs.writeFileSync(summaryPath, summary, 'utf8');

  console.log('\n' + summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
