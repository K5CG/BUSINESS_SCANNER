import { Alert } from 'react-native';
import type { AnyDocument } from '../types';
import i18n from '../i18n';
import {
  findDocumentDuplicateMatch,
  type DocumentDuplicateKind,
  type DocumentDuplicateMatch,
} from './duplicate-documents';

export class DocumentDuplicateCancelledError extends Error {
  constructor() {
    super('DOCUMENT_DUPLICATE_CANCELLED');
    this.name = 'DocumentDuplicateCancelledError';
  }
}

export class DocumentDuplicateOpenExistingError extends Error {
  readonly existingId: string;

  constructor(existingId: string) {
    super('DOCUMENT_DUPLICATE_OPEN_EXISTING');
    this.name = 'DocumentDuplicateOpenExistingError';
    this.existingId = existingId;
  }
}

export type DocumentDuplicateUserDecision =
  | 'open_existing'
  | 'save_anyway'
  | 'cancel';

export type DocumentDuplicateResolution =
  | { decision: 'none'; match: null }
  | {
      decision: DocumentDuplicateUserDecision;
      match: DocumentDuplicateMatch;
    };

const TYPE_MESSAGE_KEYS: Record<string, string> = {
  quote: 'documentAlreadyExistsMessage_quote',
  order: 'documentAlreadyExistsMessage_order',
  invoice: 'documentAlreadyExistsMessage_invoice',
  free_document: 'documentAlreadyExistsMessage_free_document',
};

export function documentDuplicatePromptMessage(
  match: DocumentDuplicateMatch
): string {
  if (match.kind === 'possible') {
    return i18n.t('possibleDuplicateMessage');
  }
  const number = match.number ?? '';
  const typeKey = TYPE_MESSAGE_KEYS[match.document.type] ?? TYPE_MESSAGE_KEYS.free_document;
  return [
    i18n.t(typeKey, { number }),
    i18n.t('documentAlreadyExistsQuestion'),
  ].join('\n\n');
}

export function promptResolveDocumentDuplicate(
  match: DocumentDuplicateMatch
): Promise<DocumentDuplicateUserDecision> {
  const strong = match.kind === 'strong';
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t(strong ? 'documentAlreadyExistsTitle' : 'possibleDuplicateTitle'),
      documentDuplicatePromptMessage(match),
      [
        {
          text: i18n.t('cancel'),
          style: 'cancel',
          onPress: () => resolve('cancel'),
        },
        {
          text: i18n.t('saveAnyway'),
          onPress: () => resolve('save_anyway'),
        },
        {
          text: i18n.t(strong ? 'openExistingDocument' : 'viewExistingDocument'),
          onPress: () => resolve('open_existing'),
        },
      ],
      { cancelable: true, onDismiss: () => resolve('cancel') }
    );
  });
}

export async function resolveDocumentDuplicate(
  candidate: AnyDocument,
  options: {
    excludeDocumentId?: string;
    existing?: AnyDocument[];
  } = {}
): Promise<DocumentDuplicateResolution> {
  const pool =
    options.existing && options.existing.length > 0
      ? options.existing
      : await (await import('./storage')).getAllDocuments();
  const match = findDocumentDuplicateMatch(candidate, pool, {
    excludeDocumentId: options.excludeDocumentId,
  });
  if (!match) return { decision: 'none', match: null };
  const decision = await promptResolveDocumentDuplicate(match);
  return { decision, match };
}

export function isDocumentDuplicateDecisionError(
  error: unknown
): error is DocumentDuplicateCancelledError | DocumentDuplicateOpenExistingError {
  return (
    error instanceof DocumentDuplicateCancelledError ||
    error instanceof DocumentDuplicateOpenExistingError
  );
}

export type { DocumentDuplicateKind, DocumentDuplicateMatch };
