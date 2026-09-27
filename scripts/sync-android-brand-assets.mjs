#!/usr/bin/env node
/**
 * Copia icon/splash da assets/ nelle risorse native Android (res/).
 * Gradle non legge assets/icon.png direttamente: serve questo passo prima del build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
const BRAND_BG = '#0e2438';

const splashSizes = {
  mdpi: 288,
  hdpi: 432,
  xhdpi: 576,
  xxhdpi: 864,
  xxxhdpi: 1152,
};

const foregroundSizes = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

const launcherSizes = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

function pickAsset(name) {
  const file = path.join(assets, name);
  if (!fs.existsSync(file)) throw new Error(`Asset mancante: ${file} — esegui npm run render:brand-icons`);
  return file;
}

async function writeSized(input, outPath, size, format = 'png') {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const img = sharp(input).resize(size, size, { fit: 'contain', background: BRAND_BG });
  if (format === 'webp') await img.webp({ quality: 95 }).toFile(outPath);
  else await img.png().toFile(outPath);
}

function patchColors(file) {
  if (!fs.existsSync(file)) return;
  let xml = fs.readFileSync(file, 'utf8');
  xml = xml
    .replace(
      /<color name="splashscreen_background">[^<]+<\/color>/,
      `<color name="splashscreen_background">${BRAND_BG}</color>`
    )
    .replace(
      /<color name="iconBackground">[^<]+<\/color>/,
      `<color name="iconBackground">${BRAND_BG}</color>`
    );
  fs.writeFileSync(file, xml);
}

async function main() {
  const splashSrc = pickAsset('splash-icon.png');
  const adaptiveSrc = pickAsset('adaptive-icon.png');
  const iconSrc = pickAsset('icon.png');

  for (const [density, size] of Object.entries(splashSizes)) {
    await writeSized(
      splashSrc,
      path.join(res, `drawable-${density}`, 'splashscreen_logo.png'),
      size,
      'png'
    );
  }

  for (const [density, size] of Object.entries(foregroundSizes)) {
    await writeSized(
      adaptiveSrc,
      path.join(res, `mipmap-${density}`, 'ic_launcher_foreground.webp'),
      size,
      'webp'
    );
  }

  for (const [density, size] of Object.entries(launcherSizes)) {
    for (const name of ['ic_launcher.webp', 'ic_launcher_round.webp']) {
      await writeSized(iconSrc, path.join(res, `mipmap-${density}`, name), size, 'webp');
    }
  }

  patchColors(path.join(res, 'values', 'colors.xml'));
  patchColors(path.join(res, 'values-night', 'colors.xml'));

  console.log('[sync-android-brand-assets] Icone/splash Android aggiornate da assets/');
}

main().catch((e) => {
  console.error('[sync-android-brand-assets] ERRORE:', e.message || e);
  process.exit(1);
});
