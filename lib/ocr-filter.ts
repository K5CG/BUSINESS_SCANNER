import { OcrLine } from '../types';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Righe tipiche di documenti/mappe sullo sfondo — non appartengono al biglietto. */
const BACKGROUND_NOISE =
  /\b(PANAMA|BELIZE|JAMAICA|CUBA|MEXICO|CARIBBE|ARAGUL|CONSIGLIO\s+REGIONALE|DEL\s+VENETO|valido\s+dal|attivit[aà]\s+adere|denco|CFnot|FALLE|Torre|Tor|MIRKO|MIRCO|MILCO|DUCATI|TRIUMPH|PNEUMATICI|WESTLAKE|FALKEN|BRIDGESTONE|GOODRIDE|TOMKET|FOTO)\b/i;

const PHONE_LINE =
  /(?:^|\s)(?:M\.|P\.|T\.|F\.|Tel\.?|Fax\.?|Mob\.?|Cell\.?|Telephone|Mobile|Phone)\s*[.+]?\d|^\s*[PTF]\s+[+(]?\d/i;

export function isCardBackgroundNoise(text: string): boolean {
  return BACKGROUND_NOISE.test(text.trim());
}

/** Testo OCR limitato al contesto del biglietto (esclude mappe, badge, fogli sullo sfondo). */
export function filterCardRelevantLines(lines: OcrLine[]): OcrLine[] {
  const emails = lines
    .map((l) => l.text.match(EMAIL_REGEX)?.[0])
    .filter(Boolean) as string[];

  const domains = [...new Set(emails.map((e) => e.split('@')[1]?.toLowerCase()).filter(Boolean))];

  return lines.filter((line) => {
    const t = line.text.trim();
    if (!t || t.length < 2) return false;
    if (BACKGROUND_NOISE.test(t)) return false;
    if (/^[01\s]+$/.test(t)) return false;

    if (EMAIL_REGEX.test(t)) return true;
    if (PHONE_LINE.test(t)) return true;
    if (/\+39[\s.-]?\d{2,3}/.test(t)) return true;
    if (/www\.[a-z0-9-]+\.[a-z]{2,}/i.test(t)) return true;
    if (/\b(?:S\.?\s*r\.?\s*l\.?|S\.?\s*p\.?\s*a\.?|S\.?\s*n\.?\s*c\.?|srl|spa|snc|GmbH|Inc\.?|LLC|Ltd\.?|S\.?\s*a\.?\s*s\.?)\b/i.test(t)) {
      return true;
    }
    if (/\b(?:geom|ing|arch|dott|avv)\.?\b/i.test(t)) return true;
    if (/\bdi\s+[A-ZÀ-ÜA-Za-zà-ü]+\s+[A-ZÀ-ÜA-Za-zà-ü]+/i.test(t)) return true;
    if (/\b(?:CEO|CTO|CFO|Manager|Direttore|Direttrice|Presidente|Titolare|Responsabile|Engineer|Founder)\b/i.test(t)) {
      return true;
    }
    if (/[A-Z0-9]{1,6}(?:\.[A-Z0-9]{1,6})+/i.test(t)) return true;
    if (/\b(?:p\.?\s*iva|partita\s*iva|codice\s*fiscale|c\.?\s*f\.?)\b/i.test(t)) return true;

    if (domains.some((d) => t.toLowerCase().includes(d.split('.')[0]))) return true;

    if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(t)) return true;
    if (/^[A-ZÀ-Ü]{2,}\s+[A-ZÀ-Ü]{2,}(?:\s+[A-ZÀ-Ü]{2,})?$/.test(t)) return true;
    if (/^[A-ZÀ-Ü0-9&][A-ZÀ-Ü0-9&.\-'\s]{1,24}$/.test(t) && t.length >= 3) return true;
    if (/^[A-Z]{3,15}$/.test(t) && !BACKGROUND_NOISE.test(t)) return true;
    if (/^[a-z0-9-]+\.(?:com|it|net|org|eu)$/i.test(t)) return true;

    if (/(?:via|viale|piazza|corso|galleria)\s+/i.test(t)) return true;
    if (/\bsede\s+(?:legale|operativa)/i.test(t)) return true;
    if (/\b\d{5}\s+[A-ZÀ-Ü][A-Za-zÀ-ü]+/.test(t)) return true;
    if (/\b\d{5}\s+[A-ZÀ-Ü]{2,}(?:\s*\([A-Z]{2}\))?/.test(t)) return true;

    return false;
  });
}

export function filterCardRelevantText(lines: OcrLine[], rawText: string): string {
  const filtered = filterCardRelevantLines(lines);
  if (filtered.length >= 2) {
    return filtered.map((l) => l.text).join('\n');
  }
  const keptLines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !BACKGROUND_NOISE.test(l));
  return keptLines.join('\n');
}
