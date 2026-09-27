import { PDFDocument, ParseSpeeds } from 'pdf-lib';

/**
 * Conta le pagine dal page tree PDF reale. Il chiamante applica il limite byte
 * prima di arrivare qui; i documenti cifrati o strutturalmente invalidi
 * vengono rifiutati da pdf-lib e non sono inoltrati al provider.
 */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, {
    capNumbers: true,
    ignoreEncryption: false,
    parseSpeed: ParseSpeeds.Fastest,
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  return document.getPageCount();
}
