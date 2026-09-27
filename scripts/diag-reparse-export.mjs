#!/usr/bin/env node
/** Estende diag-reparse con parser version stamp */
import fs from 'node:fs';
import path from 'node:path';
import { parseCardFromPages } from '../lib/parser.ts';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { extractCardV5 } from '../lib/parser-v5/engine.ts';

export const PARSER_BUILD_ID = 'v5-iter3-2026-07-12';

const exportDir = process.argv[2] ?? 'scripts/.diag-export-1800/new';
const contacts = JSON.parse(fs.readFileSync(path.join(exportDir, 'contacts.json'), 'utf8'));

const targets = contacts.filter((c) =>
  /Gavasso|Renga|Tuglak|Ponzoni|Bandolin|Gaboard|Kearins|Maxicarta|Potonio|Orienta|Teghnigal|Lain|Dolphin|MIP|Domofacile|ICM/i.test(
    `${c.title} ${c.company} ${c.lastName} ${c.firstName}`
  )
);

console.log('PARSER_BUILD_ID', PARSER_BUILD_ID);
console.log('targets', targets.length);

for (const c of targets) {
  if (!c.rawText?.trim()) continue;
  const pages = pagesFromRawText(c.rawText);
  const parsed = parseCardFromPages(pages);
  const v5 = extractCardV5(
    pages.map((p, page) => ({
      page,
      rawText: p.rawText,
      lines: p.lines.map((l, indexInPage) => ({
        id: indexInPage,
        text: l.text,
        page,
        indexInPage,
        bbox: l.boundingBox ?? { x: 0, y: indexInPage * 22, width: 100, height: 20 },
        confidence: l.confidence ?? 0.75,
      })),
    }))
  );
  const changed =
    (c.company ?? '') !== (parsed.company ?? '') ||
    (c.firstName ?? '') !== (parsed.firstName ?? '') ||
    (c.lastName ?? '') !== (parsed.lastName ?? '') ||
    (c.address?.full ?? '') !== (parsed.address?.full ?? '');

  console.log('\n' + (changed ? 'WOULD_CHANGE' : 'UNCHANGED'), '|', c.title);
  console.log('  export   ', c.firstName, c.lastName, '| co:', c.company, '| addr:', c.address?.full ?? '');
  console.log('  reparse  ', parsed.firstName, parsed.lastName, '| co:', parsed.company, '| addr:', parsed.address?.full ?? '');
  console.log('  updatedAt', c.updatedAt);
}
