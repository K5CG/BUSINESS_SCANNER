import { File, Paths } from 'expo-file-system';
import { clearOcrEmailRefinementDiagnostics, consumeOcrEmailRefinementDiagnostics, scanBusinessCardBest } from './ocr';
import { buildCardTitle, parseCardFromPages } from './parser';
import { evaluateQaBusinessCard, type QaExpectedCard } from './qa-real-image-assertions';
import type { BusinessCard } from '../types';

const REQUEST_NAME = 'qa-real-image-request.json';
const RESULT_NAME = 'qa-real-image-result.json';

interface QaRealImageCaseRequest {
  id: string;
  title: string;
  imageFiles: string[];
  expected: QaExpectedCard;
}

interface QaRealImageRequest {
  schemaVersion: 1;
  cases: QaRealImageCaseRequest[];
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) throw new Error(`Unsafe QA image path: ${value}`);
  return normalized;
}

/**
 * Hidden real-image QA gate.
 * Reads actual JPEG files copied into the app document directory, runs the
 * production on-device ML Kit OCR (`scanBusinessCardBest`) and then the
 * production V5 parser. No OCR stubs and no pre-saved raw text are used.
 */
export async function runHiddenQaRealImageGateIfRequested(): Promise<void> {
  const requestFile = new File(Paths.document, REQUEST_NAME);
  if (!requestFile.exists) return;

  const resultFile = new File(Paths.document, RESULT_NAME);
  try {
    const request = JSON.parse(await requestFile.text()) as QaRealImageRequest;
    if (request.schemaVersion !== 1 || !Array.isArray(request.cases)) {
      throw new Error('Invalid real-image QA request');
    }

    const results = [];
    for (const item of request.cases) {
      const pages = [];
      const pageDiagnostics = [];
      for (const relativeImage of item.imageFiles) {
        const imageFile = new File(Paths.document, safeRelativePath(relativeImage));
        if (!imageFile.exists) throw new Error(`QA image missing: ${relativeImage}`);
        clearOcrEmailRefinementDiagnostics();
        const ocr = await scanBusinessCardBest(imageFile.uri);
        const emailRefinementDiagnostics = consumeOcrEmailRefinementDiagnostics();
        pages.push({ lines: ocr.lines, rawText: ocr.text });
        pageDiagnostics.push({
          imageFile: relativeImage,
          rawText: ocr.text,
          lineCount: ocr.lines.length,
          rotationDegrees: ocr.rotationDegrees ?? 0,
          quality: ocr.quality,
          emailRefinementDiagnostics,
        });
      }

      const parsed = parseCardFromPages(pages);
      const card: BusinessCard = {
        ...parsed,
        type: 'business_card',
        title: buildCardTitle(parsed.company, parsed.firstName, parsed.lastName),
        images: item.imageFiles,
      };
      const evaluation = evaluateQaBusinessCard(card, item.expected, pages.map((page) => page.rawText));
      results.push({
        id: item.id,
        title: item.title,
        pass: evaluation.pass,
        errors: evaluation.errors,
        warnings: evaluation.warnings,
        assertions: evaluation.assertions,
        pageDiagnostics,
        parsed: {
          title: card.title,
          firstName: card.firstName,
          lastName: card.lastName,
          role: card.role,
          company: card.company,
          emails: card.emails,
          phones: card.phones,
          website: card.website ?? null,
          address: card.address ?? null,
          addressAlternatives: card.extractionReview?.addressAlternatives ?? [],
          confidence: card.confidence,
          reviewFields: card.extractionReview?.reviewFields ?? [],
        },
      });
    }

    const failed = results.filter((item) => !item.pass).length;
    resultFile.write(JSON.stringify({
      schemaVersion: 1,
      runtime: 'android-native-mlkit',
      generatedAt: new Date().toISOString(),
      total: results.length,
      passed: results.length - failed,
      failed,
      pass: failed === 0,
      results,
    }, null, 2));
    try { requestFile.delete(); } catch { /* diagnostic only */ }
  } catch (error) {
    resultFile.write(JSON.stringify({
      schemaVersion: 1,
      runtime: 'android-native-mlkit',
      pass: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
  }
}
