import type { DocumentLayoutLine } from './document-structure';

export type OcrDisplayTokenKind = 'phone' | 'email' | 'url' | 'text';

const DOMAIN_SUFFIX = /\.(?:com|it|net|org)\b/i;

function classifyOcrDisplayToken(text: string): OcrDisplayTokenKind {
  const trimmed = text.trim();
  if (!trimmed) return 'text';
  if (trimmed.includes('@')) return 'email';
  if (/^www\./i.test(trimmed)) return 'url';
  if (DOMAIN_SUFFIX.test(trimmed) && /[a-z]/i.test(trimmed)) return 'email';
  if (/^[\dOIl\s.-]{6,}$/i.test(trimmed) && /\d{5,}/.test(trimmed)) return 'phone';
  if (/^[\dOIl]{3,4}$/i.test(trimmed)) return 'phone';
  if (/^\d{5,10}$/.test(trimmed)) return 'phone';
  return 'text';
}

/** Spezza segmenti OCR dove telefono e dominio email sono attaccati senza spazio. */
export function splitGluedContactSegment(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const gluedPhoneDomain = trimmed.match(
    /^(\d{3,4}\s?\d{5,10})([A-Za-z][A-Za-z0-9.-]*\.(?:com|it|net|org)(?:\s.*)?)$/i
  );
  if (gluedPhoneDomain) {
    return [gluedPhoneDomain[1].trim(), gluedPhoneDomain[2].trim()];
  }

  const gluedLocalDomain = trimmed.match(
    /^(\d{5,10})([A-Za-z][A-Za-z0-9.-]*\.(?:com|it|net|org)(?:\s.*)?)$/i
  );
  if (gluedLocalDomain) {
    return [gluedLocalDomain[1].trim(), gluedLocalDomain[2].trim()];
  }

  const spacedPhoneEmail = trimmed.match(
    /^([\dOIl]{3,4}\s[\dOIl\s]{5,12})\s+(\S*@\S+|\S+\s+\S*\.(?:com|it|net|org))\s*$/i
  );
  if (spacedPhoneEmail) {
    return [spacedPhoneEmail[1].trim(), spacedPhoneEmail[2].trim()];
  }

  const spacedPhoneDomain = trimmed.match(
    /^([\dOIl]{3,4}\s[\dOIl\s]{5,12})\s+([a-zA-Z][\w.-]*\.(?:com|it|net|org)(?:\s+\w+)?)\s*$/i
  );
  if (spacedPhoneDomain) {
    return [spacedPhoneDomain[1].trim(), spacedPhoneDomain[2].trim()];
  }

  return [trimmed];
}

function groupElementsForDisplay(
  elements: readonly { text: string }[]
): string[] {
  if (elements.length <= 1) {
    return splitGluedContactSegment(elements[0]?.text ?? '');
  }

  const kinds = elements.map((element) => classifyOcrDisplayToken(element.text));
  const contactKinds = kinds.filter(
    (kind) => kind === 'phone' || kind === 'email' || kind === 'url'
  );
  const hasMixedContact =
    new Set(contactKinds).size >= 2 ||
    (kinds.includes('phone') && kinds.includes('email'));

  if (!hasMixedContact) {
    return elements.flatMap((element) => splitGluedContactSegment(element.text));
  }

  const groups: string[] = [];
  let buffer = '';
  let bufferKind: OcrDisplayTokenKind = 'text';

  for (const element of elements) {
    const parts = splitGluedContactSegment(element.text);
    for (const part of parts) {
      const partKind = classifyOcrDisplayToken(part);
      if (!buffer) {
        buffer = part;
        bufferKind = partKind;
        continue;
      }
      if (
        partKind === bufferKind &&
        (partKind === 'phone' || partKind === 'text')
      ) {
        buffer = `${buffer} ${part}`.trim();
      } else {
        groups.push(buffer);
        buffer = part;
        bufferKind = partKind;
      }
    }
  }

  if (buffer) groups.push(buffer);
  return groups.length > 0
    ? groups
    : [elements.map((element) => element.text).join(' ').trim()];
}

export function formatLayoutLineForDisplay(line: {
  text: string;
  elements?: readonly { text: string }[];
}): string[] {
  if (line.elements && line.elements.length > 0) {
    const grouped = groupElementsForDisplay(line.elements);
    if (grouped.length > 0) return grouped;
  }
  return splitGluedContactSegment(line.text);
}

export function formatOcrPageTextForDisplay(
  rawText: string,
  layoutLines?: readonly Pick<DocumentLayoutLine, 'text' | 'elements'>[]
): { text: string; reformatted: boolean } {
  if (layoutLines && layoutLines.length > 0) {
    const displayLines: string[] = [];
    let reformatted = false;
    for (const line of layoutLines) {
      const formatted = formatLayoutLineForDisplay(line);
      const original = line.text.trim();
      if (formatted.length !== 1 || formatted[0] !== original) {
        reformatted = true;
      }
      displayLines.push(...formatted);
    }
    return { text: displayLines.join('\n'), reformatted };
  }

  const displayLines: string[] = [];
  let reformatted = false;
  for (const line of rawText.split('\n')) {
    const formatted = splitGluedContactSegment(line);
    if (formatted.length > 1) reformatted = true;
    displayLines.push(...formatted.filter(Boolean));
  }
  return { text: displayLines.join('\n'), reformatted };
}
