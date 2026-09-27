/**
 * Mappatura anteprima → pixel foto per il percorso biglietto da visita.
 *
 * La cornice verde vive nelle coordinate della view della CameraView, mentre il
 * ritaglio agisce sui pixel del JPEG. Le due geometrie coincidono solo se si
 * conosce la trasformazione con cui l'anteprima disegna lo stream della camera
 * nella view. Questo modulo modella quella trasformazione e, soprattutto,
 * dichiara quando NON è dimostrabile: in quel caso il ritaglio va saltato e si
 * conserva il fotogramma intero, perché un ritaglio sbagliato elimina il
 * soggetto mentre un fotogramma intero resta leggibile.
 */

export type PreviewFitMode = 'cover' | 'contain' | 'stretch';

export interface PreviewPhotoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CardCropDecision = 'applied_verified' | 'skipped_geometry_uncertain';

export type MappingUncertaintyReason =
  | 'invalid_dimensions'
  | 'preview_fov_mismatch'
  | 'orientation_transform_unproven'
  | 'crop_degenerate'
  | 'crop_aspect_drift';

/** Origine del campo visivo usato per la mappatura. */
export type FieldOfViewSource = 'native_stream' | 'sensor_default';

export interface PreviewPhotoMappingInput {
  /** Larghezza della view che ospita l'anteprima (dp). */
  previewWidth: number;
  /** Altezza della view che ospita l'anteprima (dp). */
  previewHeight: number;
  /** Larghezza in pixel del JPEG catturato. */
  photoWidth: number;
  /** Altezza in pixel del JPEG catturato. */
  photoHeight: number;
  overlayX: number;
  overlayY: number;
  overlayWidth: number;
  overlayHeight: number;
  /** Modalità con cui l'anteprima riempie la view (PreviewView = FILL_CENTER). */
  fitMode?: PreviewFitMode;
  /** Dimensioni reali dello stream di anteprima, note solo dal lato nativo. */
  previewStreamWidth?: number;
  previewStreamHeight?: number;
  /** Aspect ratio atteso del ritaglio (forma della cornice). */
  expectedAspectRatio?: number;
}

export interface PreviewPhotoMapping {
  /** Ritaglio in pixel foto, oppure null se la geometria è inutilizzabile. */
  rect: PreviewPhotoRect | null;
  mappingMode: PreviewFitMode | 'unknown';
  /** Fattore di scala pixel foto → dp della view. */
  previewScale: number;
  /** Pixel foto nascosti su ciascun lato orizzontale (negativo = bande vuote). */
  previewCropOffsetX: number;
  previewCropOffsetY: number;
  orientationTransformApplied: boolean;
  fovSource: FieldOfViewSource;
  cropValidated: boolean;
  cropDecision: CardCropDecision;
  uncertaintyReason: MappingUncertaintyReason | null;
}

/** Sotto questa soglia il ritaglio non ha abbastanza pixel per l'OCR. */
const MIN_CROP_EDGE_PX = 64;
/** Deriva massima fra forma del ritaglio e forma della cornice. */
const MAX_ASPECT_DRIFT = 0.18;

/**
 * CameraX associa a Preview e ImageCapture la stessa strategia 4:3 predefinita
 * e li lega alla medesima regione del sensore: quando il JPEG esce in 4:3 le
 * due superfici inquadrano la stessa scena, quindi il campo visivo
 * dell'anteprima è deducibile dal solo rapporto del JPEG.
 */
const SENSOR_DEFAULT_ASPECT = 3 / 4;
/** Tolleranza sul riconoscimento del rapporto 4:3 del sensore. */
const SENSOR_ASPECT_TOLERANCE = 0.03;

/**
 * Margine di sicurezza deliberato attorno alla cornice, applicato in pixel
 * foto: compensa lo spessore del tratto e l'arrotondamento della mappatura
 * senza tagliare i bordi stampati del biglietto.
 */
export const CARD_FRAME_SAFETY_MARGIN = 0.02;

function isPositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function uncertain(
  reason: MappingUncertaintyReason,
  partial: Partial<PreviewPhotoMapping> = {}
): PreviewPhotoMapping {
  return {
    rect: null,
    mappingMode: 'unknown',
    previewScale: 0,
    previewCropOffsetX: 0,
    previewCropOffsetY: 0,
    orientationTransformApplied: false,
    fovSource: 'sensor_default',
    cropValidated: false,
    cropDecision: 'skipped_geometry_uncertain',
    uncertaintyReason: reason,
    ...partial,
  };
}

/** Espande il rettangolo di una frazione, restando dentro i limiti della foto. */
function withSafetyMargin(
  rect: PreviewPhotoRect,
  margin: number,
  photoWidth: number,
  photoHeight: number
): PreviewPhotoRect {
  if (margin <= 0) return rect;
  const dx = (rect.width * margin) / 2;
  const dy = (rect.height * margin) / 2;
  const left = Math.max(0, rect.x - dx);
  const top = Math.max(0, rect.y - dy);
  const right = Math.min(photoWidth, rect.x + rect.width + dx);
  const bottom = Math.min(photoHeight, rect.y + rect.height + dy);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

/**
 * Traduce il rettangolo della cornice dalle coordinate della view ai pixel del
 * JPEG. Il risultato è utilizzabile per ritagliare solo quando `cropValidated`
 * è vero: negli altri casi il rettangolo resta disponibile per la diagnostica
 * ma la decisione è `skipped_geometry_uncertain`.
 */
export function mapPreviewRectToPhotoRect(
  input: PreviewPhotoMappingInput
): PreviewPhotoMapping {
  const {
    previewWidth,
    previewHeight,
    photoWidth,
    photoHeight,
    overlayX,
    overlayY,
    overlayWidth,
    overlayHeight,
  } = input;
  const fitMode: PreviewFitMode = input.fitMode ?? 'cover';

  if (
    !isPositive(previewWidth) ||
    !isPositive(previewHeight) ||
    !isPositive(photoWidth) ||
    !isPositive(photoHeight) ||
    !isPositive(overlayWidth) ||
    !isPositive(overlayHeight) ||
    !Number.isFinite(overlayX) ||
    !Number.isFinite(overlayY)
  ) {
    return uncertain('invalid_dimensions');
  }

  // Il buffer JPEG può arrivare sugli assi del sensore: se l'orientamento del
  // fotogramma non coincide con quello della view lo si porta prima nello
  // spazio di visualizzazione, poi si riportano indietro le coordinate.
  const previewIsPortrait = previewHeight >= previewWidth;
  const photoIsPortrait = photoHeight >= photoWidth;
  const orientationTransformApplied = previewIsPortrait !== photoIsPortrait;
  const displayWidth = orientationTransformApplied ? photoHeight : photoWidth;
  const displayHeight = orientationTransformApplied ? photoWidth : photoHeight;

  const displayAspect = displayWidth / displayHeight;

  // Il campo visivo dell'anteprima si conosce in due modi. Se il lato nativo
  // pubblica le dimensioni dello stream si modella la differenza rispetto allo
  // scatto; altrimenti vale la configurazione predefinita di CameraX, dove
  // anteprima e scatto condividono la strategia 4:3 sulla stessa regione del
  // sensore e il rapporto del JPEG è già il rapporto dell'anteprima.
  let fovSource: FieldOfViewSource = 'sensor_default';
  let fovProven =
    Math.abs(displayAspect - SENSOR_DEFAULT_ASPECT) <= SENSOR_ASPECT_TOLERANCE ||
    Math.abs(1 / displayAspect - SENSOR_DEFAULT_ASPECT) <= SENSOR_ASPECT_TOLERANCE;
  let fovWidthFraction = 1;
  let fovHeightFraction = 1;

  if (isPositive(input.previewStreamWidth) && isPositive(input.previewStreamHeight)) {
    const streamIsPortrait = input.previewStreamHeight >= input.previewStreamWidth;
    const streamDisplayWidth =
      streamIsPortrait === previewIsPortrait
        ? input.previewStreamWidth
        : input.previewStreamHeight;
    const streamDisplayHeight =
      streamIsPortrait === previewIsPortrait
        ? input.previewStreamHeight
        : input.previewStreamWidth;
    const streamAspect = streamDisplayWidth / streamDisplayHeight;
    fovSource = 'native_stream';
    fovProven = true;
    // Anteprima e scatto derivano dalla stessa regione di sensore: quello con
    // il rapporto più largo conserva l'intera base e taglia in altezza, e
    // viceversa. Il taglio è centrato, quindi basta la frazione di campo.
    if (streamAspect >= displayAspect) {
      fovHeightFraction = displayAspect / streamAspect;
    } else {
      fovWidthFraction = streamAspect / displayAspect;
    }
  }

  // Porzione del fotogramma che l'anteprima inquadra davvero, in pixel foto.
  const fovWidth = displayWidth * fovWidthFraction;
  const fovHeight = displayHeight * fovHeightFraction;
  const fovOffsetX = (displayWidth - fovWidth) / 2;
  const fovOffsetY = (displayHeight - fovHeight) / 2;

  const scaleX = previewWidth / fovWidth;
  const scaleY = previewHeight / fovHeight;
  const uniformScale =
    fitMode === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const sx = fitMode === 'stretch' ? scaleX : uniformScale;
  const sy = fitMode === 'stretch' ? scaleY : uniformScale;

  // Porzione inquadrata che la view non mostra su ciascun lato. Con `cover` è
  // positiva (bordi tagliati), con `contain` è negativa (bande vuote): la
  // stessa formula copre entrambi i casi.
  const hiddenX = (fovWidth * sx - previewWidth) / 2 / sx;
  const hiddenY = (fovHeight * sy - previewHeight) / 2 / sy;

  const displayRect: PreviewPhotoRect = {
    x: overlayX / sx + hiddenX + fovOffsetX,
    y: overlayY / sy + hiddenY + fovOffsetY,
    width: overlayWidth / sx,
    height: overlayHeight / sy,
  };

  // Ritorno allo spazio pixel del JPEG. La convenzione è una rotazione di 90°
  // in senso orario dal buffer alla visualizzazione; la direzione non è però
  // verificabile dal lato JS, per questo il caso ruotato non viene mai validato.
  const photoRect: PreviewPhotoRect = orientationTransformApplied
    ? {
        x: displayRect.y,
        y: photoHeight - (displayRect.x + displayRect.width),
        width: displayRect.height,
        height: displayRect.width,
      }
    : displayRect;

  // Il rettangolo resta dentro la foto: la cornice è disegnata dentro
  // l'anteprima, quindi eventuali sforamenti sono solo arrotondamenti.
  const left = Math.max(0, Math.min(photoRect.x, photoWidth));
  const top = Math.max(0, Math.min(photoRect.y, photoHeight));
  const right = Math.min(photoWidth, Math.max(left, photoRect.x + photoRect.width));
  const bottom = Math.min(photoHeight, Math.max(top, photoRect.y + photoRect.height));
  const clamped: PreviewPhotoRect = {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
  const rect = withSafetyMargin(
    clamped,
    CARD_FRAME_SAFETY_MARGIN,
    photoWidth,
    photoHeight
  );

  const base = {
    rect,
    mappingMode: fitMode,
    previewScale: uniformScale,
    previewCropOffsetX: hiddenX,
    previewCropOffsetY: hiddenY,
    orientationTransformApplied,
    fovSource,
  };

  if (!fovProven) {
    return uncertain('preview_fov_mismatch', base);
  }

  // Il chiamante normalizza il bitmap sugli assi di visualizzazione prima di
  // mappare: se qui gli assi ancora divergono la rotazione non è stata
  // applicata e la direzione del giro non è deducibile dal lato JS.
  if (orientationTransformApplied) {
    return uncertain('orientation_transform_unproven', base);
  }

  if (rect.width < MIN_CROP_EDGE_PX || rect.height < MIN_CROP_EDGE_PX) {
    return uncertain('crop_degenerate', base);
  }

  if (isPositive(input.expectedAspectRatio)) {
    const drift =
      Math.abs(rect.width / rect.height - input.expectedAspectRatio) /
      input.expectedAspectRatio;
    if (drift > MAX_ASPECT_DRIFT) {
      return uncertain('crop_aspect_drift', base);
    }
  }

  return {
    ...base,
    cropValidated: true,
    cropDecision: 'applied_verified',
    uncertaintyReason: null,
  };
}