import TextRecognition, { TextRecognitionScript } from '@react-native-ml-kit/text-recognition';
import { OcrLine, OcrQualityMetadata } from '../types';
import { getImageSize, prepareFocusedOcrBinaryRegion, prepareFocusedOcrHighContrastRegion, prepareFocusedOcrRegion, rotateImage } from './image-utils';
import { normalizeOcrText } from './ocr-normalize';
import { resolveImageUri } from './image-uri';
import type { OperationLease } from './guarded-operation';
import { runTimedOperation } from './guarded-operation';
import { runOcrNativeTask } from './ocr-native-concurrency';
import { cleanupTemporaryImageUri } from './temporary-image-cleanup';
import {
  assessOcrQuality,
  createProviderOcrLine,
  emptyOcrQuality,
} from './ocr-quality';
import { runtimeLogger } from './safe-runtime-logger';
import { hasSubstantiveCjkEvidence } from './ocr-script-gate';
import { chooseFocusedEmail, chooseFocusedEmailConsensus, chooseFocusedEmailHostConsensus, coalesceObservedSplitEmailRows, firstEmailToken, isPotentialEmailRow, replaceEmailTokenInLine, shouldDeepRefineObservedEmail } from './ocr-email-refinement';
import { chooseFocusedCriticalRow, criticalBusinessCardRowKind } from './ocr-critical-row-refinement';
import {
  beginBusinessCardOcrQaSession,
  saveBusinessCardOcrAttempt,
  saveBusinessCardCjkOcrAttempt,
  saveBusinessCardCjkOcrFailure,
  saveBusinessCardOcrSummary,
  type BusinessCardOcrQaSession,
} from './business-card-ocr-artifacts';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;
const ROLE_REGEX =
  /\b(ceo|cto|cfo|coo|manager|director|engineer|developer|president|founder|consulente|direttore|responsabile|amministratore)\b/i;

/** Evita overlay bloccato se ML Kit non risponde su JPEG pesanti. */
const DOCUMENT_OCR_TIMEOUT_MS = 25_000;
/** Budget globale del percorso OCR per un singolo biglietto. */
export const BUSINESS_CARD_OCR_TIMEOUT_MS = 9_000;
const MIN_OCR_IMAGE_EDGE_PX = 32;

/**
 * Un file con un lato di pochi pixel e' il risultato di una rotazione/crop
 * non valida: non deve arrivare a ML Kit ne' sostituire il risultato buono.
 */
export function isOcrImageDimensionEligible(
  size: { width: number; height: number } | undefined,
): boolean {
  if (!size) return true;
  return Number.isFinite(size.width) && Number.isFinite(size.height)
    && size.width >= MIN_OCR_IMAGE_EDGE_PX
    && size.height >= MIN_OCR_IMAGE_EDGE_PX;
}

async function isOcrImageEligible(imageUri: string, angle: number): Promise<boolean> {
  const size = await getImageSize(imageUri).catch(() => undefined);
  if (isOcrImageDimensionEligible(size)) return true;
  runtimeLogger.warn('OCR_INPUT_REJECTED_DEGENERATE_IMAGE', undefined, {
    status: 'rejected', stage: 'read', source: 'local', angle,
    width: size?.width ?? -1, height: size?.height ?? -1,
  });
  traceOcr('input_rejected_degenerate', {
    angle, width: size?.width ?? -1, height: size?.height ?? -1,
  });
  return false;
}

function traceOcr(step: string, detail?: Record<string, string | number | boolean>): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__ === false) return;
  console.warn(`[SCAN] ocr:${step}`, detail ? JSON.stringify(detail) : '');
}

export interface OcrScanResult {
  lines: OcrLine[];
  text: string;
  quality: OcrQualityMetadata;
  /** Email confermate identiche da almeno due rotazioni OCR indipendenti. */
  multiAngleConfirmedEmails?: string[];
  rotationDegrees?: 0 | 90 | 180 | 270;
  ocrCanvasWidth?: number;
  ocrCanvasHeight?: number;
}

export interface OcrEmailFocusedDiagnostic {
  variant: string;
  text: string;
  email: string | null;
}

export interface OcrEmailRefinementDiagnostic {
  observedLine: string;
  observedEmail: string | null;
  boundingBox?: { x: number; y: number; width: number; height: number };
  focused: OcrEmailFocusedDiagnostic[];
  consensus: { observed: string | null; selected: string | null; changed: boolean; votes: number };
  hostFocused: OcrEmailFocusedDiagnostic[];
  hostConsensus?: { observed: string | null; selected: string | null; changed: boolean; votes: number };
}

const emailRefinementDiagnostics: OcrEmailRefinementDiagnostic[] = [];

export function clearOcrEmailRefinementDiagnostics(): void {
  emailRefinementDiagnostics.length = 0;
}

export function consumeOcrEmailRefinementDiagnostics(): OcrEmailRefinementDiagnostic[] {
  const snapshot = emailRefinementDiagnostics.map((item) => ({
    ...item,
    ...(item.boundingBox ? { boundingBox: { ...item.boundingBox } } : {}),
    focused: item.focused.map((entry) => ({ ...entry })),
    hostFocused: item.hostFocused.map((entry) => ({ ...entry })),
    consensus: { ...item.consensus },
    ...(item.hostConsensus ? { hostConsensus: { ...item.hostConsensus } } : {}),
  }));
  emailRefinementDiagnostics.length = 0;
  return snapshot;
}

function recordEmailRefinementDiagnostic(item: OcrEmailRefinementDiagnostic): void {
  // Diagnostic only: bounded in-memory buffer, consumed by the hidden QA gate.
  if (emailRefinementDiagnostics.length >= 32) emailRefinementDiagnostics.shift();
  emailRefinementDiagnostics.push(item);
}

function sortLinesReadingOrder(lines: OcrLine[]): OcrLine[] {
  if (lines.length < 2) return lines;
  if (lines.some((l) => !l.boundingBox || typeof l.boundingBox.y !== 'number')) {
    return [...lines].sort((a, b) => {
      const ay = a.boundingBox?.y ?? 0;
      const by = b.boundingBox?.y ?? 0;
      if (Math.abs(ay - by) > 12) return ay - by;
      return (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0);
    });
  }

  const Y_TOL = 16;
  const byY = [...lines].sort((a, b) => (a.boundingBox?.y ?? 0) - (b.boundingBox?.y ?? 0));
  const rows: OcrLine[][] = [];
  for (const line of byY) {
    const y = line.boundingBox?.y ?? 0;
    let target: OcrLine[] | undefined;
    for (const row of rows) {
      const ry = row[0].boundingBox?.y ?? 0;
      if (Math.abs(ry - y) <= Y_TOL) {
        target = row;
        break;
      }
    }
    if (target) target.push(line);
    else rows.push([line]);
  }

  return rows
    .sort((a, b) => (a[0].boundingBox?.y ?? 0) - (b[0].boundingBox?.y ?? 0))
    .flatMap((row) => row.sort((a, b) => (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0)));
}

function buildRawText(result: Awaited<ReturnType<typeof TextRecognition.recognize>>, lines: OcrLine[]): string {
  // IMPORTANTE: NON usare result.text di ML Kit come fonte primaria. ML Kit
  // concatena i blocchi di testo nell'ordine in cui li ha RILEVATI, che non è
  // quello spaziale: su alcuni biglietti le righe uscivano dal basso verso
  // l'alto, mandando in tilt tutto il parsing (ruolo, azienda, ecc.).
  // Ricostruiamo sempre il testo dalle righe ordinate per posizione reale
  // (dall'alto in basso, da sinistra a destra), come si legge in Italia.
  const ordered = sortLinesReadingOrder(lines)
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join('\n');
  if (ordered) return normalizeOcrText(ordered);
  return normalizeOcrText(result.text?.trim() ?? '');
}

/** ML Kit accetta formati URI diversi a seconda del device Android. */
function ocrUriCandidates(imageUri: string): string[] {
  const normalized = resolveImageUri(imageUri);
  const candidates = new Set<string>();

  // ML Kit Android richiede un URI con schema. Un path assoluto passato come
  // prima alternativa viene interpretato come content URI e produce
  // "No content provider: /data/user/...". Proviamo prima la forma canonica
  // e non inviamo mai il path grezzo al bridge nativo.
  for (const uri of [normalized, imageUri]) {
    if (!uri) continue;
    if (uri.startsWith('/')) {
      candidates.add(`file://${uri}`);
      continue;
    }
    candidates.add(uri);
    if (uri.startsWith('file://')) {
      const decoded = decodeURI(uri);
      if (decoded !== uri) candidates.add(decoded);
    }
  }

  return [...candidates];
}

async function recognizeOnce(
  imageUri: string,
  isActive: () => boolean = () => true,
  script?: TextRecognitionScript,
): Promise<OcrScanResult> {
  const candidates = ocrUriCandidates(imageUri).slice(0, 2);
  for (const candidate of candidates) {
    if (!isActive()) {
      return { lines: [], text: '', quality: emptyOcrQuality() };
    }
    traceOcr('recognize_begin', { candidate: candidate.slice(-48) });
    try {
      const gated = await runOcrNativeTask(
        () => script === undefined
          ? TextRecognition.recognize(candidate)
          : TextRecognition.recognize(candidate, script),
        isActive
      );
      if (gated.status === 'failed') throw gated.error;
      if (gated.status !== 'completed') {
        traceOcr('recognize_skip', { status: gated.status });
        return { lines: [], text: '', quality: emptyOcrQuality() };
      }
      const result = gated.value;
      traceOcr('recognize_done', {
        blocks: Array.isArray(result?.blocks) ? result.blocks.length : 0,
      });
      if (!result || !Array.isArray(result.blocks)) continue;

      const lines = sortLinesReadingOrder(
        result.blocks.flatMap((block, blockIndex) =>
          (block?.lines ?? []).map((line, lineIndex) => ({
            ...createProviderOcrLine({
              text: line?.text,
              confidence: (
                line as unknown as { confidence?: unknown } | null | undefined
              )?.confidence,
              boundingBox: line?.frame
                ? {
                    x: line.frame.left ?? 0,
                    y: line.frame.top ?? 0,
                    width: line.frame.width ?? 0,
                    height: line.frame.height ?? 0,
                  }
                : undefined,
            }),
            blockIndex,
            lineIndex,
            elements: (line?.elements ?? []).map((element, elementIndex) => ({
              text: element?.text?.trim() ?? '',
              elementIndex,
              ...(element?.frame ? { boundingBox: {
                x: element.frame.left ?? 0,
                y: element.frame.top ?? 0,
                width: element.frame.width ?? 0,
                height: element.frame.height ?? 0,
              } } : {}),
            })).filter((element) => element.text.length > 0),
          }))
        )
      );
      const text = buildRawText(result, lines);
      if (text.trim() || lines.length > 0) {
        return {
          lines,
          text,
          quality: assessOcrQuality(lines, text, { source: 'local' }),
        };
      }
    } catch (error) {
      traceOcr('recognize_failed', {
        message: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
      });
      if (isActive()) {
        runtimeLogger.warn('OCR_CANDIDATE_FAILED', error, {
          status: 'failed',
          stage: 'read',
          source: 'local',
        });
      }
    }
  }

  return { lines: [], text: '', quality: emptyOcrQuality() };
}



const BUSINESS_CARD_EXTRA_SCRIPTS = [
  { script: TextRecognitionScript.CHINESE, qaLabel: 'chinese' as const },
  { script: TextRecognitionScript.JAPANESE, qaLabel: 'japanese' as const },
  { script: TextRecognitionScript.KOREAN, qaLabel: 'korean' as const },
] as const;

function normalizedOcrLineKey(line: OcrLine): string {
  return normalizeOcrText(line.text).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function keepSubstantiveCjkLines(result: OcrScanResult): OcrScanResult {
  const lines = result.lines.filter((line) => hasSubstantiveCjkEvidence(line.text));
  const text = normalizeOcrText(lines.map((line) => line.text.trim()).filter(Boolean).join('\n'));
  return {
    ...result,
    lines,
    text,
    quality: assessOcrQuality(lines, text, { source: 'local' }),
  };
}

function mergeOcrResults(primary: OcrScanResult, extras: readonly OcrScanResult[]): OcrScanResult {
  const seen = new Set<string>();
  const merged: OcrLine[] = [];
  for (const line of primary.lines) {
    const key = normalizedOcrLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  for (const extra of extras) {
    for (const line of extra.lines) {
      const key = normalizedOcrLineKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
  }
  const ordered = sortLinesReadingOrder(merged);
  const text = normalizeOcrText(ordered.map((line) => line.text.trim()).filter(Boolean).join('\n'));
  return {
    ...primary,
    lines: ordered,
    text,
    quality: assessOcrQuality(ordered, text, { source: 'local' }),
  };
}

function scoreGenericOcr(lines: OcrLine[], text: string): number {
  let score = lines.length * 5 + Math.min(text.length, 800) / 10;
  for (const line of lines) {
    const bb = line.boundingBox;
    if (!bb || bb.width < 6) continue;
    const ratio = bb.width / Math.max(bb.height ?? 1, 1);
    if (ratio >= 1.05) score += ratio * 2;
  }
  return score;
}

const GENERIC_EMAIL_LOCAL_RE = /^(?:info|sales|contact|office|admin|support|hello|mail|marketing|commerciale|segreteria)$/i;

function missingPersonalEmailToken(primary: OcrScanResult): string | null {
  const matches = primary.text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  for (const email of matches) {
    const local = email.split('@')[0] ?? '';
    const token = local.split(/[._+\-]+/).find((part) => part.length >= 4 && !GENERIC_EMAIL_LOCAL_RE.test(part));
    if (!token) continue;
    const key = compactConsensusKey(token);
    const alreadyObserved = primary.lines.some((line) => {
      if (line.text.includes('@')) return false;
      return compactConsensusKey(line.text).includes(key);
    });
    if (!alreadyObserved) return token;
  }
  return null;
}

/**
 * Recupera una riga identità completamente saltata dall'OCR principale solo
 * quando contiene letteralmente un token personale già osservato nella email.
 * La rilettura non può quindi introdurre un nome privo di evidenza sulla card.
 */
export function mergeMissingEmailIdentityLines(
  primary: OcrScanResult,
  extra: OcrScanResult,
): OcrScanResult {
  const token = missingPersonalEmailToken(primary);
  if (!token) return primary;
  const tokenKey = compactConsensusKey(token);
  const additions = extra.lines.filter((line) => {
    if (/@|www\.|https?:|\d{4,}/i.test(line.text)) return false;
    const words = line.text.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 5) return false;
    return words.some((word) => compactConsensusKey(word) === tokenKey);
  });
  if (!additions.length) return primary;
  const existing = new Set(primary.lines.map((line) => compactConsensusKey(line.text)));
  const safeAdditions = additions
    .filter((line) => !existing.has(compactConsensusKey(line.text)))
    .map((line) => ({ ...line, boundingBox: undefined, elements: undefined }));
  if (!safeAdditions.length) return primary;
  const lines = [...safeAdditions, ...primary.lines];
  const text = normalizeOcrText(lines.map((line) => line.text.trim()).filter(Boolean).join('\n'));
  return {
    ...primary,
    lines,
    text,
    quality: assessOcrQuality(lines, text, { source: 'local' }),
  };
}

async function recoverMissingEmailIdentityFromPixels(
  imageUri: string,
  primary: OcrScanResult,
  operation?: OperationLease,
): Promise<OcrScanResult> {
  if (!missingPersonalEmailToken(primary) || (operation && !operation.isActive())) return primary;
  let orientedUri = imageUri;
  let contrastUri: string | null = null;
  let orientedTemporary = false;
  try {
    const angle = primary.rotationDegrees ?? 0;
    if (angle !== 0) {
      orientedUri = await rotateImage(imageUri, angle);
      orientedTemporary = orientedUri !== imageUri;
    }
    const size = await getImageSize(orientedUri);
    contrastUri = await prepareFocusedOcrHighContrastRegion(
      orientedUri,
      { x: 0, y: 0, width: size.width, height: size.height },
      Math.max(2400, size.width),
    );
    const extra = await recognizeOnce(contrastUri, () => !operation || operation.isActive());
    return mergeMissingEmailIdentityLines(primary, extra);
  } catch (error) {
    if (!operation || operation.isActive()) {
      runtimeLogger.warn('OCR_MISSING_IDENTITY_REFINE_FAILED', error, {
        status: 'failed', stage: 'read', source: 'local',
      });
    }
    return primary;
  } finally {
    if (contrastUri) void cleanupTemporaryImageUri(contrastUri).catch(() => undefined);
    if (orientedTemporary) void cleanupTemporaryImageUri(orientedUri).catch(() => undefined);
  }
}

async function findBestCjkFallback(
  imageUri: string,
  operation?: OperationLease,
  qaSession?: BusinessCardOcrQaSession | null,
): Promise<OcrScanResult> {
  let best: OcrScanResult = { lines: [], text: '', quality: emptyOcrQuality(), rotationDegrees: 0 };
  let bestScore = -1;
  for (const angle of DOCUMENT_OCR_ANGLES) {
    if (operation && !operation.isActive()) break;
    let attemptUri = imageUri;
    try {
      attemptUri = angle === 0 ? imageUri : await rotateImage(imageUri, angle);
      if (!(await isOcrImageEligible(attemptUri, angle))) continue;
      const extras: OcrScanResult[] = [];
      for (const candidate of BUSINESS_CARD_EXTRA_SCRIPTS) {
        if (operation && !operation.isActive()) break;
        try {
          const result = await recognizeOnce(
            attemptUri,
            () => !operation || operation.isActive(),
            candidate.script,
          );
          await saveBusinessCardCjkOcrAttempt(
            qaSession ?? null,
            candidate.qaLabel,
            angle,
            result.text,
          );
          if (result.text.trim() || result.lines.length > 0) extras.push(result);
        } catch (error) {
          await saveBusinessCardCjkOcrFailure(
            qaSession ?? null,
            candidate.qaLabel,
            angle,
          );
          if (!operation || operation.isActive()) {
            runtimeLogger.warn('OCR_CJK_ANGLE_FAILED', error, {
              status: 'failed',
              stage: 'read',
              source: 'local',
              angle,
            });
          }
        }
      }
      const merged = mergeOcrResults({
        lines: [],
        text: '',
        quality: emptyOcrQuality(),
        rotationDegrees: angle,
      }, extras);
      const score = scoreGenericOcr(merged.lines, merged.text);
      if (score > bestScore) {
        const size = await getImageSize(attemptUri).catch(() => undefined);
        best = {
          ...merged,
          rotationDegrees: angle,
          ...(size ? { ocrCanvasWidth: size.width, ocrCanvasHeight: size.height } : {}),
        };
        bestScore = score;
      }
    } catch (error) {
      // Un singolo orientamento non deve annullare un risultato CJK valido
      // gia trovato su un altro angolo. Fail closed per questo tentativo e
      // continua con gli altri candidati.
      if (!operation || operation.isActive()) {
        runtimeLogger.warn('OCR_CJK_ANGLE_FAILED', error, {
          status: 'failed',
          stage: 'read',
          source: 'local',
          angle,
        });
      }
    } finally {
      if (angle !== 0 && attemptUri !== imageUri) {
        void cleanupTemporaryImageUri(attemptUri).catch(() => undefined);
      }
    }
  }
  return best;
}

async function augmentBusinessCardWithExtraScripts(
  imageUri: string,
  primary: OcrScanResult,
  operation?: OperationLease,
  qaSession?: BusinessCardOcrQaSession | null,
): Promise<OcrScanResult> {
  if (operation && !operation.isActive()) return primary;

  if (!primary.text.trim() && primary.lines.length === 0) {
    return await findBestCjkFallback(imageUri, operation, qaSession);
  }

  // Un biglietto latino gia ricco non deve avviare tre recognizer aggiuntivi.
  // Il fallback CJK resta attivo per OCR vuoto/debole o glifi CJK osservati.
  const hasObservedCjk = primary.lines.some((line) =>
    hasSubstantiveCjkEvidence(line.text)
  );
  const latinLooksIncomplete =
    primary.lines.filter((line) => line.text.trim().length >= 2).length <= 3 ||
    primary.text.trim().length < 80;
  if (!hasObservedCjk && !latinLooksIncomplete) return primary;

  let scriptUri = imageUri;
  let temporary = false;
  try {
    const angle = primary.rotationDegrees ?? 0;
    if (angle !== 0) {
      scriptUri = await rotateImage(imageUri, angle);
      temporary = scriptUri !== imageUri;
    }
    if (!(await isOcrImageEligible(scriptUri, angle))) return primary;
    const extras: OcrScanResult[] = [];
    for (const candidate of BUSINESS_CARD_EXTRA_SCRIPTS) {
      if (operation && !operation.isActive()) break;
      try {
        const extra = await recognizeOnce(
          scriptUri,
          () => !operation || operation.isActive(),
          candidate.script,
        );
        await saveBusinessCardCjkOcrAttempt(
          qaSession ?? null,
          candidate.qaLabel,
          angle,
          extra.text,
        );
        const gatedExtra = keepSubstantiveCjkLines(extra);
        if (gatedExtra.text.trim() || gatedExtra.lines.length > 0) extras.push(gatedExtra);
      } catch (error) {
        await saveBusinessCardCjkOcrFailure(
          qaSession ?? null,
          candidate.qaLabel,
          angle,
        );
        if (!operation || operation.isActive()) {
          runtimeLogger.warn('OCR_CJK_ANGLE_FAILED', error, {
            status: 'failed',
            stage: 'read',
            source: 'local',
            angle,
          });
        }
      }
    }
    return mergeOcrResults(primary, extras);
  } finally {
    if (temporary) void cleanupTemporaryImageUri(scriptUri).catch(() => undefined);
  }
}

async function refineBusinessCardEmailRows(
  imageUri: string,
  primary: OcrScanResult,
  operation?: OperationLease,
): Promise<OcrScanResult> {
  // Ricomponiamo soltanto split realmente osservati su due righe.
  const seededLines = coalesceObservedSplitEmailRows(primary.lines);
  const seededText = normalizeOcrText(seededLines.map((line) => line.text.trim()).filter(Boolean).join('\n'));
  const seededPrimary: OcrScanResult = seededLines.length === primary.lines.length && seededText === primary.text
    ? primary
    : {
        ...primary,
        lines: seededLines,
        text: seededText,
        quality: assessOcrQuality(seededLines, seededText, { source: 'local' }),
      };

  const candidates = seededPrimary.lines.filter((line) => isPotentialEmailRow(line.text) && line.boundingBox);
  if (!candidates.length || (operation && !operation.isActive())) return seededPrimary;

  let orientedUri = imageUri;
  let orientedTemporary = false;
  try {
    const angle = seededPrimary.rotationDegrees ?? 0;
    if (angle !== 0) {
      orientedUri = await rotateImage(imageUri, angle);
      orientedTemporary = orientedUri !== imageUri;
    }

    let changed = seededPrimary !== primary;
    const lines = seededPrimary.lines.map((line) => ({ ...line }));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isPotentialEmailRow(line.text) || !line.boundingBox) continue;
      if (operation && !operation.isActive()) break;

      try {
        const observed = firstEmailToken(line.text);

        // Il consenso fra rotazioni legge gli stessi pixel in orientamenti
        // indipendenti. Se almeno due angoli hanno gia' confermato esattamente
        // la mailbox, non lanciamo altre 9-12 riletture focalizzate: oltre a
        // essere lente possono degradare un valore corretto (es. libero.it).
        const confirmedByAngles = Boolean(
          observed && seededPrimary.multiAngleConfirmedEmails?.includes(observed.toLowerCase()),
        );
        if (confirmedByAngles) continue;

        // V21 PERFORMANCE + SAFETY:
        // se il full-card OCR ha gia' una email business valida, non la sottoponiamo
        // a 7-9 OCR addizionali. E' proprio questo che in V18/V19 poteva troncare
        // local-part corretti e in V20 ha portato il gate oltre 12 minuti.
        // Il deep reread resta attivo per provider personali comuni, dove manca
        // normalmente una seconda evidenza di dominio (es. sito aziendale).
        if (observed && !shouldDeepRefineObservedEmail(line.text)) continue;

        if (!observed) {
          // Riga email incompleta: percorso economico e progressivo, primo risultato
          // valido vince. Nessuna correzione semantica viene inventata.
          const normalWidths = [1600, 2800] as const;
          let accepted = false;
          for (const targetWidth of normalWidths) {
            let focusedUri: string | null = null;
            try {
              focusedUri = await prepareFocusedOcrRegion(orientedUri, line.boundingBox, targetWidth);
              const focused = await recognizeOnce(focusedUri, () => !operation || operation.isActive());
              const decision = chooseFocusedEmail(line.text, focused.text);
              if (decision.changed && decision.selected) {
                line.text = replaceEmailTokenInLine(line.text, decision.observed, decision.selected);
                changed = true;
                accepted = true;
                break;
              }
            } finally {
              if (focusedUri) void cleanupTemporaryImageUri(focusedUri).catch(() => undefined);
            }
          }
          if (!accepted) {
            let contrastUri: string | null = null;
            try {
              contrastUri = await prepareFocusedOcrHighContrastRegion(orientedUri, line.boundingBox, 2600);
              const focused = await recognizeOnce(contrastUri, () => !operation || operation.isActive());
              const decision = chooseFocusedEmail(line.text, focused.text);
              if (decision.changed && decision.selected) {
                line.text = replaceEmailTokenInLine(line.text, decision.observed, decision.selected);
                changed = true;
              }
            } finally {
              if (contrastUri) void cleanupTemporaryImageUri(contrastUri).catch(() => undefined);
            }
          }
          continue;
        }

        // Email personale gia' valida: per cambiare l'host richiediamo consenso
        // di almeno due riletture indipendenti dei pixel. Il local-part non puo'
        // cambiare (chooseFocusedEmail fail-closed).
        const focusedTexts: string[] = [];
        const focusedDiagnostics: OcrEmailFocusedDiagnostic[] = [];
        const recordFocused = (variant: string, text: string) => {
          focusedTexts.push(text);
          focusedDiagnostics.push({
            variant,
            text: text.replace(/\s+/g, ' ').trim(),
            email: firstEmailToken(text),
          });
        };

        for (const targetWidth of [1600, 2800] as const) {
          let focusedUri: string | null = null;
          try {
            focusedUri = await prepareFocusedOcrRegion(orientedUri, line.boundingBox, targetWidth);
            const focused = await recognizeOnce(focusedUri, () => !operation || operation.isActive());
            recordFocused(`normal-${targetWidth}`, focused.text);
          } finally {
            if (focusedUri) void cleanupTemporaryImageUri(focusedUri).catch(() => undefined);
          }
        }

        let contrastUri: string | null = null;
        try {
          contrastUri = await prepareFocusedOcrHighContrastRegion(orientedUri, line.boundingBox, 2600);
          const focused = await recognizeOnce(contrastUri, () => !operation || operation.isActive());
          recordFocused('contrast-2600', focused.text);
        } finally {
          if (contrastUri) void cleanupTemporaryImageUri(contrastUri).catch(() => undefined);
        }

        // Le varianti costose vengono eseguite SOLO per questa classe ristretta
        // di mailbox personali. Quattro soglie + due morfologie danno piu'
        // letture del glifo senza rallentare tutte le email business del corpus.
        for (const thresholdBias of [-28, -14, 14, 28] as const) {
          let binaryUri: string | null = null;
          try {
            binaryUri = await prepareFocusedOcrBinaryRegion(orientedUri, line.boundingBox, 2800, thresholdBias, 'none');
            const focused = await recognizeOnce(binaryUri, () => !operation || operation.isActive());
            recordFocused(`binary-${thresholdBias}`, focused.text);
          } finally {
            if (binaryUri) void cleanupTemporaryImageUri(binaryUri).catch(() => undefined);
          }
        }
        for (const morphology of ['thicken', 'thin'] as const) {
          let morphologyUri: string | null = null;
          try {
            morphologyUri = await prepareFocusedOcrBinaryRegion(orientedUri, line.boundingBox, 2800, 0, morphology);
            const focused = await recognizeOnce(morphologyUri, () => !operation || operation.isActive());
            recordFocused(`morph-${morphology}`, focused.text);
          } finally {
            if (morphologyUri) void cleanupTemporaryImageUri(morphologyUri).catch(() => undefined);
          }
        }

        const consensus = chooseFocusedEmailConsensus(line.text, focusedTexts, 2);
        const hostFocusedDiagnostics: OcrEmailFocusedDiagnostic[] = [];
        let hostConsensus: { observed: string | null; selected: string | null; changed: boolean; votes: number } | undefined;

        const observedHostConfirmedByWholeLine =
          !consensus.changed &&
          Boolean(observed) &&
          consensus.selected === observed &&
          consensus.votes >= 2;

        if (consensus.changed && consensus.selected) {
          line.text = replaceEmailTokenInLine(line.text, consensus.observed, consensus.selected);
          changed = true;
          runtimeLogger.debug('OCR_EMAIL_ROW_REFINED', undefined, {
            status: 'completed',
            stage: 'read',
            source: 'local',
            variant: 'personal_mail_consensus',
            count: consensus.votes,
          });
        } else if (!observedHostConfirmedByWholeLine && observed && line.boundingBox) {
          // V23/V25: reread ONLY host pixels after whole-line consensus fails.
          // V25 also persists every optical reading into the hidden QA result,
          // so a real-device failure is diagnosable without relying on Metro logs.
          const lowerLine = line.text.toLowerCase();
          const emailIndex = lowerLine.indexOf(observed.toLowerCase());
          const atInEmail = observed.indexOf('@');
          if (emailIndex >= 0 && atInEmail > 0) {
            const startChar = emailIndex + atInEmail + 1;
            const ratio = Math.max(0, Math.min(0.92, startChar / Math.max(1, line.text.length)));
            const hostBox = {
              x: line.boundingBox.x + line.boundingBox.width * ratio,
              y: line.boundingBox.y,
              width: Math.max(8, line.boundingBox.width * (1 - ratio)),
              height: line.boundingBox.height,
            };
            const hostTexts: string[] = [];
            const recordHost = (variant: string, text: string) => {
              hostTexts.push(text);
              hostFocusedDiagnostics.push({
                variant,
                text: text.replace(/\s+/g, ' ').trim(),
                email: firstEmailToken(text),
              });
            };
            for (const targetWidth of [1400, 2200] as const) {
              let hostUri: string | null = null;
              try {
                hostUri = await prepareFocusedOcrRegion(orientedUri, hostBox, targetWidth);
                const focusedHost = await recognizeOnce(hostUri, () => !operation || operation.isActive());
                recordHost(`host-normal-${targetWidth}`, focusedHost.text);
              } finally {
                if (hostUri) void cleanupTemporaryImageUri(hostUri).catch(() => undefined);
              }
            }
            let hostContrastUri: string | null = null;
            try {
              hostContrastUri = await prepareFocusedOcrHighContrastRegion(orientedUri, hostBox, 2200);
              const focusedHost = await recognizeOnce(hostContrastUri, () => !operation || operation.isActive());
              recordHost('host-contrast-2200', focusedHost.text);
            } finally {
              if (hostContrastUri) void cleanupTemporaryImageUri(hostContrastUri).catch(() => undefined);
            }
            hostConsensus = chooseFocusedEmailHostConsensus(line.text, hostTexts, 2);
            if (hostConsensus.changed && hostConsensus.selected) {
              line.text = replaceEmailTokenInLine(line.text, hostConsensus.observed, hostConsensus.selected);
              changed = true;
              runtimeLogger.debug('OCR_EMAIL_ROW_REFINED', undefined, {
                status: 'completed',
                stage: 'read',
                source: 'local',
                variant: 'personal_mail_host_only_consensus',
                count: hostConsensus.votes,
              });
            }
          }
        }

        recordEmailRefinementDiagnostic({
          observedLine: seededPrimary.lines[i]?.text ?? line.text,
          observedEmail: observed,
          ...(line.boundingBox ? { boundingBox: { ...line.boundingBox } } : {}),
          focused: focusedDiagnostics,
          consensus,
          hostFocused: hostFocusedDiagnostics,
          ...(hostConsensus ? { hostConsensus } : {}),
        });
      } catch (error) {
        if (!operation || operation.isActive()) {
          runtimeLogger.warn('OCR_EMAIL_ROW_REFINE_FAILED', error, {
            status: 'failed',
            stage: 'read',
            source: 'local',
          });
        }
      }
    }

    if (!changed) return seededPrimary;
    const ordered = sortLinesReadingOrder(lines);
    const text = normalizeOcrText(ordered.map((line) => line.text.trim()).filter(Boolean).join('\n'));
    return {
      ...seededPrimary,
      lines: ordered,
      text,
      quality: assessOcrQuality(ordered, text, { source: 'local' }),
    };
  } finally {
    if (orientedTemporary) void cleanupTemporaryImageUri(orientedUri).catch(() => undefined);
  }
}

async function refineBusinessCardCriticalRows(
  imageUri: string,
  primary: OcrScanResult,
  operation?: OperationLease,
): Promise<OcrScanResult> {
  const contextualText = (lines: typeof primary.lines, index: number): string => {
    const current = lines[index]?.text ?? '';
    if (criticalBusinessCardRowKind(current)) return current;
    const previous = lines[index - 1]?.text.trim() ?? '';
    if (/^(?:tel(?:efono|ephone)?|phone|ph\.?|fax|telefax|mob(?:ile)?\.?|cell(?:ulare)?\.?)\s*:?$/iu.test(previous)) {
      return `${previous} ${current}`;
    }
    // P.I. viene spesso letto come "PL" quando etichetta e numero finiscono
    // su due righe distinte.
    if (/^(?:p[il1]|p\.?\s*i(?:va)?|partita\s+iva|vat|c\.?\s*f\.?|codice\s+fiscale)\s*:?$/iu.test(previous)) {
      return `P.I. ${current}`;
    }
    return current;
  };
  const candidateIndices = primary.lines
    .map((line, index) => ({ line, index, kind: criticalBusinessCardRowKind(contextualText(primary.lines, index)) }))
    .filter((entry) => entry.kind && entry.line.boundingBox)
    .slice(0, 6)
    .map((entry) => entry.index);
  if (!candidateIndices.length || (operation && !operation.isActive())) return primary;

  let orientedUri = imageUri;
  let orientedTemporary = false;
  try {
    const angle = primary.rotationDegrees ?? 0;
    if (angle !== 0) {
      orientedUri = await rotateImage(imageUri, angle);
      orientedTemporary = orientedUri !== imageUri;
    }

    let changed = false;
    const lines = primary.lines.map((line) => ({ ...line }));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!candidateIndices.includes(i)) continue;
      const decisionInput = contextualText(lines, i);
      const kind = criticalBusinessCardRowKind(decisionInput);
      if (!kind || !line.boundingBox) continue;
      if (operation && !operation.isActive()) break;

      try {
        for (const targetWidth of [1800, 3000] as const) {
          let focusedUri: string | null = null;
          try {
            focusedUri = await prepareFocusedOcrRegion(orientedUri, line.boundingBox, targetWidth);
            const focused = await recognizeOnce(
              focusedUri,
              () => !operation || operation.isActive(),
            );
            const decision = chooseFocusedCriticalRow(decisionInput, focused.text);
            if (decision.changed && decision.selected) {
              let selected = decision.selected;
              if (kind === 'phone' && !/^\s*(?:tel(?:efono|ephone)?\.?|phone|ph\.?|fax|telefax|mob(?:ile)?\.?|cell(?:ulare)?\.?|t|f)\s*[:._+-]?\s*/iu.test(selected)) {
                const prefix = line.text.match(/^\s*(?:tel(?:efono|ephone)?\.?|phone|ph\.?|fax|telefax|mob(?:ile)?\.?|cell(?:ulare)?\.?|t|f)\s*[:._+-]?\s*/iu)?.[0];
                if (prefix) selected = `${prefix}${selected}`.trim();
              }
              if (kind === 'fiscal' && !/^\s*(?:p\.?\s*i(?:va)?|partita\s+iva|vat|c\.?\s*f\.?|codice\s+fiscale)\b/iu.test(selected)) {
                const prefix = decisionInput.match(/^\s*(?:p\.?\s*i(?:va)?|partita\s+iva|vat|c\.?\s*f\.?|codice\s+fiscale)\s*[:._+\-]?\s*/iu)?.[0];
                if (prefix) selected = `${prefix}${selected}`.trim();
              }
              line.text = selected;
              changed = true;
              runtimeLogger.debug('OCR_CRITICAL_ROW_REFINED', undefined, {
                status: 'completed',
                stage: 'read',
                source: 'local',
                targetWidth,
              });
              break;
            }
          } finally {
            if (focusedUri) void cleanupTemporaryImageUri(focusedUri).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!operation || operation.isActive()) {
          runtimeLogger.warn('OCR_CRITICAL_ROW_REFINE_FAILED', error, {
            status: 'failed',
            stage: 'read',
            source: 'local',
          });
        }
      }
    }

    if (!changed) return primary;
    const ordered = sortLinesReadingOrder(lines);
    const text = normalizeOcrText(ordered.map((line) => line.text.trim()).filter(Boolean).join('\n'));
    return {
      ...primary,
      lines: ordered,
      text,
      quality: assessOcrQuality(ordered, text, { source: 'local' }),
    };
  } finally {
    if (orientedTemporary) void cleanupTemporaryImageUri(orientedUri).catch(() => undefined);
  }
}

function scoreDocumentOcrLines(lines: OcrLine[], text: string): number {
  const blob = text || lines.map((l) => l.text).join('\n');
  let score = lines.length * 3 + Math.min(blob.length, 1200) / 6;

  if (/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(blob)) score += 25;
  if (/\d+[,\.]\d{2}/.test(blob)) score += 30;
  if (/preventivo|ordine|fatturare|totale|subtotale|cliente|descrizione|qt/i.test(blob)) score += 25;

  const meaningful = lines.filter((l) => l.text.trim().length >= 2).length;
  score += meaningful * 4;

  return score;
}

const DOCUMENT_OCR_ANGLES = [0, 90, 180, 270] as const;

export interface OcrAngleAttempt {
  angle: 0 | 90 | 180 | 270;
  result: OcrScanResult;
}

function compactConsensusKey(value: string): string {
  return normalizeOcrText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    // Nelle letture dello stesso identico pixel ML Kit alterna spesso "m" e
    // "rn". Per il SOLO raggruppamento del consenso sono equivalenti; il
    // testo restituito resta comunque una variante realmente osservata.
    .replace(/rn/g, 'm');
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function closestConsensusLine(primaryKey: string, lines: readonly OcrLine[]): OcrLine | null {
  if (primaryKey.length < 6) return null;
  const maximumDistance = Math.min(3, Math.max(1, Math.floor(primaryKey.length * 0.12)));
  let best: OcrLine | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const key = compactConsensusKey(line.text);
    if (key.length < 6 || Math.abs(key.length - primaryKey.length) > maximumDistance) continue;
    const distance = editDistance(primaryKey, key);
    if (distance < bestDistance && distance <= maximumDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

function splitEmail(email: string): { local: string; host: string; tld: string } | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at >= email.length - 1) return null;
  const local = email.slice(0, at).toLowerCase();
  const host = email.slice(at + 1).toLowerCase();
  const tld = host.split('.').pop() ?? '';
  if (!local || !host || !tld) return null;
  return { local, host, tld };
}

function emailLocalKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * V32: voto strutturato sull'indirizzo email, indipendente dalla label OCR.
 * Ogni rotazione vale al massimo un voto; local-part e TLD devono coincidere
 * con l'email primaria e l'host deve restare otticamente vicino. Due candidati
 * a pari quorum sono ambigui e non modificano nulla.
 */
export function chooseMultiAngleEmailConsensus(
  observedEmail: string,
  attempts: readonly OcrAngleAttempt[],
  minVotes = 2,
): { selected: string; confirmed: boolean; changed: boolean; votes: number } {
  const observedParts = splitEmail(observedEmail);
  if (!observedParts) return { selected: observedEmail, confirmed: false, changed: false, votes: 0 };

  const observedLocal = emailLocalKey(observedParts.local);
  const votes = new Map<string, number>();
  for (const attempt of attempts) {
    const candidates = new Set<string>();
    for (const line of attempt.result.lines) {
      const email = firstEmailToken(line.text);
      if (!email) continue;
      const parts = splitEmail(email);
      if (!parts) continue;
      if (emailLocalKey(parts.local) !== observedLocal || parts.tld !== observedParts.tld) continue;

      const maximumHostDistance = Math.min(
        3,
        Math.max(1, Math.floor(Math.max(parts.host.length, observedParts.host.length) * 0.25)),
      );
      if (editDistance(parts.host, observedParts.host) > maximumHostDistance) continue;
      candidates.add(email.toLowerCase());
    }
    // Una singola rotazione che produce due mailbox compatibili e' ambigua:
    // non le assegniamo entrambe un voto.
    if (candidates.size === 1) {
      const [candidate] = candidates;
      votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
    }
  }

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const winner = ranked[0];
  const runnerUpVotes = ranked[1]?.[1] ?? 0;
  if (!winner || winner[1] < minVotes || winner[1] <= runnerUpVotes) {
    return { selected: observedEmail, confirmed: false, changed: false, votes: winner?.[1] ?? 0 };
  }
  return {
    selected: winner[0],
    confirmed: true,
    changed: winner[0] !== observedEmail.toLowerCase(),
    votes: winner[1],
  };
}

/**
 * Corregge una riga soltanto con un consenso stretto fra rotazioni OCR.
 * Il valore applicato deve essere stato realmente osservato in almeno due
 * angoli: non vengono mai sintetizzati caratteri o nomi aziendali.
 */
export function reconcileBusinessCardAngleConsensus(
  primary: OcrScanResult,
  attempts: readonly OcrAngleAttempt[],
): OcrScanResult {
  if (attempts.length < 2 || primary.lines.length === 0) return primary;
  let changed = false;
  const confirmedEmails = new Set(primary.multiAngleConfirmedEmails ?? []);
  const emailReconciledLines = primary.lines.map((primaryLine) => {
    const observedEmail = firstEmailToken(primaryLine.text);
    if (!observedEmail) return primaryLine;
    const decision = chooseMultiAngleEmailConsensus(observedEmail, attempts);
    if (!decision.confirmed) return primaryLine;
    confirmedEmails.add(decision.selected);
    if (!decision.changed && primaryLine.text.toLowerCase().includes(decision.selected)) return primaryLine;
    const nextText = replaceEmailTokenInLine(primaryLine.text, observedEmail, decision.selected);
    if (nextText === primaryLine.text) return primaryLine;
    changed = true;
    return { ...primaryLine, text: nextText, elements: undefined };
  });

  const lines = emailReconciledLines.map((primaryLine) => {
    // La mailbox ha gia un arbitraggio strutturato dedicato sopra. Il voto
    // generico di riga non deve reintrodurre spazi/glifi dalla maggioranza
    // testuale dopo che l'email e stata confermata e normalizzata.
    if (firstEmailToken(primaryLine.text)) return primaryLine;
    const primaryKey = compactConsensusKey(primaryLine.text);
    if (primaryKey.length < 6) return primaryLine;

    const votes = new Map<string, { count: number; texts: Map<string, number> }>();
    for (const attempt of attempts) {
      const candidate = closestConsensusLine(primaryKey, attempt.result.lines);
      if (!candidate) continue;
      const key = compactConsensusKey(candidate.text);
      const group = votes.get(key) ?? { count: 0, texts: new Map<string, number>() };
      const observedText = normalizeOcrText(candidate.text).replace(/\s+/g, ' ').trim();
      const sameCaseInsensitiveText = [...group.texts.keys()].find(
        (value) => value.toLocaleLowerCase() === observedText.toLocaleLowerCase(),
      );
      const displayText = sameCaseInsensitiveText ?? observedText;
      group.count += 1;
      group.texts.set(displayText, (group.texts.get(displayText) ?? 0) + 1);
      votes.set(key, group);
    }

    const ranked = [...votes.entries()].sort((a, b) => b[1].count - a[1].count);
    const winner = ranked[0];
    const runnerUpVotes = ranked[1]?.[1].count ?? 0;
    if (!winner || winner[1].count < 2 || winner[1].count <= runnerUpVotes) {
      return primaryLine;
    }

    const observedWinner = [...winner[1].texts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]?.[0];
    if (!observedWinner || observedWinner === normalizeOcrText(primaryLine.text).replace(/\s+/g, ' ').trim()) return primaryLine;
    changed = true;
    return {
      ...primaryLine,
      text: observedWinner,
      // Gli elementi appartengono alla variante perdente e non devono
      // contraddire la riga sostituita.
      elements: undefined,
    };
  });

  const metadataChanged = confirmedEmails.size !== (primary.multiAngleConfirmedEmails?.length ?? 0);
  if (!changed && !metadataChanged) return primary;
  const ordered = sortLinesReadingOrder(lines);
  const text = normalizeOcrText(ordered.map((line) => line.text.trim()).filter(Boolean).join('\n'));
  return {
    ...primary,
    lines: ordered,
    text,
    multiAngleConfirmedEmails: [...confirmedEmails].sort(),
    quality: assessOcrQuality(ordered, text, { source: 'local' }),
  };
}

async function scanBestAtAngles(
  imageUri: string,
  scoreFn: (lines: OcrLine[], text: string) => number,
  operation?: OperationLease,
  expectedCanvas?: { width: number; height: number },
  rotationCandidates: readonly (0 | 90 | 180 | 270)[] = DOCUMENT_OCR_ANGLES,
  businessCardQaSession?: BusinessCardOcrQaSession | null,
  onBestAvailable?: (result: OcrScanResult) => void,
  onAttempt?: (attempt: OcrAngleAttempt) => void,
): Promise<OcrScanResult> {
  const angles = rotationCandidates.length > 0 ? rotationCandidates : DOCUMENT_OCR_ANGLES;
  let best: OcrScanResult = {
    lines: [],
    text: '',
    quality: emptyOcrQuality(),
  };
  let bestScore = -1;

  for (const angle of angles) {
    if (operation && !operation.isActive()) break;
    let attemptUri = imageUri;
    try {
      attemptUri = angle === 0 ? imageUri : await rotateImage(imageUri, angle);
      if (operation && !operation.isActive()) break;
      if (!(await isOcrImageEligible(attemptUri, angle))) continue;
      const result = await recognizeOnce(
        attemptUri,
        () => !operation || operation.isActive()
      );
      if (operation && !operation.isActive()) break;
      const score = scoreFn(result.lines, result.text);
      if (businessCardQaSession) {
        await saveBusinessCardOcrAttempt(
          businessCardQaSession,
          angle as 0 | 90 | 180 | 270,
          attemptUri,
          result.text,
        );
      }
      if (score > bestScore) {
        const expectedSize = expectedCanvas
          ? angle === 90 || angle === 270
            ? { width: expectedCanvas.height, height: expectedCanvas.width }
            : expectedCanvas
          : undefined;
        // Per i documenti la dimensione fisica canonical e gia nota. Non
        // sostituirla con Image.getSize, che su alcuni Android la dimezza.
        const size = expectedSize ?? await getImageSize(attemptUri).catch(() => undefined);
        best = {
          ...result,
          rotationDegrees: angle as 0 | 90 | 180 | 270,
          ...(size ? { ocrCanvasWidth: size.width, ocrCanvasHeight: size.height } : {}),
        };
        bestScore = score;
        onBestAvailable?.(best);
      }
      // Notifica il tentativo dopo l'eventuale cambio del migliore: il
      // chiamante può così aggiornare anche il consenso disponibile al timeout.
      onAttempt?.({ angle: angle as 0 | 90 | 180 | 270, result });
    } catch (error) {
      if (!operation || operation.isActive()) {
        runtimeLogger.warn('OCR_ANGLE_FAILED', error, {
          status: 'failed',
          stage: 'read',
          source: 'local',
          angle,
        });
      }
    } finally {
      if (angle !== 0 && attemptUri !== imageUri) {
        void cleanupTemporaryImageUri(attemptUri).catch(() => undefined);
      }
    }
  }

  return best;
}

export async function scanBusinessCard(imageUri: string): Promise<OcrLine[]> {
  try {
    const result = await recognizeOnce(imageUri);
    return result.lines;
  } catch (error) {
    logOcrError(error);
    return [];
  }
}

/** OCR multi-orientamento per documenti A4 (preventivi, ordini). */
export async function scanDocumentBest(
  imageUri: string,
  operation?: OperationLease,
  expectedCanvas?: { width: number; height: number },
  rotationCandidates: readonly (0 | 90 | 180 | 270)[] = DOCUMENT_OCR_ANGLES,
): Promise<OcrScanResult> {
  const empty: OcrScanResult = { lines: [], text: '', quality: emptyOcrQuality() };
  traceOcr('document_begin', {
    uri: imageUri.slice(-48),
    angles: rotationCandidates.join(','),
  });
  try {
    const outcome = await runTimedOperation<OcrScanResult>({
      operationId: `ocr-document-${Date.now()}`,
      timeoutMs: DOCUMENT_OCR_TIMEOUT_MS,
      fallback: empty,
      isExternallyActive: () => !operation || operation.isActive(),
      task: () =>
        scanBestAtAngles(
          imageUri,
          scoreDocumentOcrLines,
          operation,
          expectedCanvas,
          rotationCandidates,
        ),
    });
    if (outcome.status === 'timed_out') {
      traceOcr('document_timeout');
      runtimeLogger.warn('OCR_DOCUMENT_TIMEOUT', undefined, {
        status: 'timed_out',
        stage: 'read',
        source: 'local',
      });
    }
    traceOcr('document_done', {
      status: outcome.status,
      lines: outcome.value?.lines.length ?? 0,
    });
    if (outcome.status === 'completed' || outcome.status === 'timed_out') {
      return outcome.value ?? empty;
    }
    if (outcome.status === 'failed') throw outcome.error;
    return empty;
  } catch (error) {
    if (!operation || operation.isActive()) logOcrError(error);
    return empty;
  }
}

/**
 * OCR biglietti — ML Kit on-device; prova 0/90/180/270 se il testo è ruotato.
 */
export async function scanBusinessCardBest(
  imageUri: string,
  operation?: OperationLease,
  options?: { timeoutMs?: number },
): Promise<OcrScanResult> {
  const qaSession = await beginBusinessCardOcrQaSession();
  const empty: OcrScanResult = {
    lines: [],
    text: '',
    quality: emptyOcrQuality(),
  };
  let bestAvailable = empty;
  try {
    const outcome = await runTimedOperation<OcrScanResult>({
      operationId: `ocr-business-card-${Date.now()}`,
      timeoutMs: options?.timeoutMs ?? BUSINESS_CARD_OCR_TIMEOUT_MS,
      fallback: empty,
      isExternallyActive: () => !operation || operation.isActive(),
      task: async (context) => {
        // Le funzioni interne consultano isActive prima di ogni nuovo tentativo.
        const boundedOperation = {
          isActive: () =>
            context.isActive() && (!operation || operation.isActive()),
        } as OperationLease;
        const angleAttempts: OcrAngleAttempt[] = [];
        let selectedAngleBest = empty;
        const selectedPrimary = await scanBestAtAngles(imageUri, (lines, text) => {
          let score = lines.length * 5 + Math.min(text.length, 800) / 10;
          if (EMAIL_REGEX.test(text)) score += 40;
          if (PHONE_REGEX.test(text)) score += 30;
          for (const line of lines) {
            const bb = line.boundingBox;
            if (!bb || bb.width < 6) continue;
            const ratio = bb.width / Math.max(bb.height ?? 1, 1);
            if (ratio >= 1.1) score += ratio * 3;
          }
          return score;
        }, boundedOperation, undefined, DOCUMENT_OCR_ANGLES, qaSession, (candidate) => {
          selectedAngleBest = candidate;
          bestAvailable = candidate;
        }, (attempt) => {
          angleAttempts.push(attempt);
          bestAvailable = reconcileBusinessCardAngleConsensus(selectedAngleBest, angleAttempts);
        });
        const primary = reconcileBusinessCardAngleConsensus(selectedPrimary, angleAttempts);
        bestAvailable = primary;
        if (!boundedOperation.isActive()) return bestAvailable;

        const identityRefined = await recoverMissingEmailIdentityFromPixels(
          imageUri,
          primary,
          boundedOperation,
        );
        bestAvailable = identityRefined;
        if (!boundedOperation.isActive()) return bestAvailable;

        const latinRefined = await refineBusinessCardEmailRows(
          imageUri,
          identityRefined,
          boundedOperation,
        );
        bestAvailable = latinRefined;
        if (!boundedOperation.isActive()) return bestAvailable;

        const criticalRefined = await refineBusinessCardCriticalRows(
          imageUri,
          latinRefined,
          boundedOperation,
        );
        bestAvailable = criticalRefined;
        if (!boundedOperation.isActive()) return bestAvailable;

        const augmented = await augmentBusinessCardWithExtraScripts(
          imageUri,
          criticalRefined,
          boundedOperation,
          qaSession,
        );
        bestAvailable = augmented;
        return augmented;
      },
    });
    const finalResult = outcome.status === 'completed'
      ? outcome.value
      : bestAvailable;
    await saveBusinessCardOcrSummary(
      qaSession,
      finalResult.rotationDegrees ?? 0,
      finalResult.text,
    );
    return finalResult;
  } catch (error) {
    if (!operation || operation.isActive()) logOcrError(error);
    return { lines: [], text: '', quality: emptyOcrQuality() };
  }
}

function logOcrError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("doesn't seem to be linked")) {
    runtimeLogger.warn('OCR_NATIVE_UNAVAILABLE', error, {
      status: 'unavailable',
      stage: 'read',
      source: 'local',
      reasonCode: 'native_module_missing',
    });
  } else {
    runtimeLogger.error('OCR_FAILED', error, {
      status: 'failed',
      stage: 'read',
      source: 'local',
    });
  }
}

export function isOcrLikelyAvailable(): boolean {
  try {
    return typeof TextRecognition?.recognize === 'function';
  } catch {
    return false;
  }
}
