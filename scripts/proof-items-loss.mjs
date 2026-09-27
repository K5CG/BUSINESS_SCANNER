/**
 * Dimostra offline dove spariscono le 10 righe della seconda passata,
 * usando la risposta già catturata dalla sonda (nessun nuovo credito).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Carica le funzioni via test runner path ricostruendo il contratto a mano:
// stessa logica di flatItems / diagnoseFlatItemRejection.
const body = JSON.parse(readFileSync('.tmp-qa/parse-pdf-response.json', 'utf8'));
const rawItems = body.rawFields?.items;
const flat = Array.isArray(body.items) ? body.items : [];
const structuredItems = body.structured?.items;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function looksLikeStructuredScalar(value) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'value');
}
function diagnose(item) {
  if (!isRecord(item)) return 'notObject';
  const keys = ['description', 'quantity', 'unitPrice', 'total', 'lineTotal'];
  let wrapped = 0;
  let flatCount = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const value = item[key];
    if (looksLikeStructuredScalar(value)) wrapped += 1;
    else if (
      (key === 'description' && typeof value === 'string') ||
      (key !== 'description' && typeof value === 'number')
    ) {
      flatCount += 1;
    }
  }
  if (wrapped > 0 && flatCount === 0) return 'structuredWrappersInTopLevelItem';
  if (flatCount === 0) return 'noUsableFlatScalars';
  return 'unknown';
}

const reasons = {};
for (const item of rawItems ?? []) {
  const reason = diagnose(item);
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

const first = rawItems?.[0];
const last = rawItems?.[rawItems.length - 1];
const rawJson = JSON.stringify(rawItems);

console.log(
  JSON.stringify(
    {
      PROVIDER_RESPONSE: {
        itemsArrayPresent: Array.isArray(rawItems),
        itemsArrayLength: Array.isArray(rawItems) ? rawItems.length : null,
        firstItemKeys: first ? Object.keys(first) : null,
        lastItemKeys: last ? Object.keys(last) : null,
        firstDescriptionType: first ? typeof first.description : null,
        firstDescriptionHasValueWrapper: !!(
          first &&
          looksLikeStructuredScalar(first.description)
        ),
        rawItemsJsonLength: rawJson.length,
      },
      AFTER_PARSE: {
        itemsBeforeNormalization: Array.isArray(rawItems) ? rawItems.length : 0,
        itemsAfterNormalization: flat.length,
        structuredItemsCount: Array.isArray(structuredItems)
          ? structuredItems.length
          : 0,
        rejectedItems: (Array.isArray(rawItems) ? rawItems.length : 0) - flat.length,
        rejectionReasons: reasons,
      },
      AFTER_MERGE: {
        summaryItems: 0,
        itemsPassItems: flat.length,
        mergedItems: flat.length,
        note: 'merge copies items.items only; rawItems survive in rawFields but stage snapshot counts extract.items',
      },
      CONTRACT_MISMATCH: {
        promptTopLevelExample: 'flat scalars: description/quantity/unitPrice/total',
        promptAlsoAsks: 'structured.items with {value,pageIndex,evidenceText,...}',
        modelActuallyReturned: 'top-level items[] with structured wrappers, no structured.items',
        parserExpects: 'flatItems() string/number scalars OR structured.items array',
        lossLayer: 'AFTER_PARSE / flatItems()',
      },
    },
    null,
    2
  )
);
