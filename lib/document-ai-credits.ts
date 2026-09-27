import { isRcCloudAiEnabled } from './release-rc-policy';

export type DocumentAiCreditState =
  | { kind: 'remaining'; value: number }
  | { kind: 'exhausted' }
  | { kind: 'unavailable' };

export function resolveDocumentAiCreditState(value: unknown): DocumentAiCreditState {
  if (!isRcCloudAiEnabled()) {
    return { kind: 'unavailable' };
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return { kind: 'unavailable' };
  }

  return value === 0
    ? { kind: 'exhausted' }
    : { kind: 'remaining', value };
}
