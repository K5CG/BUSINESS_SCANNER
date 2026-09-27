import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { AnyDocument } from '../types/index.ts';
import {
  createDefaultDocumentTypeSelection,
  toggleDocumentTypeSelection,
} from '../lib/document-type-filters.ts';
import { filterDocuments, isDocumentListFilterActive } from '../lib/document-search.ts';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'app', '(tabs)', 'documents.tsx'), 'utf8');
const it = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'it.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));

const CHIP_HORIZONTAL_PADDING = 16;
const ROW_HORIZONTAL_MARGIN = 16;
const TOTAL_GAPS = 16;
const ESTIMATED_CAPTION_CHAR_WIDTH = 7;

function estimatedRowWidth(labels: string[]): number {
  return labels.reduce(
    (total, label) => total + label.length * ESTIMATED_CAPTION_CHAR_WIDTH + CHIP_HORIZONTAL_PADDING,
    TOTAL_GAPS,
  );
}

test('abbreviazioni filtri documenti e traduzioni home', () => {
  const italianLabels = [
    it.documentsFilterAll,
    it.documentsFilterQuote,
    it.documentsFilterOrder,
    it.documentsFilterInvoice,
    it.documentsFilterFreeDocument,
  ];
  const englishLabels = [
    en.documentsFilterAll,
    en.documentsFilterQuote,
    en.documentsFilterOrder,
    en.documentsFilterInvoice,
    en.documentsFilterFreeDocument,
  ];
  const availableWidth = 335 - ROW_HORIZONTAL_MARGIN;

  assert.deepEqual(italianLabels, ['Tutti', 'Prev.', 'Ord.', 'Fatt.', 'Doc.']);
  assert.deepEqual(englishLabels, ['All', 'Quotes', 'Orders', 'Invoices', 'Docs']);
  // Il filtro si abbrevia per restare su una riga, il titolo della schermata no.
  assert.notEqual(en.documentsFilterFreeDocument, 'Documents');
  assert.equal(en.documents, 'Documents');
  assert.ok(estimatedRowWidth(englishLabels) <= availableWidth + 24);
  assert.equal(it.invoice, 'Fattura');
  assert.equal(it.otherDocument, 'Altro');
  assert.equal(en.invoice, 'Invoice');
  assert.equal(en.otherDocument, 'Other');
  assert.ok(estimatedRowWidth(italianLabels) <= availableWidth + 24);
  assert.match(source, /createDefaultDocumentTypeSelection/);
  assert.match(source, /handleFilterPress/);
  assert.match(source, /isFilterChipActive/);
});

test('filtri multi-selezione combinano tipi documento', () => {
  const documents = [
    { id: '1', type: 'quote', title: 'Q1', rawText: '', updatedAt: new Date() },
    { id: '2', type: 'order', title: 'O1', rawText: '', updatedAt: new Date() },
    { id: '3', type: 'invoice', title: 'I1', rawText: '', updatedAt: new Date() },
  ] as unknown as AnyDocument[];
  const quoteAndOrder = toggleDocumentTypeSelection(
    toggleDocumentTypeSelection(createDefaultDocumentTypeSelection(), 'invoice'),
    'free_document',
  );
  assert.equal(isDocumentListFilterActive(quoteAndOrder), true);
  const filtered = filterDocuments(documents, '', quoteAndOrder);
  assert.deepEqual(filtered.map((doc) => doc.id), ['1', '2']);
});

test('schermi stretti e font grandi usano wrapping senza clipping o larghezze fisse', () => {
  assert.match(source, /typeFilterRow:\s*\{[\s\S]*?flexDirection:\s*'row'/);
  assert.match(source, /typeFilterRow:\s*\{[\s\S]*?flexWrap:\s*'wrap'/);
  assert.doesNotMatch(source, /typeFilterChip:\s*\{[\s\S]*?\bwidth:\s*\d+/);
  assert.doesNotMatch(source, /typeFilterChipText:\s*\{[^}]*numberOfLines/);
  assert.match(source, /typeFilterChip:\s*\{[\s\S]*?minHeight:\s*44/);
  assert.match(source, /typeFilterRow:\s*\{[\s\S]*?gap:\s*4/);
  assert.match(source, /typeFilterRow:\s*\{[\s\S]*?marginHorizontal:\s*8/);
  assert.match(source, /typeFilterChip:\s*\{[\s\S]*?paddingHorizontal:\s*8/);
});

test('filtri multi-selezione, picker e bidoncino senza bordo', () => {
  assert.match(source, /DocumentScanTypePicker/);
  assert.match(source, /filterDocuments\(documents, searchQuery, typeSelection\)/);
  assert.match(source, /accessibilityState=\{\{ selected: active \}\}/);
  assert.match(source, /deleteBtn:\s*\{[\s\S]*?minHeight:\s*44/);
  assert.doesNotMatch(source, /deleteBtn:\s*\{[\s\S]*?borderColor:\s*colors\.danger/);
});

test("l'elenco documenti offre l'importazione PDF accanto a scatto ed esportazione", () => {
  const scanner = fs.readFileSync(
    path.join(root, 'components', 'Camera', 'MultiPageScanner.tsx'),
    'utf8',
  );
  const scanScreen = fs.readFileSync(path.join(root, 'app', 'scan', '[type].tsx'), 'utf8');

  assert.match(source, /onPress=\{openPdfImport\}/);
  assert.match(source, /accessibilityLabel=\{t\('importPdf'\)\}/);
  assert.match(source, /\{t\('importPdfShort'\)\}/);
  assert.equal(en.importPdfShort, 'PDF');
  assert.equal(it.importPdfShort, 'PDF');

  // Il comando non inventa un percorso proprio: riusa la scelta del tipo e la
  // schermata di acquisizione, che possiede consenso cloud e persistenza.
  assert.match(source, /router\.push\(`\/scan\/\$\{singleType\}\?intent=pdf`\)/);
  assert.match(source, /intent === 'pdf' \? `\/scan\/\$\{scanType\}\?intent=pdf`/);
  assert.match(scanScreen, /autoImportPdf=\{intent === 'pdf'\}/);
  assert.match(scanner, /if \(!autoImportPdf \|\| documentType === 'business_card'\) return;/);
  assert.match(scanner, /requestPdfImport\(\);/);
  assert.match(scanner, /pickAndParsePdf/);
});

test("la schermata di acquisizione mostra il comando PDF accanto all'orientamento", () => {
  const scanner = fs.readFileSync(
    path.join(root, 'components', 'Camera', 'MultiPageScanner.tsx'),
    'utf8',
  );

  // È il punto storico del comando: chi arriva da Preventivo/Ordine/Fattura
  // deve poter scegliere il PDF senza tornare all'elenco documenti.
  assert.match(
    scanner,
    /const showPdf = documentType !== 'business_card' && isSupabaseConfigured\(\);/,
  );
  assert.match(scanner, /onPress=\{requestPdfImport\}[\s\S]{0,240}?styles\.headerPdfBtn/);
  assert.match(scanner, /accessibilityLabel=\{t\('importPdf'\)\}/);

  // Il comando vive nell'intestazione ricostruita dall'effetto: senza la
  // dipendenza resterebbe legato alla prima chiusura.
  assert.match(scanner, /toggleOrientation,\s*\r?\n\s*requestPdfImport,/);

  // Il biglietto da visita resta fuori: nessun PDF nel percorso contatto.
  assert.doesNotMatch(scanner, /documentType === 'business_card' && isSupabaseConfigured\(\)/);
});

test('il consenso PDF resta confermabile e raggiungibile senza camera', () => {
  const modal = fs.readFileSync(
    path.join(root, 'components', 'GeminiConfirmationModal.tsx'),
    'utf8',
  );
  const scanner = fs.readFileSync(
    path.join(root, 'components', 'Camera', 'MultiPageScanner.tsx'),
    'utf8',
  );

  // Senza crediti esposti il riquadro non presenta alcun contratto di consumo:
  // la sospensione AI generale non deve disabilitare "Invia".
  assert.match(
    modal,
    /const confirmDisabled = showCredits && \(creditsExhausted \|\| creditsUnavailable\);/,
  );

  // Il PDF non usa la camera: il consenso compare anche quando la schermata
  // chiede il permesso o mostra la conferma dello scatto.
  const permissionBranch = scanner.slice(
    scanner.indexOf('const pdfConsentModal = ('),
    scanner.indexOf('const controlsBottom'),
  );
  assert.ok(permissionBranch.length > 0, 'consenso PDF non estratto in un elemento riusabile');
  assert.equal((permissionBranch.match(/\{pdfConsentModal\}/g) ?? []).length, 2);
  assert.match(permissionBranch, /\{t\(\x27cameraPermissionRequired\x27\)\}[\s\S]*?\{pdfConsentModal\}/);
});

test('i testi utente citano il supporto AI senza nominare il fornitore', () => {
  for (const dictionary of [en, it]) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value !== 'string') continue;
      assert.doesNotMatch(value, /Gemini/i, `${key} nomina il fornitore AI`);
      assert.doesNotMatch(value, /Google/i, `${key} nomina il fornitore AI`);
    }
  }

  // Il consenso resta comprensibile: dice che l'elaborazione avviene in cloud.
  assert.match(it.geminiModalIntroPdf, /supporto AI/);
  assert.match(en.geminiModalIntroPdf, /AI support/);
  assert.match(it.privacySection3, /servizio di intelligenza artificiale in cloud/);
});

test("l'importazione PDF passa da un permesso proprio, non dall'AI generale", () => {
  const scanner = fs.readFileSync(
    path.join(root, 'components', 'Camera', 'MultiPageScanner.tsx'),
    'utf8',
  );
  const pdfImport = fs.readFileSync(path.join(root, 'lib', 'pdf-import.ts'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'lib', 'release-rc-policy.ts'), 'utf8');

  // Il PDF si collauda da solo: l'AI generale resta sospesa.
  assert.match(policy, /export const RC_AI_DISABLED = true;/);
  assert.match(policy, /export const RC_PDF_IMPORT_ALLOWED = true;/);
  assert.match(policy, /QA ONLY — DO NOT SHIP ENABLED UNTIL pdf_page_ai durable ledger/);
  assert.match(policy, /export function isRcCloudAiEnabled\(\): boolean \{\s*return !RC_AI_DISABLED;/);

  // Le altre funzioni AI continuano a interrogare la sospensione generale.
  for (const file of ['card-ai-structure.ts', 'document-ai-review.ts', 'entitlement.ts']) {
    const source_ = fs.readFileSync(path.join(root, 'lib', file), 'utf8');
    assert.match(source_, /isRcCloudAiEnabled\(\)/, `${file} non consulta più la sospensione AI`);
    assert.doesNotMatch(source_, /isRcPdfImportEnabled/, `${file} usa il permesso PDF`);
  }

  // I due soli presìdi PDF passano al permesso dedicato.
  assert.match(source, /if \(!isRcPdfImportEnabled\(\)\) \{[\s\S]{0,160}?t\('pdfImportAiDeferred'\)/);
  assert.match(scanner, /if \(!isRcPdfImportEnabled\(\)\) \{[\s\S]{0,200}?t\('pdfImportAiDeferred'\)/);

  // Il presidio nello scanner precede l'acquisizione del lock, così il percorso
  // diretto `?intent=pdf` non scavalca il controllo.
  const guardIndex = scanner.indexOf('if (!isRcPdfImportEnabled())');
  const leaseIndex = scanner.indexOf('const exclusiveLease = processingGateRef.current.tryAcquire()');
  assert.ok(guardIndex > 0 && guardIndex < leaseIndex);

  // L'implementazione resta intatta: nessun ramo del modulo è stato rimosso.
  assert.match(pdfImport, /pickAndParsePdf/);
  assert.match(pdfImport, /parsePdfWithSupabase/);
  assert.match(pdfImport, /picked\.canceled \|\| !picked\.assets\?\.\[0\]\?\.uri/);

  // Traccia QA senza contenuto del documento.
  const parsePdf = fs.readFileSync(path.join(root, 'lib', 'parse-pdf.ts'), 'utf8');
  assert.match(parsePdf, /'PDF_QA_DIAGNOSTIC'/);
  assert.match(parsePdf, /creditOperationType: ctx\.operationType/);
  assert.doesNotMatch(parsePdf, /pdfBase64,\s*\n\s*}\s*\);?\s*\n\s*logQa/);

  // La traccia deve sopravvivere al bundle QA, generato con --dev false: legata
  // al flag PDF, ma l'emissione reale richiede anche isQaLogEnabled() per store.
  assert.match(parsePdf, /export const PDF_QA_DIAGNOSTICS = RC_PDF_IMPORT_ALLOWED;/);
  assert.match(parsePdf, /emitPdfQaDiagnostics\(\)/);
  assert.match(parsePdf, /if \(emitPdfQaDiagnostics\(\)\) console\.warn\(`\[PdfQa\] /);
  assert.doesNotMatch(parsePdf, /const logQa = [\s\S]{0,120}?if \(!__DEV__\) return;/);

  // Nessun contenuto del PDF nella traccia: solo identificativi e stato.
  assert.doesNotMatch(parsePdf, /\[PdfQa\][^`]*rawText|\[PdfQa\][^`]*pdfBase64/);

  assert.ok(en.pdfImportAiDeferred.length > 0);
  assert.ok(it.pdfImportAiDeferred.length > 0);
});
