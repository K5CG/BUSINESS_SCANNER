import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapPreviewRectToPhotoRect,
  type PreviewPhotoMappingInput,
} from '../lib/preview-photo-mapping';

const CARD_ASPECT = 85.6 / 53.98;

/** Geometria realmente osservata sul dispositivo di QA (Xiaomi/MTK). */
const REAL_DEVICE: PreviewPhotoMappingInput = {
  previewWidth: 375.385,
  previewHeight: 548,
  photoWidth: 1530,
  photoHeight: 2040,
  overlayX: 29.735,
  overlayY: 134.391,
  overlayWidth: 315.914,
  overlayHeight: 199.218,
  fitMode: 'cover',
};

test('CASE 1 anteprima e foto con lo stesso rapporto: scala proporzionale pura', () => {
  const mapping = mapPreviewRectToPhotoRect({
    previewWidth: 300,
    previewHeight: 400,
    photoWidth: 1500,
    photoHeight: 2000,
    overlayX: 30,
    overlayY: 40,
    overlayWidth: 240,
    overlayHeight: 160,
    previewStreamWidth: 1500,
    previewStreamHeight: 2000,
  });
  assert.equal(mapping.previewCropOffsetX, 0);
  assert.equal(mapping.previewCropOffsetY, 0);
  // 1200x800 attorno alla cornice, più il 2% di margine deliberato.
  assert.deepEqual(mapping.rect, { x: 138, y: 192, width: 1224, height: 816 });
  assert.equal(mapping.cropValidated, true);
  assert.equal(mapping.cropDecision, 'applied_verified');
});

test('CASE 2 anteprima più stretta della foto: compensa il taglio orizzontale', () => {
  const mapping = mapPreviewRectToPhotoRect({
    previewWidth: 300,
    previewHeight: 500,
    photoWidth: 1500,
    photoHeight: 2000,
    overlayX: 0,
    overlayY: 0,
    overlayWidth: 300,
    overlayHeight: 100,
    previewStreamWidth: 1500,
    previewStreamHeight: 2000,
  });
  // La view mostra solo 1200 dei 1500 pixel di larghezza: la cornice a tutta
  // larghezza deve mappare quei 1200, non l'intera foto.
  assert.equal(mapping.previewCropOffsetX, 150);
  assert.deepEqual(mapping.rect, { x: 138, y: 0, width: 1224, height: 404 });
  assert.equal(mapping.cropValidated, true);
});

test('CASE 3 anteprima più larga della foto: compensa il taglio verticale', () => {
  const mapping = mapPreviewRectToPhotoRect({
    previewWidth: 500,
    previewHeight: 300,
    photoWidth: 2000,
    photoHeight: 1500,
    overlayX: 50,
    overlayY: 0,
    overlayWidth: 400,
    overlayHeight: 300,
    previewStreamWidth: 2000,
    previewStreamHeight: 1500,
  });
  assert.equal(mapping.previewCropOffsetY, 150);
  assert.deepEqual(mapping.rect, { x: 184, y: 138, width: 1632, height: 1224 });
  assert.equal(mapping.cropValidated, true);
});

test('CASE 4 foto verticale e cornice orizzontale non attivano rotazioni', () => {
  const mapping = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    previewStreamWidth: 1200,
    previewStreamHeight: 1600,
  });
  // `cardOrientation = landscape` descrive la forma del biglietto, non gli assi
  // del buffer: viewport e JPEG sono entrambi verticali, quindi nessuna
  // trasformazione di orientamento deve entrare in gioco.
  assert.equal(mapping.orientationTransformApplied, false);
  const aspect = mapping.rect!.width / mapping.rect!.height;
  assert.ok(
    Math.abs(aspect - CARD_ASPECT) / CARD_ASPECT < 0.02,
    `forma del ritaglio incoerente con la cornice: ${aspect}`
  );
});

test('CASE 4b un buffer sugli assi del sensore resta non verificabile', () => {
  const mapping = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    photoWidth: 2040,
    photoHeight: 1530,
    previewStreamWidth: 1200,
    previewStreamHeight: 1600,
  });
  assert.equal(mapping.orientationTransformApplied, true);
  assert.equal(mapping.cropValidated, false);
  assert.equal(mapping.uncertaintyReason, 'orientation_transform_unproven');
  // Anche se non validato, il rettangolo calcolato resta dentro la foto.
  const rect = mapping.rect!;
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.width <= 2040);
  assert.ok(rect.y + rect.height <= 1530);
});

test('CASE 5 un ritaglio validato è sempre interno ai limiti della foto', () => {
  const overlays = [
    { overlayX: 0, overlayY: 0, overlayWidth: 375.385, overlayHeight: 200 },
    { overlayX: 29.735, overlayY: 134.391, overlayWidth: 315.914, overlayHeight: 199.218 },
    { overlayX: 100, overlayY: 300, overlayWidth: 200, overlayHeight: 120 },
  ];
  for (const overlay of overlays) {
    const mapping = mapPreviewRectToPhotoRect({
      ...REAL_DEVICE,
      ...overlay,
      previewStreamWidth: 1200,
      previewStreamHeight: 1600,
    });
    const rect = mapping.rect!;
    assert.ok(rect.x >= 0, `x negativo: ${rect.x}`);
    assert.ok(rect.y >= 0, `y negativo: ${rect.y}`);
    assert.ok(rect.x + rect.width <= REAL_DEVICE.photoWidth);
    assert.ok(rect.y + rect.height <= REAL_DEVICE.photoHeight);
  }
});

test('CASE 5b una cornice che deborda viene contenuta nei limiti della foto', () => {
  const mapping = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    fitMode: 'contain',
    overlayX: 0,
    overlayY: 0,
    overlayWidth: 375.385,
    overlayHeight: 548,
    previewStreamWidth: 1200,
    previewStreamHeight: 1600,
  });
  const rect = mapping.rect!;
  assert.equal(rect.x, 0);
  assert.equal(rect.y, 0);
  assert.equal(rect.width, REAL_DEVICE.photoWidth);
  assert.equal(rect.height, REAL_DEVICE.photoHeight);
});

test('CASE 6 senza stream nativo vale il campo visivo predefinito del sensore', () => {
  // Anteprima e scatto condividono la strategia 4:3 di CameraX sulla stessa
  // regione del sensore: il rapporto del JPEG è già quello dell'anteprima.
  const mapping = mapPreviewRectToPhotoRect(REAL_DEVICE);
  assert.equal(mapping.fovSource, 'sensor_default');
  assert.equal(mapping.cropValidated, true);
  assert.equal(mapping.cropDecision, 'applied_verified');
});

test('CASE 6c un JPEG fuori dal rapporto del sensore non è mappabile', () => {
  // 16:9: anteprima e scatto non inquadrano più la stessa scena.
  const mapping = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    photoWidth: 1080,
    photoHeight: 1920,
  });
  assert.equal(mapping.cropValidated, false);
  assert.equal(mapping.uncertaintyReason, 'preview_fov_mismatch');
});

test('CASE 6b uno stream con campo visivo diverso viene compensato', () => {
  // Stream 9:16 contro scatto 3:4: l'anteprima mostra solo la fascia centrale
  // dello scatto, quindi la cornice mappa su meno pixel e resta centrata.
  const compensated = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    previewStreamWidth: 1080,
    previewStreamHeight: 1920,
  });
  assert.equal(compensated.fovSource, 'native_stream');
  assert.equal(compensated.cropValidated, true);
  assert.equal(compensated.cropDecision, 'applied_verified');

  const rect = compensated.rect!;
  const sensorDefault = mapPreviewRectToPhotoRect(REAL_DEVICE).rect!;
  assert.ok(
    rect.width < sensorDefault.width,
    `un'anteprima che inquadra meno scena deve mappare meno pixel: ${rect.width}`
  );
  assert.ok(
    Math.abs(rect.width / rect.height - sensorDefault.width / sensorDefault.height) <= 0.05,
    'la forma del ritaglio deve restare quella della cornice'
  );
  assert.ok(
    Math.abs(rect.x + rect.width / 2 - REAL_DEVICE.photoWidth / 2) <= 1,
    'il ritaglio deve restare centrato in orizzontale'
  );
  assert.ok(rect.x >= 0 && rect.x + rect.width <= REAL_DEVICE.photoWidth);
});

test('CASE 7 la geometria reale ritaglia obbligatoriamente sulla cornice', () => {
  const mapping = mapPreviewRectToPhotoRect(REAL_DEVICE);
  const rect = mapping.rect!;
  // 177/500/1176/742 è la cornice esatta; il rettangolo salvato la contiene
  // con il solo margine deliberato del 2%.
  assert.deepEqual(rect, { x: 165, y: 493, width: 1200, height: 757 });

  // Il ritaglio prodotto dalla build col margine empirico dell'8%.
  assert.notDeepEqual(rect, { x: 130, y: 471, width: 1270, height: 801 });

  // La cornice è centrata in orizzontale nella view: deve restarlo nel JPEG.
  assert.equal(rect.x + rect.width / 2, REAL_DEVICE.photoWidth / 2);

  // La forma del ritaglio corrisponde a quella della cornice cyan.
  const overlayAspect = REAL_DEVICE.overlayWidth / REAL_DEVICE.overlayHeight;
  const cropAspect = rect.width / rect.height;
  assert.ok(
    Math.abs(cropAspect - overlayAspect) / overlayAspect < 0.02,
    `forma del ritaglio incoerente con la cornice: ${cropAspect}`
  );

  // Il ritaglio copre una frazione della foto, non il fotogramma intero.
  const area = (rect.width * rect.height) /
    (REAL_DEVICE.photoWidth * REAL_DEVICE.photoHeight);
  assert.ok(area < 0.35, `il ritaglio non può coprire tutta la foto: ${area}`);
  assert.equal(mapping.mappingMode, 'cover');
  assert.equal(mapping.cropDecision, 'applied_verified');
});

test('CASE 7b i pixel reali del decoder con lo stream nativo mappano la stessa cornice', () => {
  // Il dispositivo dichiara 1530x2040 nei metadata ma il JPEG che viene
  // ritagliato è 3060x4080: è su questi pixel che deve nascere il rettangolo.
  // Lo stream di anteprima 4:3 arriva dall'evento CAMERA_OPEN nativo.
  const mapping = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    photoWidth: 3060,
    photoHeight: 4080,
    previewStreamWidth: 1080,
    previewStreamHeight: 1440,
  });
  assert.equal(mapping.fovSource, 'native_stream');
  assert.equal(mapping.cropValidated, true);
  assert.equal(mapping.cropDecision, 'applied_verified');

  const rect = mapping.rect!;
  const halfScale = mapPreviewRectToPhotoRect(REAL_DEVICE).rect!;
  assert.ok(
    Math.abs(rect.x - halfScale.x * 2) <= 2 && Math.abs(rect.y - halfScale.y * 2) <= 2,
    `il ritaglio deve raddoppiare con i pixel reali: ${rect.x}/${rect.y}`
  );
  assert.ok(
    Math.abs(rect.width - halfScale.width * 2) <= 4 &&
      Math.abs(rect.height - halfScale.height * 2) <= 4,
    `dimensioni incoerenti coi pixel reali: ${rect.width}x${rect.height}`
  );
  // Applicare il rettangolo dimezzato a questo bitmap avrebbe ritagliato
  // l'angolo alto-sinistra della scena, cioè lo sfondo dietro il biglietto.
  assert.ok(rect.x + rect.width > 3060 / 2, 'il ritaglio non può restare nella metà sinistra');
});

test('CASE 8 il biglietto verticale conserva la forma della propria cornice', () => {
  // Cornice ritratto: stessa larghezza utile, altezza maggiore.
  const portraitOverlay = {
    overlayX: 71.7,
    overlayY: 100,
    overlayWidth: 232,
    overlayHeight: 367.9,
  };
  const mapping = mapPreviewRectToPhotoRect({
    ...REAL_DEVICE,
    ...portraitOverlay,
  });
  assert.equal(mapping.cropValidated, true);
  const rect = mapping.rect!;
  assert.ok(rect.height > rect.width, 'un biglietto verticale resta verticale');
  const overlayAspect = portraitOverlay.overlayWidth / portraitOverlay.overlayHeight;
  const cropAspect = rect.width / rect.height;
  assert.ok(
    Math.abs(cropAspect - overlayAspect) / overlayAspect < 0.02,
    `forma del ritaglio incoerente con la cornice verticale: ${cropAspect}`
  );
});

test('CASE 9 il margine di sicurezza resta entro la soglia dichiarata', () => {
  const mapping = mapPreviewRectToPhotoRect(REAL_DEVICE);
  const rect = mapping.rect!;
  // La cornice esatta misura 1176x742 pixel foto.
  assert.ok((rect.width - 1176) / 1176 <= 0.03, 'margine orizzontale oltre il 3%');
  assert.ok((rect.height - 742) / 742 <= 0.03, 'margine verticale oltre il 3%');
});
