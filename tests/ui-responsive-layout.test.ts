import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSafeModalHeight,
  getScrollableBottomPadding,
  getUiViewportLayout,
} from '../lib/ui-layout.ts';

const widths = [320, 360, 390, 412, 430] as const;
const fontScales = [1, 1.15, 1.3, 1.5, 2] as const;
const densities = [1, 2, 3] as const;

test('la matrice telefono e font scale conserva padding utilizzabile', () => {
  for (const width of widths) {
    for (const fontScale of fontScales) {
      for (const density of densities) {
        const layout = getUiViewportLayout(width, fontScale);
        assert.ok(layout.horizontalPadding * 2 < width, `${width}/${fontScale}/${density}`);
        assert.ok(layout.modalHorizontalPadding * 2 < width, `${width}/${fontScale}/${density}`);
      }
    }
  }
});

test('azioni lunghe si impilano su schermi stretti o font grandi', () => {
  assert.equal(getUiViewportLayout(320, 1).stackActions, true);
  assert.equal(getUiViewportLayout(360, 1).stackActions, true);
  assert.equal(getUiViewportLayout(390, 1.5).stackActions, true);
  assert.equal(getUiViewportLayout(430, 2).stackActions, true);
  assert.equal(getUiViewportLayout(390, 1).stackActions, false);
});

test('azioni header diventano compatte prima di poter andare in overflow', () => {
  assert.equal(getUiViewportLayout(360, 1).compactHeaderActions, true);
  assert.equal(getUiViewportLayout(390, 1.3).compactHeaderActions, true);
  assert.equal(getUiViewportLayout(430, 1).compactHeaderActions, false);
});

test('altezza modal rispetta safe area, notch e barre di sistema', () => {
  assert.equal(getSafeModalHeight(568, 44, 34), 466);
  assert.equal(getSafeModalHeight(844, 59, 34), 727);
  assert.equal(getSafeModalHeight(200, 80, 80), 16);
  assert.equal(getSafeModalHeight(120, 80, 80), 0);
});

test('padding del form segue il footer realmente misurato e la tastiera', () => {
  assert.equal(getScrollableBottomPadding(120, 0), 152);
  assert.equal(getScrollableBottomPadding(240, 0), 272);
  assert.equal(getScrollableBottomPadding(240, 300), 628);
});
