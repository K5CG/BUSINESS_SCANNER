/**
 * Diciture di avanzamento per la modalità biglietto da visita.
 *
 * L'orchestratore di scansione emette chiavi pensate per i documenti. Il
 * biglietto ne attraversa solo una parte, ma mostrarle così com'è farebbe
 * comparire "Elaborazione documento" durante la scansione di un contatto.
 * Qui le chiavi documentali vengono tradotte in quelle del biglietto, senza
 * toccare il percorso documentale.
 */

export const CARD_PROCESSING_TITLE_KEY = 'processing.cardTitle';
export const DOCUMENT_PROCESSING_TITLE_KEY = 'processing.title';

const CARD_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  'processing.prepare': 'processing.cardPrepare',
  'processing.pageResults': 'processing.cardAnalyze',
  'processing.layout': 'processing.cardAnalyze',
  'processing.metadata': 'processing.cardAnalyze',
  'processing.itemsTotals': 'processing.cardAnalyze',
  'processing.reconcile': 'processing.cardAnalyze',
  'processing.persist': 'processing.cardPersist',
};

/** Titolo del riquadro di avanzamento per la modalità corrente. */
export function processingTitleKey(isBusinessCard: boolean): string {
  return isBusinessCard ? CARD_PROCESSING_TITLE_KEY : DOCUMENT_PROCESSING_TITLE_KEY;
}

/**
 * Chiave del messaggio di stato. Fuori dalla modalità biglietto la chiave
 * resta quella originale; dentro, le fasi documentali diventano fasi del
 * biglietto e quelle già neutre (riconoscimento testo, completato) passano
 * invariate.
 */
export function processingMessageKey(
  isBusinessCard: boolean,
  messageKey: string
): string {
  if (!isBusinessCard) return messageKey;
  return CARD_MESSAGE_KEYS[messageKey] ?? messageKey;
}
