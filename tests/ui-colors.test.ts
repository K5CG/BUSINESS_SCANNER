import assert from 'node:assert/strict';
import test from 'node:test';
import { darkColors, lightColors } from '../lib/ui-tokens.ts';

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

for (const [mode, palette] of [
  ['light', lightColors],
  ['dark', darkColors],
] as const) {
  test(`${mode}: testo primario e secondario resta leggibile sulle superfici`, () => {
    assert.ok(contrast(palette.textPrimary, palette.background) >= 7);
    assert.ok(contrast(palette.textPrimary, palette.surface) >= 7);
    assert.ok(contrast(palette.textSecondary, palette.surface) >= 4.5);
  });

  test(`${mode}: placeholder e testo disabilitato non diventano trasparenti`, () => {
    assert.ok(contrast(palette.textDisabled, palette.surface) >= 3);
  });

  test(`${mode}: azione primaria mantiene il contrasto`, () => {
    assert.ok(contrast(palette.textOnPrimary, palette.primary) >= 4.5);
  });

  test(`${mode}: stati semantici non dipendono dalla sola trasparenza`, () => {
    assert.ok(contrast(palette.danger, palette.dangerSurface) >= 4.5);
    assert.ok(contrast(palette.warning, palette.warningSurface) >= 4.5);
    assert.ok(contrast(palette.success, palette.successSurface) >= 4.5);
  });
}
