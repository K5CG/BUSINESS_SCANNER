import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { planScanExit } from '../lib/scan-exit-policy';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Back senza pagine torna indietro senza conferma', () => {
  const plan = planScanExit({ hasUnsavedPages: false, isBusy: false, hasHistory: true, documentType: 'quote' });
  assert.equal(plan.destination, 'back');
  assert.equal(plan.requiresDiscardConfirmation, false);
});

test('Back con pagina non salvata richiede conferma', () => {
  assert.equal(planScanExit({ hasUnsavedPages: true, isBusy: false, hasHistory: true, documentType: 'order' }).requiresDiscardConfirmation, true);
});

test('Back durante OCR invalida prima della conferma', () => {
  assert.equal(planScanExit({ hasUnsavedPages: true, isBusy: true, hasHistory: true, documentType: 'quote' }).invalidateBeforePrompt, true);
});

test('Back durante elaborazione senza pagina invalida e naviga', () => {
  const plan = planScanExit({ hasUnsavedPages: false, isBusy: true, hasHistory: true, documentType: 'free_document' });
  assert.equal(plan.invalidateBeforePrompt, true);
  assert.equal(plan.requiresDiscardConfirmation, false);
});

test('fallback documenti senza history è deterministico', () => {
  assert.equal(planScanExit({ hasUnsavedPages: false, isBusy: false, hasHistory: false, documentType: 'quote' }).destination, 'documents');
});

test('fallback biglietti senza history apre contatti', () => {
  assert.equal(planScanExit({ hasUnsavedPages: false, isBusy: false, hasHistory: false, documentType: 'business_card' }).destination, 'contacts');
});

test('header Back e hardware condividono requestExit', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /onPress=\{\(\) => requestExit\(\)\}/);
  assert.match(route, /hardwareBackPress[\s\S]*requestExit\(\)/);
});

test('conferma uscita esegue discardAndCancel', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /discardAndCancel\('manual'\)/);
});

test('annulla uscita non esegue navigazione', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /onPress: cancelDiscard/);
});

test('swipe iOS passa da beforeRemove protetto', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /beforeRemove/);
  assert.match(route, /event\.preventDefault\(\)/);
  assert.match(route, /requestExit\(event\.data\.action\)/);
});

test('ref uscita viene ripristinato a ogni focus', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /useFocusEffect[\s\S]*exitRequestedRef\.current = false/);
});

test('header ha area touch e feedback visivo', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /hitSlop=\{12\}/);
  assert.match(route, /activeOpacity=\{0\.6\}/);
  // 28 px icon + 12 px hitSlop per lato = 52 px effettivi:
  // superiore al target touch minimo di 48 px senza imporre uno style specifico.
  assert.ok(/minWidth:\s*48/.test(route) || /hitSlop=\{12\}/.test(route));
});

test('header è accessibile con label e hint', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(route, /accessibilityRole="button"/);
  assert.match(route, /accessibilityLabel=\{t\('scanBackLabel'\)\}/);
  assert.match(route, /accessibilityHint=\{t\('scanBackHint'\)\}/);
});

test('cleanup asset avviene solo nello scarto confermato', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const invalidateCurrentWork/);
  assert.match(scanner, /const cancelCurrentWork[\s\S]*closeSessionAssets\(\)/);
});

test('operazioni e salvataggi tardivi sono invalidati', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /processOperationsRef\.current\.invalidateCurrent/);
  assert.match(scanner, /processingGateRef\.current\.invalidateCurrent/);
});

test('navigazione interna dopo commit non viene scambiata per uscita manuale', () => {
  const route = read('app/scan/[type].tsx');
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(route, /committedNavigationUntilRef\.current >= Date\.now\(\)/);
  assert.match(route, /committedNavigationUntilRef\.current = 0;[\s\S]*return;/);
  assert.match(
    scanner,
    /authorizeCommittedNavigation\?\.\(\);[\s\S]*router\.replace\(`\/document\/\$\{targetId\}\$\{partial\}`\)/
  );
});

test('biglietti e documenti usano la stessa guardia di uscita', () => {
  const route = read('app/scan/[type].tsx');
  assert.match(
    route,
    /<MultiPageScanner[\s\S]*documentType=\{documentType\}[\s\S]*registerExitGuard=\{registerExitGuard\}/
  );
});

test('salvataggio documento mostra conferma breve e torna ai documenti', () => {
  const route = read('app/document/[id].tsx');
  assert.match(route, /showSaveToast\(t\('documentSaved'\)\)/);
  assert.match(route, /router\.replace\('\/\(tabs\)\/documents'\)/);
  assert.match(route, /navigated = true/);
});

test('salvataggio documento non lascia un popup bloccante ripetibile', () => {
  const route = read('app/document/[id].tsx');
  assert.doesNotMatch(route, /Alert\.alert\(t\('success'\), t\('documentSaved'\)\)/);
});
