/** Inline copy of overlay math for node test (no react-native). */
const CARD_LANDSCAPE = 85.6 / 53.98;
const CARD_PORTRAIT = 53.98 / 85.6;
const CARD_OVERLAY_WIDTH_RATIO = 0.92;

function fitFrame(availW, availH, aspectRatio) {
  let width = availW * CARD_OVERLAY_WIDTH_RATIO;
  let height = width / aspectRatio;
  const maxH = availH * 0.94;
  const maxW = availW * 0.96;
  if (height > maxH) { height = maxH; width = height * aspectRatio; }
  if (width > maxW) { width = maxW; height = width / aspectRatio; }
  return { width, height };
}

function getFrame(sw, sh, cardOri, insets) {
  const top = insets.top ?? 0, bottom = insets.bottom ?? 0, horiz = insets.horizontal ?? 0;
  const availW = Math.max(80, sw - horiz * 2);
  const availH = Math.max(80, sh - top - bottom);
  const aspect = cardOri === 'landscape' ? CARD_LANDSCAPE : CARD_PORTRAIT;
  const { width, height } = fitFrame(availW, availH, aspect);
  return { x: horiz + (availW - width) / 2, y: top + (availH - height) / 2, width, height };
}

function mapScreenToPhoto(frame, photoW, photoH, screenW, screenH) {
  const bufferAspect = photoW / photoH;
  const screenAspect = screenW / screenH;
  let scale, offsetX, offsetY;
  if (bufferAspect > screenAspect) {
    scale = screenH / photoH;
    offsetX = (photoW * scale - screenW) / 2;
    offsetY = 0;
  } else {
    scale = screenW / photoW;
    offsetX = 0;
    offsetY = (photoH * scale - screenH) / 2;
  }
  return {
    x: Math.round((frame.x + offsetX) / scale),
    y: Math.round((frame.y + offsetY) / scale),
    width: Math.round(frame.width / scale),
    height: Math.round(frame.height / scale),
  };
}

function pipeline(photoW, photoH, sw, sh, cardOri, exifNormalized) {
  const insets = { top: 20, bottom: 120, horizontal: 16 };
  const screenPortrait = sh >= sw;
  const photoLandscape = photoW > photoH;

  let nw = photoW, nh = photoH;
  let align = 0;
  if (!exifNormalized) {
    if (screenPortrait && photoLandscape) align = 90;
  } else {
    if (screenPortrait && photoLandscape) align = 90;
  }
  if (align === 90) [nw, nh] = [nh, nw];

  const frame = getFrame(sw, sh, cardOri, insets);
  const crop = mapScreenToPhoto(frame, nw, nh, sw, sh);
  let cw = crop.width, ch = crop.height;

  const wantL = cardOri === 'landscape';
  let reading = 0;
  if (wantL !== cw > ch) reading = wantL ? 270 : 90;
  if (reading === 90 || reading === 270) [cw, ch] = [ch, cw];

  return { align, reading, crop, finalW: cw, finalH: ch, frame, wantL };
}

const cases = [
  ['EXIF portrait (3060x4080)', 3060, 4080, 1080, 2400, 'landscape'],
  ['Raw landscape (4080x3060)', 4080, 3060, 1080, 2400, 'landscape'],
  ['Portrait card', 3060, 4080, 1080, 2400, 'portrait'],
];

console.log('=== CURRENT (exifNormalized always skip align) ===');
for (const [name, pw, ph, sw, sh, co] of cases) {
  const old = pipeline(pw, ph, sw, sh, co, true);
  old.exifNormalized = true;
  old.alignForced = 0;
  const r = pipeline(pw, ph, sw, sh, co, true);
  // simulate old: never align when exif
  let nw = pw, nh = ph, align = 0;
  const frame = getFrame(sw, sh, co, { top: 20, bottom: 120, horizontal: 16 });
  const crop = mapScreenToPhoto(frame, nw, nh, sw, sh);
  let cw = crop.width, ch = crop.height;
  const wantL = co === 'landscape';
  let reading = wantL !== cw > ch ? (wantL ? 270 : 90) : 0;
  if (reading) [cw, ch] = [ch, cw];
  const ok = wantL === cw > ch;
  console.log(ok ? 'OK ' : 'BAD', name, `crop=${crop.width}x${crop.height} rot=${reading} final=${cw}x${ch} wantL=${wantL}`);
}

console.log('\n=== FIXED (align if photo still landscape after EXIF) ===');
for (const [name, pw, ph, sw, sh, co] of cases) {
  const r = pipeline(pw, ph, sw, sh, co, true);
  const ok = r.wantL === r.finalW > r.finalH;
  console.log(ok ? 'OK ' : 'BAD', name, `align=${r.align} crop=${r.crop.width}x${r.crop.height} rot=${r.reading} final=${r.finalW}x${r.finalH}`);
}
