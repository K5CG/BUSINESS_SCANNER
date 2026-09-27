import type { OcrLine } from '../../types';
import { normalizeAddress } from '../address-format';
import {
  buildCardTitle,
  cardNeedsAiHelp,
  mergeAiCardFields,
  type AiCardFields,
  type CardFields,
} from './merge/ai-merge';
import { parseCard, parseCardFromPages, type CardPage } from './pipeline';
import { reconcileEmailsWithCardContext } from './resolve/reconcile';

export type { AiCardFields, CardFields, CardPage };
export {
  buildCardTitle,
  cardNeedsAiHelp,
  mergeAiCardFields,
  normalizeAddress,
  parseCard,
  parseCardFromPages,
  reconcileEmailsWithCardContext,
};

/** Re-export di comodo per consumer che importano `CardPage` insieme a `OcrLine`. */
export type { OcrLine };
