const EMAIL_TOKEN_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,63}/i;

const EMAIL_LABEL_RE = /\b(?:e[\s-]?mail|email|mail|pec)\b\s*[:.\-]?/i;
const SPLIT_EMAILISH_RE = /[a-z0-9._%+\-]{2,}\s+[a-z0-9-]{2,}\s*[.,]\s*[a-z]{2,63}\b/i;

const COMMON_PERSONAL_MAIL_HOSTS = new Set([
  'gmail.com', 'googlemail.com', 'ymail.com', 'yahoo.com', 'yahoo.it',
  'hotmail.com', 'outlook.com', 'live.com', 'libero.it', 'virgilio.it',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'gmx.net', 'aol.com',
]);

export function shouldDeepRefineObservedEmail(text: string): boolean {
  const email = firstEmailToken(text);
  if (!email) return false;
  const host = email.split('@')[1]?.toLowerCase() ?? '';
  return COMMON_PERSONAL_MAIL_HOSTS.has(host);
}

export function isPotentialEmailRow(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes('@')) return true;
  if (EMAIL_LABEL_RE.test(t)) return true;
  // OCR reale puo perdere proprio @ lasciando local-part e dominio separati
  // (es. nome.cognome azienda.it). Richiediamo una local-part strutturata o
  // una label email, cosi un normale sito web non attiva il secondo passaggio.
  if (SPLIT_EMAILISH_RE.test(t)) return true;
  return false;
}

export function firstEmailToken(text: string): string | null {
  const normalized = text
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.')
    .replace(/[;,]+$/g, '')
    .trim();
  return normalized.match(EMAIL_TOKEN_RE)?.[0]?.toLowerCase() ?? null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    let diagonal = i - 1;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(above + 1, left + 1, diagonal + cost);
      prev[j - 1] = left;
      diagonal = above;
      left = next;
    }
    prev[b.length] = left;
  }
  return prev[b.length];
}


function localAlnumKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function confusableKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[|1]/g, 'l')
    .replace(/[^a-z0-9@.]/g, '');
}

/**
 * Un OCR focalizzato sulla sola riga email può sostituire il passaggio full-card
 * solo se produce un indirizzo valido e molto vicino a quello osservato.
 * Non ricostruisce email da nome/azienda e non inventa caratteri assenti dai pixel.
 */
export function chooseFocusedEmail(
  observedText: string,
  focusedText: string,
): { observed: string | null; focused: string | null; selected: string | null; changed: boolean } {
  const observed = firstEmailToken(observedText);
  const focused = firstEmailToken(focusedText);
  if (!focused) return { observed, focused: null, selected: observed, changed: false };
  if (!observed) return { observed: null, focused, selected: focused, changed: true };
  if (observed === focused) return { observed, focused, selected: observed, changed: false };

  const [observedLocal, observedHost = ''] = observed.split('@');
  const [focusedLocal, focusedHost = ''] = focused.split('@');
  const observedTld = observedHost.split('.').pop() ?? '';
  const focusedTld = focusedHost.split('.').pop() ?? '';
  const sameTld = observedTld === focusedTld;
  const countryTldExtension =
    localAlnumKey(observedLocal) === localAlnumKey(focusedLocal) &&
    focusedHost.startsWith(`${observedHost}.`) &&
    /^[a-z]{2,3}$/i.test(focusedHost.slice(observedHost.length + 1));

  // V21: una email completa gia' osservata e' autoritativa sul local-part.
  // Il focused OCR puo' correggere soltanto UN glifo dell'host, a pari lunghezza,
  // con stesso TLD. Cosi' non puo' piu' trasformare nome.cognome -> cognome
  // oppure alex.nadalin -> clex.nodolin.
  const sameLocalCore = localAlnumKey(observedLocal) === localAlnumKey(focusedLocal);
  const hostDistance = levenshtein(confusableKey(observedHost), confusableKey(focusedHost));
  const oneHostGlyph =
    sameLocalCore &&
    sameTld &&
    observedHost.length === focusedHost.length &&
    hostDistance === 1;

  if (oneHostGlyph || countryTldExtension) {
    return { observed, focused, selected: focused, changed: true };
  }
  return { observed, focused, selected: observed, changed: false };
}

export function chooseFocusedEmailConsensus(
  observedText: string,
  focusedTexts: string[],
  minVotes = 2,
): { observed: string | null; selected: string | null; changed: boolean; votes: number } {
  const observed = firstEmailToken(observedText);

  // V26: consensus conservativo per campi strutturati.
  // Se il valore corrente e' confermato da almeno minVotes riletture ottiche
  // indipendenti, un'alternativa anch'essa supportata NON lo sovrascrive:
  // il segnale e' ambiguo e il valore corrente resta stabile. Solo quando il
  // valore corrente NON raggiunge quorum e una singola alternativa lo raggiunge
  // possiamo correggere automaticamente l'host. Il local-part osservato resta
  // immutabile e verra' eventualmente riconciliato piu' avanti con la persona.
  if (observed) {
    const [observedLocal, observedHost = ''] = observed.split('@');
    const observedTld = observedHost.split('.').pop() ?? '';
    const observedLocalKey = localAlnumKey(observedLocal);
    const hostVotes = new Map<string, number>();

    for (const focusedText of focusedTexts) {
      const focused = firstEmailToken(focusedText);
      if (!focused) continue;
      const [focusedLocal, focusedHost = ''] = focused.split('@');
      const focusedTld = focusedHost.split('.').pop() ?? '';
      if (!focusedHost || observedTld !== focusedTld) continue;

      // Una rilettura puo' differire di un solo glifo nel local-part, ma non
      // puo' appartenere a una mailbox/persona diversa.
      const focusedLocalKey = localAlnumKey(focusedLocal);
      const localDistance = levenshtein(observedLocalKey, focusedLocalKey);
      if (Math.abs(observedLocalKey.length - focusedLocalKey.length) > 1 || localDistance > 1) continue;

      // Contiamo sia il valore osservato sia le alternative a distanza di un
      // solo glifo. Questo evita il bug precedente: il valore corrente veniva
      // escluso dal voto e quindi una pluralita' avversaria poteva ribaltarlo
      // anche quando piu' letture indipendenti lo confermavano.
      const hostDistance = levenshtein(confusableKey(observedHost), confusableKey(focusedHost));
      if (observedHost.length !== focusedHost.length || hostDistance > 1) continue;

      const key = focusedHost.toLowerCase();
      hostVotes.set(key, (hostVotes.get(key) ?? 0) + 1);
    }

    const observedVotes = hostVotes.get(observedHost.toLowerCase()) ?? 0;
    if (observedVotes >= minVotes) {
      return { observed, selected: observed, changed: false, votes: observedVotes };
    }

    const alternatives = [...hostVotes.entries()]
      .filter(([host, count]) => host !== observedHost.toLowerCase() && count >= minVotes)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    // Due alternative diverse con quorum = conflitto ottico: fail closed.
    if (alternatives.length !== 1) {
      const top = [...hostVotes.values()].sort((a, b) => b - a)[0] ?? 0;
      return { observed, selected: observed, changed: false, votes: top };
    }

    const [selectedHost, count] = alternatives[0]!;
    const selected = `${observedLocal}@${selectedHost}`;
    return { observed, selected, changed: selected !== observed, votes: count };
  }

  // Nessuna email completa osservata: conserva il comportamento fail-closed
  // precedente e richiede consenso sull'intero indirizzo letto dai pixel.
  const votes = new Map<string, number>();
  for (const focusedText of focusedTexts) {
    const decision = chooseFocusedEmail(observedText, focusedText);
    if (!decision.changed || !decision.selected) continue;
    const key = decision.selected.toLowerCase();
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) return { observed: null, selected: null, changed: false, votes: 0 };
  const [selected, count] = ranked[0];
  const tied = ranked.length > 1 && ranked[1][1] === count;
  if (tied || count < minVotes) return { observed: null, selected: null, changed: false, votes: count };
  return { observed: null, selected, changed: true, votes: count };
}

/**
 * Ricompone uno split osservato NELLA STESSA riga, senza inventare caratteri:
 *   E-mail diego. bandolin@azienda.it
 * diventa:
 *   E-mail diego.bandolin@azienda.it
 *
 * Il frammento prima dell'email deve essere esclusivamente un pezzo di local-part
 * e deve terminare con un separatore email gia' osservato (. _ + -).
 */
export function coalesceObservedInlineEmailPrefix(text: string): string {
  const labelMatch = text.match(/^\s*((?:e[\s-]?mail|email|mail|pec)\s*[:.\-]?\s*)(.*)$/i);
  if (!labelMatch) return text;
  const label = labelMatch[1] ?? '';
  const rest = (labelMatch[2] ?? '').trim();
  if (!rest) return text;

  // Compattiamo SOLO spazi attorno a separatori che sono gia' stati osservati
  // nella riga. Non eliminiamo spazi normali fra parole, quindi una frase tipo
  // "support team nome@host" non puo' diventare una mailbox inventata.
  const compact = rest.replace(/\s*([._%+@\-])\s*/g, '$1');
  const email = firstEmailToken(compact);
  if (!email) return text;
  if (compact.toLowerCase() !== email.toLowerCase()) return text;
  if (rest.toLowerCase() === email.toLowerCase()) return text;
  return `${label}${email}`;
}

/**
 * Ricompone soltanto split OCR osservati su due righe, senza inventare lettere:
 *   E-mail diego.
 *   bandolin@azienda.it
 * diventa E-mail diego.bandolin@azienda.it. Il separatore deve essere gia'
 * presente nella prima riga e la seconda riga deve essere esclusivamente una
 * email completa.
 */
export function coalesceObservedSplitEmailRows<T extends {
  text: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}>(input: T[]): T[] {
  const lines = input.map((line) => ({ ...line, text: coalesceObservedInlineEmailPrefix(line.text) }));
  for (let i = 0; i + 1 < lines.length; i++) {
    const current = lines[i];
    const next = lines[i + 1];
    if (firstEmailToken(current.text)) continue;
    const label = current.text.match(/^\s*((?:e[\s-]?mail|email|mail|pec)\s*[:.\-]?\s*)([a-z0-9._%+\-]{2,}[._+\-])\s*$/i);
    if (!label) continue;
    const nextEmail = firstEmailToken(next.text);
    if (!nextEmail || next.text.trim().toLowerCase() !== nextEmail) continue;
    const combined = `${label[1]}${label[2]}${nextEmail}`;
    if (!firstEmailToken(combined)) continue;
    lines[i] = { ...current, text: combined, boundingBox: undefined };
    lines[i + 1] = { ...next, text: '' };
  }
  return lines.filter((line) => line.text.trim().length > 0);
}

export function replaceEmailTokenInLine(line: string, oldEmail: string | null, newEmail: string): string {
  if (oldEmail) {
    const index = line.toLowerCase().indexOf(oldEmail.toLowerCase());
    if (index >= 0) return `${line.slice(0, index)}${newEmail}${line.slice(index + oldEmail.length)}`;
  }
  const labeled = line.match(/^(\s*(?:e[\s-]?mail|email|mail|pec)\s*[:.\-]?\s*)/i);
  if (labeled?.[1]) return `${labeled[1]}${newEmail}`;
  if (line.includes('@') || isPotentialEmailRow(line)) return newEmail;
  return line;
}

const HOST_TOKEN_RE = /(?:@)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/ig;

export function extractFocusedEmailHost(text: string): string | null {
  const normalized = text.toLowerCase().replace(/\s*\.\s*/g, '.').replace(/\s+/g, ' ').trim();
  const matches: string[] = [];
  HOST_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HOST_TOKEN_RE.exec(normalized)) !== null) {
    const host = (match[1] ?? '').replace(/^@/, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,63}$/i.test(host)) matches.push(host);
  }
  HOST_TOKEN_RE.lastIndex = 0;
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Votes only on the host read from a host-focused pixel crop. The observed
 * local-part is immutable. A host can change only by one glyph, at equal
 * length and equal TLD, with >= minVotes independent optical readings.
 */
export function chooseFocusedEmailHostConsensus(
  observedText: string,
  focusedHostTexts: string[],
  minVotes = 2,
): { observed: string | null; selected: string | null; changed: boolean; votes: number } {
  const observed = firstEmailToken(observedText);
  if (!observed) return { observed: null, selected: null, changed: false, votes: 0 };
  const [local, observedHost = ''] = observed.split('@');
  const observedTld = observedHost.split('.').pop() ?? '';
  const votes = new Map<string, number>();

  for (const text of focusedHostTexts) {
    const host = extractFocusedEmailHost(text);
    if (!host) continue;
    const tld = host.split('.').pop() ?? '';
    if (tld !== observedTld || host.length !== observedHost.length) continue;
    if (levenshtein(confusableKey(observedHost), confusableKey(host)) > 1) continue;
    votes.set(host, (votes.get(host) ?? 0) + 1);
  }

  // V26: anche nel crop host-only il valore corrente partecipa al voto.
  // Se possiede quorum, il segnale e' sufficientemente confermato e non viene
  // sovrascritto da un'altra lettura anch'essa plausibile. In caso di conflitto
  // si conserva il valore corrente invece di oscillare fra OCR diversi.
  const observedVotes = votes.get(observedHost.toLowerCase()) ?? 0;
  if (observedVotes >= minVotes) {
    return { observed, selected: observed, changed: false, votes: observedVotes };
  }

  const alternatives = [...votes.entries()]
    .filter(([host, count]) => host !== observedHost.toLowerCase() && count >= minVotes)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (alternatives.length !== 1) {
    const top = [...votes.values()].sort((a, b) => b - a)[0] ?? 0;
    return { observed, selected: observed, changed: false, votes: top };
  }

  const [host, count] = alternatives[0]!;
  return { observed, selected: `${local}@${host}`, changed: true, votes: count };
}

