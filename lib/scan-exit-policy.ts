import type { OperationInvalidationReason } from './guarded-operation';

export interface ScanExitGuard {
  hasUnsavedPages(): boolean;
  isBusy(): boolean;
  invalidateOperations(reason?: OperationInvalidationReason): void;
  discardAndCancel(reason?: OperationInvalidationReason): void;
}

export interface ScanExitPlan {
  invalidateBeforePrompt: boolean;
  requiresDiscardConfirmation: boolean;
  destination: 'back' | 'documents' | 'contacts';
}

export function planScanExit(input: {
  hasUnsavedPages: boolean;
  isBusy: boolean;
  hasHistory: boolean;
  documentType: 'business_card' | 'quote' | 'order' | 'invoice' | 'free_document';
}): ScanExitPlan {
  return {
    invalidateBeforePrompt: input.isBusy,
    requiresDiscardConfirmation: input.hasUnsavedPages,
    destination: input.hasHistory
      ? 'back'
      : input.documentType === 'business_card'
        ? 'contacts'
        : 'documents',
  };
}
