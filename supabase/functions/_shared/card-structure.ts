// Prompt e chiamata Gemini per la STRUTTURAZIONE di un biglietto da visita a
// partire dal solo TESTO già letto da ML Kit (nessuna immagine): usato solo
// come fallback quando l'estrazione locale gratuita resta incerta su troppi
// campi vitali. Essendo testo-only, il costo per chiamata è molto più basso
// di un'analisi di immagine.

import { edgeLogger } from './safe-logging.ts';
import type { SupportedGeminiModel } from './gemini-model-config.ts';
import {
  generateGeminiJson,
  type GeminiOperationOutcome,
} from './gemini-provider.ts';
import { wrapUntrustedOcrText } from './ai-credit-edge.ts';

export const CARD_STRUCTURE_PROMPT = `Sei un assistente che interpreta il testo OCR di un biglietto da visita (italiano o internazionale).
Il testo è stato già letto da un OCR gratuito e può contenere errori tipici (lettere/cifre scambiate come O/0, righe spezzate, spazi al posto di punti).
Usa il CONTESTO e le RELAZIONI tra le righe per capire il significato di ogni informazione, ad esempio:
- la riga subito sotto il nome della persona è spesso il ruolo, quella dopo ancora può essere il reparto/ufficio;
- una riga con "via/viale/piazza/corso" è l'indirizzo, spesso seguita da CAP+città (5 cifre + nome città);
- una sequenza di 11 cifre vicino a "IVA"/"VAT" è la partita IVA; un codice alfanumerico di 16 caratteri è il codice fiscale;
- righe con "www." o un dominio senza "@" sono il sito web, non l'azienda;
- il nome dell'azienda è spesso la riga più in evidenza (maiuscolo/logo), MAI un numero di telefono o un indirizzo email.

NON INVENTARE dati assenti dal testo: lascia vuoto/omesso ciò che non è presente o non sei ragionevolmente sicuro.
Rispondi SOLO con JSON valido (nessun markdown, nessun commento), in questo formato:
{
  "firstName": "",
  "lastName": "",
  "role": "",
  "company": "",
  "emails": [],
  "phones": [{"number": "", "type": "work"}],
  "website": "",
  "address": {"street": "", "postalCode": "", "city": "", "full": ""},
  "vatNumber": "",
  "taxCode": ""
}
"type" per i telefoni deve essere uno tra: work, mobile, fax, other.`;

export interface AiCardStructure {
  firstName?: string;
  lastName?: string;
  role?: string;
  company?: string;
  emails?: string[];
  phones?: Array<{ number?: string; type?: string }>;
  website?: string;
  address?: { street?: string; postalCode?: string; city?: string; full?: string };
  vatNumber?: string;
  taxCode?: string;
}

const VALID_PHONE_TYPES = new Set(['work', 'mobile', 'fax', 'other']);
const OBSERVED_EMAIL_RE =
  /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
function observedEmailsInText(text: string): Set<string> {
  return new Set(
    (text.match(OBSERVED_EMAIL_RE) ?? []).map((email) =>
      email.toLowerCase()
    )
  );
}

function parseCardJsonResponse(
  text: string,
  ocrText: string
): AiCardStructure | null {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const data = JSON.parse(jsonMatch[0]) as Partial<AiCardStructure>;
    return {
      firstName: typeof data.firstName === 'string' ? data.firstName.trim() : undefined,
      lastName: typeof data.lastName === 'string' ? data.lastName.trim() : undefined,
      role: typeof data.role === 'string' ? data.role.trim() : undefined,
      company: typeof data.company === 'string' ? data.company.trim() : undefined,
      emails: Array.isArray(data.emails)
        ? data.emails
            .filter((e): e is string => typeof e === 'string')
            .map((email) => email.trim().toLowerCase())
            .filter((email) => observedEmailsInText(ocrText).has(email))
        : undefined,
      phones: Array.isArray(data.phones)
        ? data.phones
            .filter((p): p is { number?: string; type?: string } => typeof p === 'object' && p !== null)
            .map((p) => ({
              number: typeof p.number === 'string' ? p.number.trim() : undefined,
              type: typeof p.type === 'string' && VALID_PHONE_TYPES.has(p.type) ? p.type : 'work',
            }))
            .filter((p) => p.number)
        : undefined,
      website: typeof data.website === 'string' ? data.website.trim() : undefined,
      address:
        data.address && typeof data.address === 'object'
          ? {
              street: typeof data.address.street === 'string' ? data.address.street.trim() : undefined,
              postalCode:
                typeof data.address.postalCode === 'string' ? data.address.postalCode.trim() : undefined,
              city: typeof data.address.city === 'string' ? data.address.city.trim() : undefined,
              full: typeof data.address.full === 'string' ? data.address.full.trim() : undefined,
            }
          : undefined,
      vatNumber: typeof data.vatNumber === 'string' ? data.vatNumber.trim() : undefined,
      taxCode: typeof data.taxCode === 'string' ? data.taxCode.trim() : undefined,
    };
  } catch {
    return null;
  }
}

function hasAnyField(fields: AiCardStructure): boolean {
  return Boolean(
    fields.firstName ||
      fields.lastName ||
      fields.role ||
      fields.company ||
      (fields.emails && fields.emails.length > 0) ||
      (fields.phones && fields.phones.length > 0) ||
      fields.website ||
      fields.address?.street ||
      fields.address?.full ||
      fields.vatNumber ||
      fields.taxCode
  );
}

export async function structureCardWithGemini(
  ocrText: string,
  apiKey: string,
  model: SupportedGeminiModel
): Promise<AiCardStructure | null> {
  const outcome = await structureCardWithGeminiVerbose(
    ocrText,
    apiKey,
    model
  );
  return outcome.ok ? outcome.value : null;
}

export async function structureCardWithGeminiVerbose(
  ocrText: string,
  apiKey: string,
  model: SupportedGeminiModel
): Promise<GeminiOperationOutcome<AiCardStructure>> {
  const provider = await generateGeminiJson({
    model,
    apiKey,
    parts: [
      { text: CARD_STRUCTURE_PROMPT },
      { text: wrapUntrustedOcrText(ocrText) },
    ],
  });
  if (!provider.ok) {
    edgeLogger.warn('GEMINI_PROVIDER_REJECTED', {
      ...(provider.httpStatus !== undefined
        ? { httpStatus: provider.httpStatus }
        : {}),
      status: provider.httpStatus ? 'rejected' : 'failed',
      stage: 'provider',
      reasonCode:
        provider.errorCode === 'AI_PROVIDER_RESPONSE_INVALID'
          ? 'response_invalid'
          : 'provider_rejected',
    });
    return provider;
  }

  const parsed = parseCardJsonResponse(provider.text, ocrText);
  if (!parsed || !hasAnyField(parsed)) {
    return { ok: false, errorCode: 'AI_PROVIDER_RESPONSE_INVALID' };
  }
  return {
    ok: true,
    value: parsed,
    ...(provider.usage !== undefined ? { usage: provider.usage } : {}),
  };
}
