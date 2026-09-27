import type { AiOperationType } from '../../../lib/ai-credit/types.ts';
import { AI_OPERATION_ID_RE } from '../../../lib/ai-credit/types.ts';

const INSTALLATION_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const FORBIDDEN_CLIENT_KEYS = new Set([
  'creditsToCharge',
  'creditCost',
  'balance',
  'grantCredits',
  'aiCreditsTotal',
  'aiCreditsUsed',
  'premium',
  'entitlement',
]);

const VALID_OPERATION_TYPES = new Set<AiOperationType>([
  'business_card_ai',
  'document_page_ai',
  'pdf_page_ai',
  'document_reprocess',
]);

export interface ParsedAiCreditContext {
  installationId: string;
  operationId: string;
  operationType: AiOperationType;
  licenseId: string | null;
  pageCount: number;
}

export function rejectForbiddenCreditKeys(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => FORBIDDEN_CLIENT_KEYS.has(key));
}

export function parseInstallationId(body: Record<string, unknown>): string | null {
  const raw =
    (typeof body.installationId === 'string' ? body.installationId : null) ??
    (typeof body.deviceId === 'string' ? body.deviceId : null);
  if (!raw || !INSTALLATION_ID_RE.test(raw.trim())) return null;
  return raw.trim();
}

export function parseAiCreditContext(
  body: Record<string, unknown>,
  defaultOperationType: AiOperationType
): ParsedAiCreditContext | null {
  if (rejectForbiddenCreditKeys(body)) return null;

  const installationId = parseInstallationId(body);
  if (!installationId) return null;

  const operationId =
    typeof body.operationId === 'string' ? body.operationId.trim() : '';
  if (!AI_OPERATION_ID_RE.test(operationId)) return null;

  const operationTypeRaw =
    typeof body.operationType === 'string' ? body.operationType.trim() : defaultOperationType;
  if (!VALID_OPERATION_TYPES.has(operationTypeRaw as AiOperationType)) return null;

  const licenseId =
    typeof body.licenseId === 'string' && body.licenseId.trim()
      ? body.licenseId.trim()
      : null;

  const pageCountRaw = body.pageCount ?? 1;
  const pageCount =
    Number.isInteger(pageCountRaw) &&
    (pageCountRaw as number) >= 1 &&
    (pageCountRaw as number) <= 100
      ? (pageCountRaw as number)
      : 1;

  return {
    installationId,
    operationId,
    operationType: operationTypeRaw as AiOperationType,
    licenseId,
    pageCount,
  };
}

export { wrapUntrustedOcrText, UNTRUSTED_DATA_PREAMBLE } from '../../../lib/ai-credit/prompt-security.ts';
