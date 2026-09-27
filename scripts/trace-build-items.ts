import { readFileSync } from 'node:fs';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import { normalizeGeminiDocumentExtract } from '../lib/gemini-document-extract';
import { hardenPdfExtract } from '../lib/pdf-party-subject';
import { reliabilityFromCloudExtract } from '../lib/document-page-extraction';
import type { QuoteDocument } from '../types';

const body = JSON.parse(readFileSync('.tmp-qa/parse-pdf-response.json', 'utf8'));
const normalized = normalizeGeminiDocumentExtract(body);
if (!normalized) throw new Error('normalize failed');
const hardened = hardenPdfExtract(normalized);
const cloud = reliabilityFromCloudExtract(hardened);
const rawItems = hardened.rawFields?.items;
const firstRaw = Array.isArray(rawItems) ? rawItems[0] : null;
console.log(
  JSON.stringify(
    {
      geminiItems: normalized.items?.length ?? 0,
      firstNormalizedKeys: Object.keys(hardened.items?.[0] ?? {}),
      firstNormalizedTypes: Object.fromEntries(
        Object.entries(hardened.items?.[0] ?? {}).map(([k, v]) => [k, typeof v])
      ),
      rawFieldsItemsCount: Array.isArray(rawItems) ? rawItems.length : null,
      firstRawDescriptionType:
        firstRaw && typeof firstRaw === 'object' && !Array.isArray(firstRaw)
          ? typeof (firstRaw as { description?: unknown }).description
          : null,
      cloudItemsStatus: cloud.items?.validationStatus,
      cloudItemsReasons: cloud.items?.validationReasons,
      cloudValueLen: Array.isArray(cloud.items?.value)
        ? cloud.items.value.length
        : null,
    },
    null,
    2
  )
);

const built = buildDocumentFromExtract('quote', hardened) as QuoteDocument;
console.log(
  JSON.stringify(
    {
      builtItems: built.items?.length ?? 0,
      itemsReliability: built.fieldReliability?.items
        ? {
            validationStatus: built.fieldReliability.items.validationStatus,
            conflict: built.fieldReliability.items.conflict ?? false,
            reasons: built.fieldReliability.items.validationReasons,
            valueLen: Array.isArray(built.fieldReliability.items.value)
              ? built.fieldReliability.items.value.length
              : null,
          }
        : null,
    },
    null,
    2
  )
);
