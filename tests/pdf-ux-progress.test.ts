import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { DocumentProcessProgress } from '../lib/document-process-progress';
import {
  PDF_AI_WAIT_CEILING,
  createPdfImportProgressReporter,
  logPdfProgressChange,
  nextAiWaitPercent,
  pdfStageProgress,
  resetPdfProgressDiagnostics,
  setPdfProgressMonotonic,
  type PdfImportStage,
} from '../lib/pdf-import-progress';
import {
  geminiModalActionsStacked,
  geminiModalConfirmKey,
} from '../lib/gemini-modal-actions';

function locale(file: 'it.json' | 'en.json'): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'i18n', file), 'utf8')
  ) as Record<string, string>;
}

function record(scheduler?: Parameters<typeof createPdfImportProgressReporter>[1]): {
  events: DocumentProcessProgress[];
  reporter: ReturnType<typeof createPdfImportProgressReporter>;
} {
  const events: DocumentProcessProgress[] = [];
  const reporter = createPdfImportProgressReporter(
    (progress) => events.push(progress),
    scheduler
  );
  return { events, reporter };
}

function manualScheduler() {
  const queue: Array<() => void> = [];
  const cleared: unknown[] = [];
  let nextId = 1;
  const handles = new Map<number, () => void>();
  return {
    queue,
    cleared,
    api: {
      setTimeoutFn: (handler: () => void) => {
        const id = nextId++;
        handles.set(id, handler);
        queue.push(() => {
          if (!handles.has(id)) return;
          handles.delete(id);
          handler();
        });
        return id;
      },
      clearTimeoutFn: (handle: unknown) => {
        cleared.push(handle);
        handles.delete(handle as number);
      },
      randomFn: () => 0,
    },
    flushOne() {
      const tick = queue.shift();
      assert.ok(tick, 'expected a pending AI wait tick');
      tick();
    },
    flushAll() {
      while (queue.length > 0) this.flushOne();
    },
  };
}

test('la conferma PDF chiede di selezionare il file', () => {
  assert.equal(geminiModalConfirmKey('pdf'), 'geminiModalSelectPdfButton');
  assert.equal(locale('it.json').geminiModalSelectPdfButton, 'Seleziona PDF');
  assert.equal(locale('en.json').geminiModalSelectPdfButton, 'Select PDF');
});

test('gli altri percorsi AI mantengono la conferma di invio', () => {
  assert.equal(geminiModalConfirmKey('text'), 'geminiModalSendButton');
  assert.equal(geminiModalConfirmKey('images'), 'geminiModalSendButton');
  assert.equal(locale('it.json').geminiModalSendButton, "Supporto AI");
  assert.equal(locale('en.json').geminiModalSendButton, "AI support");
});

test('le azioni del PDF restano su una riga anche su schermi stretti', () => {
  assert.equal(geminiModalActionsStacked('pdf', true), false);
  assert.equal(geminiModalActionsStacked('pdf', false), false);
  assert.equal(geminiModalActionsStacked('images', true), true);
  assert.equal(geminiModalActionsStacked('text', true), true);
});

test('le etichette dei pulsanti restano su una riga sola', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'components', 'GeminiConfirmationModal.tsx'),
    'utf8'
  );
  const cancelLabels = source.match(/styles\.cancelText\} numberOfLines=\{1\}/g) ?? [];
  const confirmLabels = source.match(/styles\.confirmText\} numberOfLines=\{confirmMaxLines\}/g) ?? [];
  assert.equal(cancelLabels.length, 2);
  assert.equal(confirmLabels.length, 2);
});

test('la barra si muove appena inizia l elaborazione', () => {
  const { events, reporter } = record();
  reporter.stage('prepare');
  assert.equal(events.length, 1);
  assert.ok(events[0].percent > 0, `percent=${events[0].percent}`);
  assert.equal(events[0].percent, 10);
  assert.equal(events[0].messageKey, 'processing.pdfPrepare');
});

test('i traguardi PDF seguono le percentuali realistiche', () => {
  assert.equal(pdfStageProgress('prepare').percent, 10);
  assert.equal(pdfStageProgress('read').percent, 20);
  assert.equal(pdfStageProgress('payload').percent, 30);
  assert.equal(pdfStageProgress('upload').percent, 35);
  assert.equal(pdfStageProgress('extract').percent, 80);
  assert.equal(pdfStageProgress('verify').percent, 90);
  assert.equal(pdfStageProgress('persist').percent, 95);
  assert.equal(pdfStageProgress('done').percent, 100);
});

test('l avanzamento è monotono e non torna indietro', () => {
  const { events, reporter } = record();
  const stages: PdfImportStage[] = ['prepare', 'read', 'payload', 'upload', 'extract', 'verify'];
  for (const stage of stages) reporter.stage(stage);
  reporter.stage('read');
  const percents = events.map((event) => event.percent);
  assert.deepEqual(percents, [...percents].sort((left, right) => left - right));
  assert.equal(reporter.lastPercent, 90);
  assert.equal(setPdfProgressMonotonic(70, 40), 70);
  assert.equal(setPdfProgressMonotonic(70, 80), 80);
  assert.equal(setPdfProgressMonotonic(0, -5), 0);
  assert.equal(setPdfProgressMonotonic(99, 150), 100);
});

test('A. con Edge ancora in attesa la barra non supera 78', () => {
  const scheduler = manualScheduler();
  const { reporter } = record(scheduler.api);
  reporter.stage('upload');
  assert.equal(reporter.lastPercent, 35);
  assert.equal(reporter.isAiWaiting, true);
  for (let i = 0; i < 40; i += 1) {
    if (scheduler.queue.length === 0) break;
    scheduler.flushOne();
    assert.ok(
      reporter.lastPercent <= PDF_AI_WAIT_CEILING,
      `percent=${reporter.lastPercent}`
    );
  }
  assert.equal(reporter.lastPercent, PDF_AI_WAIT_CEILING);
  assert.ok(nextAiWaitPercent(PDF_AI_WAIT_CEILING) <= PDF_AI_WAIT_CEILING);
});

test('B. 80 arriva solo dopo la risposta Edge riuscita', () => {
  const scheduler = manualScheduler();
  const { events, reporter } = record(scheduler.api);
  reporter.stage('upload');
  scheduler.flushOne();
  assert.ok(reporter.lastPercent < 80);
  assert.ok(events.every((event) => event.percent < 80));
  reporter.stage('extract');
  assert.equal(reporter.lastPercent, 80);
  assert.equal(reporter.isAiWaiting, false);
  assert.equal(events.at(-1)?.messageKey, 'processing.pdfExtract');
});

test('C. un fallimento non raggiunge mai 80 né 100', () => {
  const scheduler = manualScheduler();
  const { events, reporter } = record(scheduler.api);
  reporter.stage('prepare');
  reporter.stage('read');
  reporter.stage('payload');
  reporter.stage('upload');
  scheduler.flushOne();
  reporter.stopAiWait();
  assert.equal(reporter.isAiWaiting, false);
  assert.ok(reporter.lastPercent < 80);
  assert.ok(events.every((event) => event.percent < 80));
  assert.ok(events.every((event) => event.percent < 100));
});

test('D. il cento per cento arriva solo a documento creato', () => {
  const { events, reporter } = record();
  for (const stage of ['prepare', 'read', 'payload', 'upload', 'extract', 'verify'] as PdfImportStage[]) {
    reporter.stage(stage);
  }
  assert.ok(events.every((event) => event.percent < 100));
  reporter.stage('persist');
  assert.equal(reporter.lastPercent, 95);
  reporter.stage('done');
  assert.equal(reporter.lastPercent, 100);
  assert.equal(events.at(-1)?.messageKey, 'processing.done');
});

test('E. la progressione resta monotona anche con i tick AI', () => {
  const scheduler = manualScheduler();
  const { events, reporter } = record(scheduler.api);
  reporter.stage('upload');
  for (let i = 0; i < 8; i += 1) scheduler.flushOne();
  const percents = events.map((event) => event.percent);
  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(percents[i] >= percents[i - 1], `${percents[i - 1]} -> ${percents[i]}`);
  }
});

test('F. dispose e cancel fermano i timer', () => {
  const scheduler = manualScheduler();
  const { reporter } = record(scheduler.api);
  reporter.stage('upload');
  assert.equal(scheduler.queue.length, 1);
  const pendingBefore = scheduler.queue.length;
  reporter.dispose();
  assert.equal(reporter.isAiWaiting, false);
  assert.ok(scheduler.cleared.length >= 1);
  assert.equal(scheduler.queue.length, pendingBefore);
  // I tick residui in coda non devono più muovere la barra.
  const frozen = reporter.lastPercent;
  scheduler.flushAll();
  assert.equal(reporter.lastPercent, frozen);
});

test('un nuovo import riparte da zero', () => {
  const first = createPdfImportProgressReporter();
  first.stage('verify');
  assert.equal(first.lastPercent, 90);
  const second = createPdfImportProgressReporter();
  assert.equal(second.lastPercent, 0);
  second.stage('prepare');
  assert.equal(second.lastPercent, 10);
});

test('ogni fase PDF ha un messaggio tradotto in italiano e inglese', () => {
  const it = locale('it.json');
  const en = locale('en.json');
  const stages: PdfImportStage[] = ['prepare', 'read', 'payload', 'upload', 'extract', 'verify', 'persist', 'done'];
  for (const stage of stages) {
    const key = pdfStageProgress(stage).messageKey;
    assert.ok(it[key], `manca ${key} in it.json`);
    assert.ok(en[key], `manca ${key} in en.json`);
  }
  assert.equal(it['processing.pdfUpload'], 'Invio al servizio AI');
  assert.equal(en['processing.pdfUpload'], 'Sending to AI service');
  assert.equal(it['processing.pdfExtract'], 'Elaborazione con AI');
  assert.equal(en['processing.pdfExtract'], 'Processing with AI');
  assert.equal(it['processing.pdfVerify'], 'Verifica dati');
  assert.equal(en['processing.pdfVerify'], 'Verifying data');
  assert.equal(it['processing.persist'], 'Salvataggio');
  assert.equal(en['processing.persist'], 'Saving');
  assert.equal(it['processing.done'], 'Completato');
  assert.equal(en['processing.done'], 'Completed');
});

test('i messaggi PDF non nominano dettagli tecnici', () => {
  const it = locale('it.json');
  const en = locale('en.json');
  const forbidden = /supabase|edge|base64|parser|structured/i;
  for (const key of Object.keys(it).filter((name) => name.startsWith('processing.pdf'))) {
    assert.doesNotMatch(it[key], forbidden, key);
    assert.doesNotMatch(en[key], forbidden, key);
  }
});

test('la diagnostica PdfProgress logga solo i cambi reali e distingue la fonte', () => {
  resetPdfProgressDiagnostics();
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(String(args[0] ?? ''));
  };
  try {
    const scheduler = manualScheduler();
    const { reporter } = record(scheduler.api);
    reporter.stage('upload');
    scheduler.flushOne();
    reporter.stage('extract');
    logPdfProgressChange(80, 'Elaborazione con AI', 'real_event');
  } finally {
    console.warn = originalWarn;
  }
  const parsed = lines
    .filter((line) => line.startsWith('[PdfProgress] '))
    .map((line) => JSON.parse(line.slice('[PdfProgress] '.length)) as {
      progress: number;
      phase: string;
      source: string;
    });
  assert.equal(parsed.length, 0, 'diagnostica disabilitata nella RC');
});
