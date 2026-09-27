export type GeminiModalContentKind = 'text' | 'images' | 'pdf';

/**
 * Con il PDF la conferma non invia nulla: apre il selettore del file. Il pulsante
 * lo dice, mentre gli altri percorsi mandano davvero il contenuto al servizio AI.
 */
export function geminiModalConfirmKey(contentKind: GeminiModalContentKind): string {
  return contentKind === 'pdf' ? 'geminiModalSelectPdfButton' : 'geminiModalSendButton';
}

/**
 * Le azioni del PDF restano affiancate anche su schermi stretti: "Annulla" e
 * "Seleziona PDF" stanno su una riga, e impilarle nasconderebbe la sequenza.
 */
export function geminiModalActionsStacked(
  contentKind: GeminiModalContentKind,
  narrowViewport: boolean
): boolean {
  return narrowViewport && contentKind !== 'pdf';
}

/** PDF primary label ("Seleziona PDF") needs more horizontal room than Cancel. */
export function geminiModalConfirmFlex(contentKind: GeminiModalContentKind): number {
  return contentKind === 'pdf' ? 1.4 : 1.55;
}

export function geminiModalCancelFlex(contentKind: GeminiModalContentKind): number {
  return contentKind === 'pdf' ? 0.85 : 0.65;
}

/** Allow a second line only for PDF so the full select label stays readable. */
export function geminiModalConfirmMaxLines(contentKind: GeminiModalContentKind): number {
  return contentKind === 'pdf' ? 2 : 1;
}
