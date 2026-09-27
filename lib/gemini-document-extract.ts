import { validateDocumentAmount } from './document-field-reliability';
import {
  normalizeAiStructuredDocument,
  type AiStructuredDocumentExtract,
} from './document-ai-contract';

export interface GeminiDocumentExtract {
  rawText: string;
  documentNumber?: string;
  customerName?: string;
  date?: string;
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  items?: Array<{
    description?: string;
    quantity?: number;
    unitPrice?: number;
    total?: number;
  }>;
  structured?: AiStructuredDocumentExtract;
  /**
   * Valori prima della normalizzazione. Consente alla validazione per campo
   * di distinguere assenza, zero esplicito e valore non interpretabile.
   */
  rawFields?: Partial<
    Record<
      | 'documentNumber'
      | 'customerName'
      | 'date'
      | 'subtotal'
      | 'vatAmount'
      | 'total'
      | 'items',
      unknown
    >
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizedNumber(value: unknown): number | undefined {
  const parsed = validateDocumentAmount(value);
  return parsed.validationStatus === 'valid' ? parsed.value : undefined;
}

function rawFieldsFromValue(
  value: Record<string, unknown>
): NonNullable<GeminiDocumentExtract['rawFields']> {
  const rawFields = isRecord(value.rawFields)
    ? { ...value.rawFields }
    : {};
  for (const field of [
    'documentNumber',
    'customerName',
    'date',
    'subtotal',
    'vatAmount',
    'total',
    'items',
  ] as const) {
    if (
      !Object.prototype.hasOwnProperty.call(rawFields, field) &&
      Object.prototype.hasOwnProperty.call(value, field)
    ) {
      rawFields[field] = value[field];
    }
  }
  return rawFields;
}

/**
 * Unico confine runtime per qualunque risposta cloud. Il DTO resta parziale:
 * proprietà assenti, quantità mancanti e array mancanti non vengono creati.
 * `rawFields` conserva inoltre l'evidenza originale per la validazione.
 */
export function normalizeGeminiDocumentExtract(
  value: unknown
): GeminiDocumentExtract | null {
  if (!isRecord(value)) return null;

  try {
    const items = Array.isArray(value.items)
      ? value.items.filter(isRecord).map((item) => {
          const description = normalizedString(item.description);
          const quantity = normalizedNumber(item.quantity);
          const unitPrice = normalizedNumber(item.unitPrice);
          const total = normalizedNumber(item.total ?? item.lineTotal);
          return {
            ...(description !== undefined ? { description } : {}),
            ...(quantity !== undefined ? { quantity } : {}),
            ...(unitPrice !== undefined ? { unitPrice } : {}),
            ...(total !== undefined ? { total } : {}),
          };
        })
      : undefined;
    const rawFields = rawFieldsFromValue(value);
    const documentNumber = normalizedString(value.documentNumber);
    const customerName = normalizedString(value.customerName);
    const date = normalizedString(value.date);
    const subtotal = normalizedNumber(value.subtotal);
    const vatAmount = normalizedNumber(value.vatAmount);
    const total = normalizedNumber(value.total);
    const structured = normalizeAiStructuredDocument(value.structured);

    return {
      rawText: normalizedString(value.rawText) ?? '',
      ...(documentNumber !== undefined ? { documentNumber } : {}),
      ...(customerName !== undefined ? { customerName } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(subtotal !== undefined ? { subtotal } : {}),
      ...(vatAmount !== undefined ? { vatAmount } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(items !== undefined ? { items } : {}),
      ...(structured ? { structured } : {}),
      ...(Object.keys(rawFields).length > 0 ? { rawFields } : {}),
    };
  } catch {
    return null;
  }
}

export function parseGeminiDocumentJson(
  text: string
): GeminiDocumentExtract | null {
  const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return normalizeGeminiDocumentExtract(JSON.parse(jsonMatch[0]));
  } catch {
    return null;
  }
}
