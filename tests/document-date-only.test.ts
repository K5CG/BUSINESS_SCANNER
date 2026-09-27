import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuoteDocument } from '../types';
import type { GeminiDocumentExtract } from '../lib/gemini-document-extract';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import {
  documentDateFromStored,
  documentDateOnlyText,
  withDocumentDateOnlyFields,
} from '../lib/document-date-only';
import { documentStageSnapshot } from '../lib/pdf-stage-trace';

/** Fusi a est e a ovest di Greenwich: la mezzanotte locale cade in due giorni UTC diversi. */
const TIMEZONES = ['Europe/Rome', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const DAYS = ['2025-02-06', '2025-01-01', '2025-12-31'];

function inTimezone<T>(timezone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function quoteFromDate(day: string): QuoteDocument {
  const extract = {
    rawText: ['Preventivo n. 1', `Date ${day}`, 'Totale 10,00 EUR'].join('\n'),
    documentNumber: '1',
    date: day,
  } as unknown as GeminiDocumentExtract;
  return buildDocumentFromExtract('quote', extract) as QuoteDocument;
}

test('il giorno del documento non cambia con il fuso del telefono', () => {
  for (const timezone of TIMEZONES) {
    for (const day of DAYS) {
      inTimezone(timezone, () => {
        const document = quoteFromDate(day);
        assert.equal(
          documentDateOnlyText(document.quoteDate),
          day,
          `${timezone} ${day}`
        );
      });
    }
  }
});

test('il tracciato mostra il giorno scritto sul documento in ogni fuso', () => {
  for (const timezone of TIMEZONES) {
    for (const day of DAYS) {
      inTimezone(timezone, () => {
        assert.equal(
          documentStageSnapshot(quoteFromDate(day)).date,
          day,
          `${timezone} ${day}`
        );
      });
    }
  }
});

test('salvataggio e rilettura conservano il giorno anche cambiando fuso', () => {
  for (const day of DAYS) {
    const stored = inTimezone('Europe/Rome', () => {
      const document = quoteFromDate(day);
      const payload = withDocumentDateOnlyFields(
        document as unknown as Record<string, unknown>
      );
      return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    });
    assert.equal(stored.quoteDate, day);

    for (const timezone of TIMEZONES) {
      inTimezone(timezone, () => {
        const revived = documentDateFromStored(stored.quoteDate);
        assert.equal(documentDateOnlyText(revived), day, `${timezone} ${day}`);
      });
    }
  }
});

test('un istante salvato dalle versioni precedenti resta leggibile', () => {
  inTimezone('Europe/Rome', () => {
    const revived = documentDateFromStored('2025-02-05T23:00:00.000Z');
    assert.equal(documentDateOnlyText(revived), '2025-02-06');
  });
});

test('i campi non temporali restano intatti nel salvataggio', () => {
  const payload = withDocumentDateOnlyFields({
    quoteDate: new Date(2025, 1, 6),
    customerName: 'CIRA SCpA',
    total: 3250,
    createdAt: new Date('2025-02-06T09:30:00.000Z'),
  });
  assert.equal(payload.quoteDate, '2025-02-06');
  assert.equal(payload.customerName, 'CIRA SCpA');
  assert.equal(payload.total, 3250);
  assert.ok(payload.createdAt instanceof Date);
});
