import { AnyDocument, BusinessCard } from '../types';
import { buildCardTitle } from './parser';
import {
  getSafeContactEmails,
  isActionableEmailEvidence,
} from './email-evidence';
import { redactContactReviewStateForExport } from './contact-review-state';

function safeEmailKey(value: string): string {
  return value.trim().toLowerCase();
}

function safeBusinessCardForExport(contact: BusinessCard): BusinessCard {
  const emails = getSafeContactEmails(contact);
  const allowed = new Set(emails.map(safeEmailKey));
  const emailEvidence =
    contact.emailEvidence === undefined
      ? undefined
      : contact.emailEvidence.filter(
          (item) =>
            isActionableEmailEvidence(item) &&
            allowed.has(safeEmailKey(item.value))
        );
  const extractionReview = contact.extractionReview
    ? {
        ...contact.extractionReview,
        emails: {
          ...contact.extractionReview.emails,
          value: emails,
        },
        ...(contact.extractionReview.emailEvidence === undefined
          ? {}
          : {
              emailEvidence: contact.extractionReview.emailEvidence.filter(
                (item) =>
                  isActionableEmailEvidence(item) &&
                  allowed.has(safeEmailKey(item.value))
              ),
            }),
      }
    : contact.extractionReview;
  const contactReviewState = redactContactReviewStateForExport(
    contact,
    emails
  );

  return {
    ...contact,
    emails,
    ...(emailEvidence === undefined ? {} : { emailEvidence }),
    ...(extractionReview === undefined ? {} : { extractionReview }),
    ...(contactReviewState === undefined ? {} : { contactReviewState }),
  };
}

export function getEmailSubject(document: AnyDocument): string {
  if (document.type === 'business_card') {
    const hasManualTitle =
      !!document.contactReviewState &&
      Object.prototype.hasOwnProperty.call(
        document.contactReviewState.manualOverrides,
        'title'
      );
    if (hasManualTitle) return document.title?.trim() || 'Contatto';
    return buildCardTitle(
      document.company,
      document.firstName,
      document.lastName
    );
  }
  return document.title?.trim() || 'Documento Business Scanner';
}

const OCR_EMAIL_TYPES = new Set(['quote', 'order', 'invoice', 'free_document']);

function displayDocumentText(value: string | undefined): string {
  return value?.trim() || '—';
}

function displayDocumentMoney(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `€${value.toFixed(2)}`
    : '—';
}

function appendRawOcrBlock(lines: string[], document: AnyDocument): void {
  const text = document.rawText?.trim();
  if (!text) return;
  lines.push('', '--- Testo letto dal documento ---', text);
}

function appendDocumentNotes(
  lines: string[],
  document: AnyDocument,
  emailNotes?: string
): void {
  const saved = document.notes?.trim();
  if (!saved) return;
  if (emailNotes?.trim() === saved) return;
  lines.push(`Note documento: ${saved}`);
}

export function exportToPlainText(
  document: AnyDocument,
  options: { emailNotes?: string } = {}
): string {
  const lines: string[] = [];

  if (options.emailNotes?.trim()) {
    lines.push(`Note: ${options.emailNotes.trim()}`, '');
  }

  if (OCR_EMAIL_TYPES.has(document.type)) {
    appendRawOcrBlock(lines, document);
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push('--- Dati rilevati ---');
  }

  switch (document.type) {
    case 'business_card': {
      const emails = getSafeContactEmails(document);
      if (document.company) lines.push(`Azienda: ${document.company}`);
      const name = [document.firstName, document.lastName].filter(Boolean).join(' ');
      if (name) lines.push(`Nome: ${name}`);
      if (document.role) lines.push(`Ruolo: ${document.role}`);
      emails.forEach((e, i) =>
        lines.push(`Email${emails.length > 1 ? ` ${i + 1}` : ''}: ${e}`)
      );
      document.phones.forEach((p, i) => {
        if (p.type === 'fax') {
          lines.push(`Fax: ${p.number}`);
          return;
        }
        const voicePhones = document.phones.filter((phone) => phone.type !== 'fax');
        const voiceIndex = voicePhones.indexOf(p) + 1;
        lines.push(
          `Telefono${voicePhones.length > 1 ? ` ${voiceIndex}` : ''}: ${p.number}`
        );
      });
      if (document.website) lines.push(`Sito web: ${document.website}`);
      if (document.address?.full) lines.push(`Indirizzo: ${document.address.full}`);
      if (document.vatNumber) lines.push(`P.IVA: ${document.vatNumber}`);
      if (document.taxCode) lines.push(`Codice fiscale: ${document.taxCode}`);
      if (document.notes?.trim()) {
        const emailNote = options.emailNotes?.trim();
        if (!emailNote || emailNote !== document.notes.trim()) {
          lines.push(`Note: ${document.notes.trim()}`);
        }
      }
      break;
    }
    case 'quote': {
      lines.push(`Preventivo n.: ${displayDocumentText(document.quoteNumber)}`);
      lines.push(`Cliente: ${displayDocumentText(document.customerName)}`);
      if (document.customerVat) lines.push(`P.IVA cliente: ${document.customerVat}`);
      if (document.items.length > 0) {
        lines.push('', 'Dettaglio righe:');
        document.items.forEach((item, i) => {
          lines.push(
            `${i + 1}. ${item.description} — qtà ${item.quantity} — ${displayDocumentMoney(item.total)}`
          );
        });
      }
      lines.push(`Totale: ${displayDocumentMoney(document.total)}`);
      appendDocumentNotes(lines, document, options.emailNotes);
      break;
    }
    case 'order': {
      lines.push(`Ordine n.: ${displayDocumentText(document.orderNumber)}`);
      lines.push(`Cliente: ${displayDocumentText(document.customerName)}`);
      if (document.customerVat) lines.push(`P.IVA cliente: ${document.customerVat}`);
      if (document.items.length > 0) {
        lines.push('', 'Dettaglio righe:');
        document.items.forEach((item, i) => {
          lines.push(
            `${i + 1}. ${item.description} — qtà ${item.quantity} — ${displayDocumentMoney(item.total)}`
          );
        });
      }
      lines.push(`Totale: ${displayDocumentMoney(document.total)}`);
      appendDocumentNotes(lines, document, options.emailNotes);
      break;
    }
    case 'invoice': {
      lines.push(`Fattura n.: ${displayDocumentText(document.invoiceNumber)}`);
      lines.push(`Cliente: ${displayDocumentText(document.customerName)}`);
      if (document.customerVat) lines.push(`P.IVA cliente: ${document.customerVat}`);
      if (document.items.length > 0) {
        lines.push('', 'Dettaglio righe:');
        document.items.forEach((item, i) => {
          lines.push(
            `${i + 1}. ${item.description} — qtà ${item.quantity} — ${displayDocumentMoney(item.total)}`
          );
        });
      }
      lines.push(`Totale: ${displayDocumentMoney(document.total)}`);
      appendDocumentNotes(lines, document, options.emailNotes);
      break;
    }
    case 'free_document':
      if (document.documentNumber) lines.push(`Numero: ${document.documentNumber}`);
      if (document.subject) lines.push(`Oggetto: ${document.subject}`);
      Object.entries(document.extractedFields).forEach(([k, v]) => lines.push(`${k}: ${v}`));
      appendDocumentNotes(lines, document, options.emailNotes);
      break;
  }

  lines.push('', '— Business Scanner');
  return lines.join('\n');
}

export {
  buildVCardFileName,
  escapeVCardText,
  exportToVCard,
  sanitizeVCardFileToken,
  vCardTelType,
} from './export-vcard';

export function exportToJson(document: AnyDocument): string {
  return JSON.stringify(
    document.type === 'business_card'
      ? safeBusinessCardForExport(document)
      : document,
    null,
    2
  );
}

export function exportToCsv(document: AnyDocument): string {
  if (document.type === 'business_card') {
    const emails = getSafeContactEmails(document);
    return [
      'firstName,lastName,company,role,email,phone,website',
      [
        document.firstName,
        document.lastName,
        document.company,
        document.role,
        emails[0] ?? '',
        document.phones[0]?.number ?? '',
        document.website ?? '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    ].join('\n');
  }

  if (
    document.type === 'quote' ||
    document.type === 'order' ||
    document.type === 'invoice'
  ) {
    const number =
      document.type === 'quote'
        ? document.quoteNumber
        : document.type === 'order'
          ? document.orderNumber
          : document.invoiceNumber;
    return [
      'number,customer,subtotal,vat,total,currency',
      [number, document.customerName, document.subtotal, document.vatAmount, document.total, document.currency]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(','),
    ].join('\n');
  }

  const fields = Object.entries(document.extractedFields)
    .map(([k, v]) => `"${k}","${v.replace(/"/g, '""')}"`)
    .join('\n');
  return `field,value\n${fields}`;
}
