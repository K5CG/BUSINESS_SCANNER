/**
 * Simula rielaborazione con quality gate: export v2 (baseline) vs parser corrente.
 * node scripts/simulate-reparse-gate.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts/qa-import/export-2026-07-13-v2/contacts.json');

async function main() {
  const { parseCardFromPages } = await import('../lib/parser.ts');
  const { pagesFromRawText } = await import('../lib/extraction-review.ts');
  const { mergeReparseWithQualityGate } = await import('../lib/reparse-quality-gate.ts');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  let wouldChange = 0;
  let blocked = 0;
  let accepted = 0;
  const blockedRows = [];
  const acceptedRows = [];

  for (const card of baseline) {
    if (!card.rawText?.trim()) continue;
    const pages = pagesFromRawText(card.rawText);
    const parsed = parseCardFromPages(pages);
    const candidate = {
      ...card,
      firstName: parsed.firstName ?? '',
      lastName: parsed.lastName ?? '',
      role: parsed.role ?? '',
      company: parsed.company ?? '',
      emails: parsed.emails ?? [],
      phones: parsed.phones ?? [],
      website: parsed.website,
      address: parsed.address,
      vatNumber: parsed.vatNumber,
      taxCode: parsed.taxCode,
    };
    const { card: next, decisions } = mergeReparseWithQualityGate(card, candidate);
    const fieldBlocked = decisions.filter((d) => d.decision === 'keep_old' && d.oldValue !== d.newValue);
    const fieldAccepted = decisions.filter((d) => d.decision === 'accept' && d.oldValue !== d.newValue);

    if (fieldBlocked.length) {
      blocked += fieldBlocked.length;
      if (blockedRows.length < 40) {
        blockedRows.push({
          title: card.title,
          blocks: fieldBlocked.map((d) => ({
            field: d.field,
            old: d.oldValue,
            rejected: d.newValue,
            reasons: d.reasons,
          })),
        });
      }
    }
    if (fieldAccepted.length) {
      accepted += fieldAccepted.length;
      if (acceptedRows.length < 40) {
        acceptedRows.push({
          title: card.title,
          changes: fieldAccepted.map((d) => ({
            field: d.field,
            from: d.oldValue,
            to: d.newValue,
          })),
        });
      }
    }
    if (JSON.stringify(card) !== JSON.stringify(next)) wouldChange += 1;
  }

  const report = {
    baseline: baseline.length,
    wouldChangeContacts: wouldChange,
    fieldsBlocked: blocked,
    fieldsAccepted: accepted,
    blockedSamples: blockedRows,
    acceptedSamples: acceptedRows,
  };

  const out = join(root, 'scripts/qa-import/export-2026-07-13-v2/simulate-reparse-gate-iter11.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Simulazione gate su ${baseline.length} contatti (baseline v2)`);
  console.log(`Contatti che cambierebbero: ${wouldChange}`);
  console.log(`Campi accettati: ${accepted}`);
  console.log(`Campi bloccati (regressioni): ${blocked}`);
  console.log(`Report: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
