/**
 * Document corpus certification runner (CURRENT HEAD replay).
 * Uses exported OCR/layout from qa-export-2026-08-08-real-full.
 * Does NOT invent ground truth — expectations come from repo-audited values.
 *
 * Usage:
 *   npx tsx scripts/run-document-corpus-certification.ts
 *   npx tsx scripts/run-document-corpus-certification.ts --out .tmp-qa/corpus-cert-baseline.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { InvoiceDocument, OrderDocument, QuoteDocument } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import type { StructuredDocumentType } from '../lib/document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocumentAsync,
} from '../lib/document-structured-extraction';
import { createScanProcessDeadline } from '../lib/scan-process-deadline';

type QaDoc = QuoteDocument | OrderDocument | InvoiceDocument;

type FieldKey =
  | 'documentNumber'
  | 'date'
  | 'issuer'
  | 'customer'
  | 'itemCount'
  | 'subtotal'
  | 'vat'
  | 'total'
  | 'currency'
  | 'pages';

interface FieldExpectation {
  key: FieldKey;
  expected: string | number | RegExp;
  critical: boolean;
}

interface DocExpectation {
  name: string;
  idPrefix: string;
  language: 'IT' | 'EN' | 'FR' | 'DE' | 'ES' | 'MIXED';
  type: 'quote' | 'order' | 'invoice';
  fields: FieldExpectation[];
  notes?: string;
}

/** Canonical ACTIVE certification set — values from repo evidence only. */
export const CERT_DOCS: DocExpectation[] = [
  {
    name: 'Tecnoforniture Alpina',
    idPrefix: 'b82a4053',
    language: 'IT',
    type: 'quote',
    fields: [
      { key: 'documentNumber', expected: 'PV/2025/0478', critical: true },
      { key: 'customer', expected: /Officine Maraldi/i, critical: true },
      { key: 'itemCount', expected: 6, critical: true },
      { key: 'subtotal', expected: 461.08, critical: true },
      { key: 'vat', expected: 79.78, critical: true },
      { key: 'total', expected: 540.86, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
  },
  {
    name: 'Motorparts Delta',
    idPrefix: 'a13fa9a4',
    language: 'IT',
    type: 'order',
    fields: [
      { key: 'documentNumber', expected: /2025\/0874/i, critical: true },
      { key: 'customer', expected: /Autofficina Chiozza/i, critical: true },
      { key: 'itemCount', expected: 6, critical: true },
      { key: 'subtotal', expected: 608.46, critical: true },
      { key: 'vat', expected: 133.86, critical: true },
      { key: 'total', expected: 742.32, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
    notes: 'Shipping as priced commercial row if present in table (asserted via itemCount=6).',
  },
  {
    name: 'Künzi',
    idPrefix: 'ee347e43',
    language: 'IT',
    type: 'order',
    fields: [
      { key: 'documentNumber', expected: /2026002581/i, critical: true },
      { key: 'issuer', expected: /K[ÜU]NZI/i, critical: true },
      { key: 'customer', expected: /Associazione Amici Trafoi|Amici Trafoi/i, critical: true },
      { key: 'itemCount', expected: 4, critical: true },
      { key: 'subtotal', expected: 557.95, critical: true },
      { key: 'vat', expected: 122.75, critical: true },
      { key: 'total', expected: 680.7, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
    notes: 'CO17406 / shipping 15.00 present in OCR; date 27/03/2026 NOT_ASSERTED here (format variance).',
  },
  {
    name: 'Northbridge Lab Systems',
    idPrefix: '28ff5440',
    language: 'EN',
    type: 'quote',
    fields: [
      // Repo OCR evidence: OTN-26-0527 (not synthetic QTN-24 / user OTN-24).
      { key: 'documentNumber', expected: /OTN-26-0527/i, critical: true },
      { key: 'itemCount', expected: 5, critical: true },
      { key: 'subtotal', expected: 22717.5, critical: true },
      { key: 'vat', expected: 4543.5, critical: true },
      { key: 'total', expected: 27261, critical: true },
      { key: 'currency', expected: 'GBP', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
  },
  {
    name: 'Medisupply Horizon',
    idPrefix: '2adb6bb0',
    language: 'EN',
    type: 'invoice',
    fields: [
      { key: 'documentNumber', expected: 'INV-2025-05678', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
    notes: 'Financial triplet / item count NOT_ASSERTED in audited repo sources for FULL PASS.',
  },
  {
    name: 'Rheinwerk Automation',
    idPrefix: '960e93ce',
    language: 'DE',
    type: 'invoice',
    fields: [
      { key: 'documentNumber', expected: /AN-2025-0457/i, critical: true },
      { key: 'itemCount', expected: 5, critical: true },
      { key: 'subtotal', expected: 1783.5, critical: true },
      { key: 'vat', expected: 338.87, critical: true },
      { key: 'total', expected: 2122.37, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
  },
  {
    name: 'Atelier Bureau Concept',
    idPrefix: '9cb5aef5',
    language: 'FR',
    type: 'quote',
    fields: [{ key: 'pages', expected: 1, critical: true }],
    notes: 'Full financials NOT_ASSERTED — landscape 180° risk; insufficient audited triplet.',
  },
  {
    name: 'ThermoFlux Industrie SAS',
    idPrefix: '21359f33',
    language: 'FR',
    type: 'quote',
    fields: [
      { key: 'documentNumber', expected: 'DEV-2025-0612', critical: true },
      { key: 'customer', expected: /Domaine Viticole/i, critical: true },
      { key: 'itemCount', expected: 17, critical: true },
      { key: 'subtotal', expected: 39649, critical: true },
      { key: 'vat', expected: 7929.8, critical: true },
      { key: 'total', expected: 47578.8, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 2, critical: true },
    ],
  },
  {
    name: 'EnerSoluciones Levante',
    idPrefix: '7b8fc549',
    language: 'ES',
    type: 'quote',
    fields: [
      { key: 'documentNumber', expected: /PRES-2025[-.]0478/i, critical: true },
      { key: 'itemCount', expected: 7, critical: true },
      { key: 'subtotal', expected: 9090, critical: true },
      { key: 'vat', expected: 1908.9, critical: true },
      { key: 'total', expected: 10998.9, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
  },
  {
    name: 'Global Food Machinery',
    idPrefix: 'f7938d5e',
    language: 'MIXED',
    type: 'order',
    fields: [
      { key: 'documentNumber', expected: 'OC-2025-0547', critical: true },
      { key: 'itemCount', expected: 6, critical: true },
      { key: 'total', expected: 206790, critical: true },
      { key: 'vat', expected: 37290, critical: true },
      { key: 'currency', expected: 'EUR', critical: true },
      { key: 'pages', expected: 1, critical: true },
    ],
    notes: 'OCR shows 5 supply/service lines + priced transport (bilingual duplicate collapsed to 1).',
  },
];

function loadDocs(): QaDoc[] {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'test-data/qa-export-2026-08-08-real-full/documents.json'),
      'utf8'
    )
  ) as QaDoc[];
}

function layoutInputs(doc: QaDoc): DocumentLayoutPageInput[] {
  return (doc.structuredExtraction?.pages ?? []).map((page) => ({
    pageIndex: page.pageIndex,
    lines: page.lines.map((line) => ({
      text: line.text,
      confidence: 0.9,
      ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
      ...(line.elements ? { elements: line.elements } : {}),
    })),
    rawText: page.lines.map((line) => line.text).join('\n'),
    width: page.width,
    height: page.height,
  }));
}

function docNumber(doc: QaDoc): string | undefined {
  if (doc.type === 'quote') return doc.quoteNumber;
  if (doc.type === 'order') return doc.orderNumber;
  return doc.invoiceNumber;
}

function numEq(actual: unknown, expected: number): boolean {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= 0.02;
}

function matchValue(actual: unknown, expected: string | number | RegExp): boolean {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (typeof expected === 'number') return numEq(actual, expected);
  return String(actual ?? '') === expected;
}

function actualFor(
  key: FieldKey,
  applied: QaDoc,
  extraction: Awaited<ReturnType<typeof extractStructuredDocumentAsync>>,
  pageCount: number
): unknown {
  switch (key) {
    case 'documentNumber':
      return docNumber(applied);
    case 'date':
      return applied.date;
    case 'issuer':
      return extraction.issuer?.name?.normalizedValue ?? extraction.issuer?.name?.rawValue;
    case 'customer':
      return applied.customerName;
    case 'itemCount':
      return applied.items?.length ?? 0;
    case 'subtotal':
      return applied.subtotal;
    case 'vat':
      return applied.vatAmount;
    case 'total':
      return applied.total;
    case 'currency':
      return applied.currency;
    case 'pages':
      return pageCount;
  }
}

async function evaluateOne(spec: DocExpectation, docs: QaDoc[]) {
  const doc = docs.find((entry) => entry.id.startsWith(spec.idPrefix));
  if (!doc) {
    return {
      name: spec.name,
      idPrefix: spec.idPrefix,
      classification: 'NOT_ASSERTABLE' as const,
      error: 'fixture_missing',
    };
  }
  const inputs = layoutInputs(doc);
  const processDeadline = createScanProcessDeadline(inputs.length);
  const started = Date.now();
  const extraction = await extractStructuredDocumentAsync(doc.type as StructuredDocumentType, inputs, {
    processDeadline,
  });
  const elapsedMs = Date.now() - started;
  const applied = applyStructuredExtractionToDocument(
    { ...doc, items: doc.items ?? [] },
    extraction,
    { mode: 'new_scan' }
  ) as QaDoc;

  const fieldResults = spec.fields.map((field) => {
    const actual = actualFor(field.key, applied, extraction, inputs.length);
    const ok = matchValue(actual, field.expected);
    return {
      key: field.key,
      critical: field.critical,
      expected: String(field.expected),
      actual: actual === undefined || actual === null ? null : actual,
      ok,
    };
  });

  const asserted = fieldResults.length;
  const critical = fieldResults.filter((f) => f.critical);
  const criticalOk = critical.filter((f) => f.ok).length;
  const allOk = fieldResults.every((f) => f.ok);
  const anyCriticalFail = critical.some((f) => !f.ok);

  let classification: 'FULL_PASS' | 'PARTIAL_PASS' | 'FAIL' | 'NOT_ASSERTABLE';
  if (asserted === 0) classification = 'NOT_ASSERTABLE';
  else if (allOk) classification = 'FULL_PASS';
  else if (anyCriticalFail && criticalOk === 0) classification = 'FAIL';
  else if (anyCriticalFail) classification = 'FAIL';
  else classification = 'PARTIAL_PASS';

  // Thin expectations (number/pages only) must not inflate FULL_PASS for release.
  const hasFinancialAssert = spec.fields.some((f) => f.key === 'subtotal' || f.key === 'vat' || f.key === 'total');
  const hasItemAssert = spec.fields.some((f) => f.key === 'itemCount');
  if (classification === 'FULL_PASS' && !hasFinancialAssert && !hasItemAssert) {
    classification = 'NOT_ASSERTABLE';
  }
  if (asserted <= 1 && classification === 'FULL_PASS') {
    classification = 'NOT_ASSERTABLE';
  }

  return {
    name: spec.name,
    idPrefix: spec.idPrefix,
    language: spec.language,
    type: spec.type,
    classification,
    elapsedMs,
    pages: inputs.length,
    itemCount: applied.items?.length ?? 0,
    documentNumber: docNumber(applied) ?? null,
    customerName: applied.customerName ?? null,
    issuer: extraction.issuer?.name?.normalizedValue ?? null,
    subtotal: applied.subtotal ?? null,
    vatAmount: applied.vatAmount ?? null,
    total: applied.total ?? null,
    currency: applied.currency ?? null,
    complete: extraction.complete,
    requiresReview: extraction.requiresReview,
    fieldResults,
    criticalOk,
    criticalTotal: critical.length,
    notes: spec.notes ?? null,
  };
}

function summarize(results: Awaited<ReturnType<typeof evaluateOne>>[]) {
  const scored = results.filter((r) => r.classification !== 'NOT_ASSERTABLE' && !('error' in r && r.error));
  const fullPass = scored.filter((r) => r.classification === 'FULL_PASS').length;
  let criticalOk = 0;
  let criticalTotal = 0;
  let financialOk = 0;
  let financialTotal = 0;
  let itemOk = 0;
  let itemTotal = 0;
  let metaOk = 0;
  let metaTotal = 0;

  for (const r of results) {
    if (!('fieldResults' in r) || !r.fieldResults) continue;
    for (const f of r.fieldResults) {
      if (f.critical) {
        criticalTotal += 1;
        if (f.ok) criticalOk += 1;
      }
      if (f.key === 'subtotal' || f.key === 'vat' || f.key === 'total') {
        financialTotal += 1;
        if (f.ok) financialOk += 1;
      }
      if (f.key === 'itemCount') {
        itemTotal += 1;
        if (f.ok) itemOk += 1;
      }
      if (
        f.key === 'documentNumber' ||
        f.key === 'issuer' ||
        f.key === 'customer' ||
        f.key === 'date' ||
        f.key === 'currency' ||
        f.key === 'pages'
      ) {
        metaTotal += 1;
        if (f.ok) metaOk += 1;
      }
    }
  }

  const byLang: Record<string, { full: number; scored: number }> = {};
  for (const r of scored) {
    const lang = String((r as { language?: string }).language ?? '?');
    byLang[lang] ??= { full: 0, scored: 0 };
    byLang[lang].scored += 1;
    if (r.classification === 'FULL_PASS') byLang[lang].full += 1;
  }

  const pct = (n: number, d: number) => (d === 0 ? null : Number(((100 * n) / d).toFixed(2)));

  return {
    activeCorpusSize: CERT_DOCS.length,
    scoredDocuments: scored.length,
    fullPass: { count: fullPass, of: scored.length, pct: pct(fullPass, scored.length) },
    criticalFields: { ok: criticalOk, of: criticalTotal, pct: pct(criticalOk, criticalTotal) },
    financialFields: { ok: financialOk, of: financialTotal, pct: pct(financialOk, financialTotal) },
    itemCountFields: { ok: itemOk, of: itemTotal, pct: pct(itemOk, itemTotal) },
    metadataFields: { ok: metaOk, of: metaTotal, pct: pct(metaOk, metaTotal) },
    byLanguage: byLang,
    failing: results
      .filter((r) => r.classification === 'FAIL' || r.classification === 'PARTIAL_PASS')
      .map((r) => ({
        name: r.name,
        classification: r.classification,
        mismatches:
          'fieldResults' in r && r.fieldResults
            ? r.fieldResults.filter((f) => !f.ok).map((f) => ({
                key: f.key,
                expected: f.expected,
                actual: f.actual,
              }))
            : [],
      })),
  };
}

async function main() {
  const docs = loadDocs();
  const results = [];
  for (const spec of CERT_DOCS) {
    const row = await evaluateOne(spec, docs);
    results.push(row);
    console.log(
      JSON.stringify({
        name: row.name,
        classification: row.classification,
        critical:
          'criticalOk' in row ? `${row.criticalOk}/${row.criticalTotal}` : null,
        items: 'itemCount' in row ? row.itemCount : null,
        total: 'total' in row ? row.total : null,
        number: 'documentNumber' in row ? row.documentNumber : null,
        ms: 'elapsedMs' in row ? row.elapsedMs : null,
      })
    );
  }
  const summary = summarize(results);
  const out = {
    headHint: 'run under current working tree',
    corpus: 'test-data/qa-export-2026-08-08-real-full',
    evidenceClass: 'REPLAY_PARSER',
    generatedAt: new Date().toISOString(),
    summary,
    results,
  };
  const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6)
    ?? (process.argv.includes('--out')
      ? process.argv[process.argv.indexOf('--out') + 1]
      : null);
  if (outArg) {
    fs.mkdirSync(path.dirname(outArg), { recursive: true });
    fs.writeFileSync(outArg, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ wrote: outArg, summary }, null, 2));
  } else {
    console.log(JSON.stringify({ summary }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
