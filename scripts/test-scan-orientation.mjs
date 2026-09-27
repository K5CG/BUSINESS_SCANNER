/**
 * Simula tutti i casi telefono H/V × biglietto H/V × JPEG portrait/landscape.
 * Run: node scripts/test-scan-orientation.mjs
 */
import {
  getOverlayFrameRectInView,
  getOverlayAspectRatio,
  mapScreenRectToPhoto,
} from '../lib/overlay-geometry.ts';

const CARD_LANDSCAPE = 85.6 / 53.98;
const CARD_PORTRAIT = 53.98 / 85.6;
const VIEWPORT_INSETS = { top: 20, bottom: 120, horizontal: 16 };

function readingRotation(cropW, cropH, cardOrientation) {
  const cropIsLandscape = cropW > cropH;
  const wantLandscape = cardOrientation === 'landscape';
  if (wantLandscape === cropIsLandscape) return 0;
  return wantLandscape ? 270 : 90;
}

function finalDimensions(cropW, cropH, cardOrientation) {
  const rot = readingRotation(cropW, cropH, cardOrientation);
  if (rot === 90 || rot === 270) return { w: cropH, h: cropW, rot };
  return { w: cropW, h: cropH, rot };
}

function simulate(label, screenW, screenH, photoW, photoH, cardOrientation, streamSize) {
  const frame = getOverlayFrameRectInView(
    screenW,
    screenH,
    'business_card',
    cardOrientation,
    VIEWPORT_INSETS
  );
  const overlayLandscape = frame.width > frame.height;
  const wantLandscape = cardOrientation === 'landscape';

  const opts = streamSize
    ? { scaleMode: 'cover', previewStreamWidth: streamSize.w, previewStreamHeight: streamSize.h }
    : { scaleMode: 'cover' };

  const crop = mapScreenRectToPhoto(frame, photoW, photoH, screenW, screenH, opts);
  if (!crop) {
    console.log('FAIL', label, 'crop null');
    return false;
  }

  const expectedAspect = getOverlayAspectRatio('business_card', cardOrientation);
  const cropAspect = crop.width / crop.height;
  const aspectOk = Math.abs(cropAspect - expectedAspect) / expectedAspect <= 0.18;

  const fin = finalDimensions(crop.width, crop.height, cardOrientation);
  const finalLandscape = fin.w > fin.h;
  const aspectMatch = wantLandscape === finalLandscape;

  const ok = aspectOk && aspectMatch && overlayLandscape === wantLandscape;
  console.log(
    ok ? 'OK  ' : 'FAIL',
    label,
    `screen=${screenW}x${screenH}`,
    `photo=${photoW}x${photoH}`,
    `overlay=${Math.round(frame.width)}x${Math.round(frame.height)}`,
    `crop=${crop.width}x${crop.height}`,
    `rot=${fin.rot}`,
    `final=${fin.w}x${fin.h}`,
    wantLandscape ? 'want-H' : 'want-V'
  );
  return ok;
}

let pass = 0;
let fail = 0;
const cases = [
  // === CASO UTENTE: telefono verticale, biglietto orizzontale (screenshot) ===
  ['USER portrait phone + landscape card, EXIF portrait JPEG', 1080, 2400, 3060, 4080, 'landscape', null],
  ['USER alt resolution MIUI', 1080, 2340, 3024, 4032, 'landscape', null],
  ['USER with preview stream 4:3', 1080, 2400, 4080, 3060, 'landscape', { w: 1920, h: 1440 }],

  // Telefono verticale + biglietto verticale
  ['portrait phone + portrait card', 1080, 2400, 3060, 4080, 'portrait', null],

  // Telefono orizzontale + biglietto orizzontale
  ['landscape phone + landscape card', 2400, 1080, 4080, 3060, 'landscape', null],

  // Telefono orizzontale + biglietto verticale
  ['landscape phone + portrait card', 2400, 1080, 4080, 3060, 'portrait', null],

  // JPEG landscape grezzo (alcuni device)
  ['portrait phone + landscape card, raw landscape JPEG', 1080, 2400, 4080, 3060, 'landscape', null],
];

for (const args of cases) {
  if (simulate(...args)) pass++;
  else fail++;
}

console.log(`\n=== scan orientation sim: ${pass}/${pass + fail} ===`);
if (fail > 0) process.exit(1);

// Invarianti frame overlay
const frameH = getOverlayFrameRectInView(1080, 2400, 'business_card', 'landscape', VIEWPORT_INSETS);
const frameV = getOverlayFrameRectInView(1080, 2400, 'business_card', 'portrait', VIEWPORT_INSETS);
console.log(
  'Overlay landscape:',
  Math.round(frameH.width),
  'x',
  Math.round(frameH.height),
  'aspect',
  (frameH.width / frameH.height).toFixed(2),
  `(atteso ${CARD_LANDSCAPE.toFixed(2)})`
);
console.log(
  'Overlay portrait:',
  Math.round(frameV.width),
  'x',
  Math.round(frameV.height),
  'aspect',
  (frameV.width / frameV.height).toFixed(2),
  `(atteso ${CARD_PORTRAIT.toFixed(2)})`
);
