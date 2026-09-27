import { isSupabaseConfigured } from './config';
import { callSupabaseFunction } from './supabase-functions';
import { runtimeLogger } from './safe-runtime-logger';
import type { AiCardFields } from './parser';
import {
  aiContextPayload,
  buildAiRequestContext,
  clearPendingOperation,
} from './ai-credit/operation-context';
import { isRcCloudAiEnabled } from './release-rc-policy';

const MAX_OCR_TEXT_LEN = 4000;

/**
 * Ultima risorsa quando l'estrazione locale gratuita (ML Kit + regole) resta
 * incerta su troppi campi vitali: chiede a un modello AI economico di
 * interpretare il TESTO già letto (nessuna immagine inviata, quindi costo
 * minimo per chiamata). Va usata SOLO come fallback, mai al posto dell'OCR
 * locale, perché il costo è a carico dello sviluppatore e non del cliente:
 * la funzione lato server applica comunque un tetto giornaliero di sicurezza.
 *
 * Ritorna `null` (silenziosamente) se Supabase non è configurato, se la rete
 * non risponde, se la quota giornaliera è esaurita o se il modello non
 * produce un risultato valido: in ogni caso l'app deve continuare a
 * funzionare con il solo risultato locale.
 */
export type CardAiOutcome =
  | { status: 'ok'; fields: AiCardFields; aiCreditsRemaining?: number }
  | { status: 'not_configured' }
  | { status: 'quota_exceeded' }
  | { status: 'credits_exhausted' }
  | { status: 'error'; message: string };

/**
 * Versione "verbosa" usata dal pulsante manuale "Chiedi aiuto alla AI" in
 * editor: a differenza di `structureCardTextWithAi` non inghiotte l'esito,
 * così l'utente può capire perché non è arrivato nessun miglioramento
 * (quota esaurita, rete assente, AI non configurata, ecc.).
 */
export async function structureCardTextWithAiVerbose(
  ocrText: string,
  existingOperationId?: string
): Promise<CardAiOutcome> {
  if (!isRcCloudAiEnabled()) {
    return { status: 'error', message: 'AI deferred for this release candidate' };
  }
  const text = ocrText.trim();
  if (!isSupabaseConfigured()) return { status: 'not_configured' };
  if (!text) return { status: 'error', message: 'Nessun testo OCR disponibile' };

  const ctx = await buildAiRequestContext('business_card_ai', existingOperationId);

  try {
    const result = await callSupabaseFunction<AiCardFields>('structure-business-card', {
      ocrText: text.slice(0, MAX_OCR_TEXT_LEN),
      ...aiContextPayload(ctx),
    });

    if (result.data) {
      clearPendingOperation(ctx.operationId);
      const remaining =
        result.data &&
        typeof result.data === 'object' &&
        'aiCreditsRemaining' in result.data &&
        typeof (result.data as Record<string, unknown>).aiCreditsRemaining === 'number'
          ? ((result.data as Record<string, unknown>).aiCreditsRemaining as number)
          : undefined;
      const fields = { ...result.data } as AiCardFields;
      delete (fields as Record<string, unknown>).aiCreditsRemaining;
      return { status: 'ok', fields, aiCreditsRemaining: remaining };
    }
    if (result.errorCode === 'AI_QUOTA_EXCEEDED') return { status: 'quota_exceeded' };
    if (result.errorCode === 'AI_CREDITS_INSUFFICIENT') return { status: 'credits_exhausted' };
    return { status: 'error', message: result.error ?? 'Errore sconosciuto' };
  } catch {
    return {
      status: 'error',
      message: 'Impossibile contattare il servizio AI',
    };
  }
}

export async function structureCardTextWithAi(ocrText: string): Promise<AiCardFields | null> {
  const outcome = await structureCardTextWithAiVerbose(ocrText);
  if (outcome.status === 'ok') return outcome.fields;
  if (outcome.status === 'error') {
    runtimeLogger.warn(
      'CARD_AI_STRUCTURE_FAILED',
      new Error(outcome.message),
      {
        source: 'cloud',
        stage: 'provider',
        status: 'failed',
      }
    );
  }
  return null;
}
