import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Linking } from 'react-native';
import * as MailComposer from 'expo-mail-composer';
import { useTranslation } from 'react-i18next';
import { BusinessCard } from '../types';
import { mergeAiCardFields, normalizeAddress } from '../lib/parser';
import { structureCardTextWithAiVerbose } from '../lib/card-ai-structure';
import type {
  BusinessCardExtractionResult,
  EditorFieldKey,
} from '../lib/extraction-review';
import { fieldConfidence, isFieldInReview } from '../lib/extraction-review';
import { EditableField } from './EditableField';
import { ContactPhotoSection } from './ContactPhotoSection';
import { DocumentNotesField } from './DocumentNotesField';
import { ExtractionReviewBanner } from './ExtractionReviewBanner';
import { getDocumentNotes, withDocumentNotes } from '../lib/document-notes';
import {
  applyManualEmailEdit,
  getSafeContactEmails,
  sanitizeBusinessCardEmailState,
  unconfirmedEmailSuggestions,
} from '../lib/email-evidence';

import { GeminiConfirmationModal } from './GeminiConfirmationModal';
import { useLicense } from './LicenseProvider';
import { createLatestOperationController } from '../lib/guarded-operation';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';
import {
  applyContactCandidatePreservingManual,
  applyManualContactEdits,
  contactEmailDraftValues,
  ensureContactReviewState,
  recordAiApplication,
  type ContactFieldSnapshot,
} from '../lib/contact-review-state';

interface Props {
  card: BusinessCard;
  onChange: (card: BusinessCard) => void;
  isScreenActive: () => boolean;
  registerCancellation?: (cancel: (() => void) | null) => void;
  onFieldFocus?: () => void;
  editable?: boolean;
  /** Solo overlay UI; non modifica i valori salvati se passato lazy dal parent. */
  extractionReview?: BusinessCardExtractionResult | null;
}

function linesToList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function BusinessCardEditor({
  card,
  onChange,
  isScreenActive,
  registerCancellation,
  onFieldFocus,
  editable = true,
  extractionReview = null,
}: Props) {
  const { t } = useTranslation();
  const { updateAiCreditsRemaining } = useLicense();
  const [aiRunning, setAiRunning] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [showGeminiModal, setShowGeminiModal] = useState(false);
  const mountedRef = useRef(true);
  const cardRef = useRef(card);
  const aiOperationsRef = useRef(createLatestOperationController());
  const isScreenActiveRef = useRef(isScreenActive);
  isScreenActiveRef.current = isScreenActive;

  useEffect(() => {
    cardRef.current = card;
  }, [card]);

  const cancelAiOperation = useCallback(() => {
    aiOperationsRef.current.invalidateCurrent('screen_blurred');
    if (mountedRef.current) {
      setAiRunning(false);
      setShowGeminiModal(false);
    }
  }, []);

  useEffect(() => {
    registerCancellation?.(cancelAiOperation);
    return () => registerCancellation?.(null);
  }, [cancelAiOperation, registerCancellation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      aiOperationsRef.current.dispose();
    };
  }, []);

  const hasExtractionReview = extractionReview != null;
  const hasRawText = Boolean(card.rawText?.trim());
  const aiNeedsReview = Boolean(hasExtractionReview && extractionReview.needsReview);
  const safeEmails = getSafeContactEmails(card);
  const draftEmails = contactEmailDraftValues(card);
  const emailSuggestions = unconfirmedEmailSuggestions(
    card.emailEvidence ?? extractionReview?.emailEvidence
  );
  const emitChange = (next: BusinessCard) => {
    if (!editable) return;
    cardRef.current = next;
    onChange(next);
  };
  const patch = (fields: Partial<BusinessCard>) => {
    emitChange({ ...cardRef.current, ...fields });
  };
  const patchManual = (fields: Partial<ContactFieldSnapshot>) => {
    emitChange(applyManualContactEdits(cardRef.current, fields));
  };

  const fieldUi = (fieldName: EditorFieldKey) => {
    if (!hasExtractionReview || !extractionReview) return {};
    const inRev = isFieldInReview(extractionReview, fieldName);
    const conf = fieldConfidence(extractionReview, fieldName);
    return {
      reviewHighlight: inRev,
      confidence: conf ?? undefined,
    };
  };

  const aiButtonLabel = hasExtractionReview
    ? aiNeedsReview
      ? t('correctWithAiButton')
      : t('improveWithAiButton')
    : t('aiHelpButton');

  const handleAiButtonClick = () => {
    if (!editable || aiRunning || !isScreenActiveRef.current()) return;
    setShowGeminiModal(true);
  };

  const askAiForHelp = async () => {
    if (
      !mountedRef.current ||
      !isScreenActiveRef.current() ||
      !editable ||
      aiRunning
    ) {
      return;
    }
    setShowGeminiModal(false);
    const operation = aiOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      isScreenActiveRef.current() &&
      operation.isActive();
    setAiRunning(true);
    setAiMessage(null);
    const requestCard = cardRef.current;
    const requestContactId = requestCard.id;
    const requestRawText = requestCard.rawText ?? '';
    try {
      const outcome = await structureCardTextWithAiVerbose(requestRawText);
      if (!isActive()) return;
      if (outcome.status === 'not_configured') {
        setAiMessage(t('aiHelpNotConfigured'));
        return;
      }
      if (outcome.status === 'quota_exceeded') {
        setAiMessage(t('aiHelpQuotaExceeded'));
        return;
      }
      if (outcome.status === 'credits_exhausted') {
        setAiMessage(
          t('aiHelpCreditsExhausted')
        );
        return;
      }
      if (outcome.status === 'error') {
        setAiMessage(t('aiHelpError'));
        return;
      }
      if (typeof outcome.aiCreditsRemaining === 'number') {
        updateAiCreditsRemaining(outcome.aiCreditsRemaining);
      }
      const latestCard = cardRef.current;
      if (
        latestCard.id !== requestContactId ||
        (latestCard.rawText ?? '') !== requestRawText
      ) {
        setAiMessage(t('aiHelpNoChange'));
        return;
      }
      const candidate = sanitizeBusinessCardEmailState(
        mergeAiCardFields(latestCard, outcome.fields)
      );
      const merged = applyContactCandidatePreservingManual(
        latestCard,
        candidate,
        'ai'
      );
      if (merged.appliedFields.length > 0) {
        const applied = recordAiApplication(merged.appliedResult, merged.appliedFields);
        console.warn('[BusinessCardAI] applied', { fields: merged.appliedFields });
        emitChange(applied);
        setAiMessage(t('aiHelpSuccess'));
      } else {
        setAiMessage(t('aiHelpNoChange'));
      }
    } finally {
      const wasCurrent = aiOperationsRef.current.isCurrent(operation);
      if (wasCurrent) aiOperationsRef.current.finish(operation);
      if (
        wasCurrent &&
        mountedRef.current &&
        isScreenActiveRef.current()
      ) {
        setAiRunning(false);
      }
    }
  };

  const handleEmailAction = async () => {
    if (
      safeEmails.length === 0 ||
      !mountedRef.current ||
      !isScreenActiveRef.current()
    ) {
      return;
    }
    if (safeEmails.length === 1) {
      await MailComposer.composeAsync({ recipients: [safeEmails[0]] });
    } else {
      Alert.alert(t('emailChooseTitle'), t('emailChooseMessage'), [
        ...safeEmails.map((email) => ({
          text: email,
          onPress: () => {
            if (mountedRef.current && isScreenActiveRef.current()) {
              void MailComposer.composeAsync({ recipients: [email] });
            }
          },
        })),
        {
          text: t('emailSendAll'),
          onPress: () => {
            if (mountedRef.current && isScreenActiveRef.current()) {
              void MailComposer.composeAsync({ recipients: safeEmails });
            }
          },
        },
        { text: t('cancel'), style: 'cancel' },
      ]);
    }
  };

  const handlePhoneAction = () => {
    if (
      card.phones.length === 0 ||
      !mountedRef.current ||
      !isScreenActiveRef.current()
    ) {
      return;
    }
    if (card.phones.length === 1) {
      void Linking.openURL(`tel:${card.phones[0].number}`);
    } else {
      Alert.alert(t('phoneChooseTitle'), t('phoneChooseMessage'), [
        ...card.phones.map((phone) => ({
          text: phone.number,
          onPress: () => {
            if (mountedRef.current && isScreenActiveRef.current()) {
              void Linking.openURL(`tel:${phone.number}`);
            }
          },
        })),
        { text: t('cancel'), style: 'cancel' },
      ]);
    }
  };

  return (
    <>
      {extractionReview?.needsReview ? (
        <ExtractionReviewBanner reviewFieldCount={extractionReview.reviewFields.length} />
      ) : null}

      <ContactPhotoSection
        photoUri={card.contactPhotoUri}
        onChange={(contactPhotoUri) => patch({ contactPhotoUri })}
        editable={editable}
      />

      <Text style={styles.section}>{t('editDataSection')}</Text>

      <EditableField
        label={t('firstName')}
        value={card.firstName}
        onChangeText={(firstName) => patchManual({ firstName })}
        autoCapitalize="words"
        onFocus={onFieldFocus}
        editable={editable}
        {...fieldUi('firstName')}
      />
      <EditableField
        label={t('lastName')}
        value={card.lastName}
        onChangeText={(lastName) => patchManual({ lastName })}
        autoCapitalize="words"
        editable={editable}
        {...fieldUi('lastName')}
      />
      <EditableField
        label={t('role')}
        value={card.role}
        onChangeText={(role) => patchManual({ role })}
        editable={editable}
        {...fieldUi('role')}
      />
      <EditableField
        label={t('company')}
        value={card.company}
        onChangeText={(company) => patchManual({ company })}
        editable={editable}
        {...fieldUi('company')}
      />
      <EditableField
        label={t('emailsFieldHint')}
        value={draftEmails.join('\n')}
        onChangeText={(text) => {
          const edited = applyManualEmailEdit(
            ensureContactReviewState(cardRef.current),
            linesToList(text)
          );
          emitChange(
            applyManualContactEdits(edited, { emails: edited.emails })
          );
        }}
        multiline
        keyboardType="email-address"
        autoCapitalize="none"
        editable={editable}
        actionIcon={safeEmails.length > 0 ? 'mail' : undefined}
        onAction={handleEmailAction}
        {...fieldUi('emails')}
      />
      {emailSuggestions.length > 0 ? (
        <>
          <Text style={styles.suggestionTitle}>
            {t('emailSuggestionsTitle')}
          </Text>
          {emailSuggestions.map((suggestion) => (
            <TouchableOpacity
              key={`${suggestion.pageIndex}:${suggestion.lineId}:${suggestion.value}`}
              style={styles.suggestionButton}
              onPress={() => {
                const current = cardRef.current;
                const edited = applyManualEmailEdit(
                  ensureContactReviewState(current),
                  [...contactEmailDraftValues(current), suggestion.value]
                );
                emitChange(
                  applyManualContactEdits(edited, {
                    emails: edited.emails,
                  })
                );
              }}
              disabled={!editable}
            >
              <Text style={styles.suggestionValue}>{suggestion.value}</Text>
              <Text style={styles.suggestionAction}>
                {t('emailSuggestionConfirm')}
              </Text>
            </TouchableOpacity>
          ))}
          <Text style={styles.suggestionHint}>
            {t('emailSuggestionsHint')}
          </Text>
        </>
      ) : null}
      <EditableField
        label={t('phonesFieldHint')}
        value={card.phones.map((p) => p.number).join('\n')}
        onChangeText={(text) =>
          patchManual({
            phones: linesToList(text).map((number) => ({ number })),
          })
        }
        multiline
        keyboardType="phone-pad"
        editable={editable}
        actionIcon={card.phones.length > 0 ? 'call' : undefined}
        onAction={handlePhoneAction}
        {...fieldUi('phones')}
      />
      <EditableField
        label={t('website')}
        value={card.website ?? ''}
        onChangeText={(website) =>
          patchManual({ website: website || null })
        }
        autoCapitalize="none"
        editable={editable}
        {...fieldUi('website')}
      />
      <EditableField
        label={t('address')}
        value={card.address?.full ?? ''}
        onChangeText={(full) =>
          patchManual({
            address: full.trim() ? { full: full.trim() } : null,
          })
        }
        onBlur={() => {
          const currentAddress = cardRef.current.address;
          const normalized = normalizeAddress(currentAddress);
          if (normalized && normalized.full !== currentAddress?.full) {
            patchManual({ address: normalized });
          }
        }}
        multiline
        onFocus={onFieldFocus}
        editable={editable}
        {...fieldUi('address')}
      />
      <EditableField
        label={t('vatNumber')}
        value={card.vatNumber ?? ''}
        onChangeText={(vatNumber) =>
          patchManual({ vatNumber: vatNumber || null })
        }
        autoCapitalize="characters"
        editable={editable}
        {...fieldUi('vatNumber')}
      />
      <EditableField
        label={t('taxCode')}
        value={card.taxCode ?? ''}
        onChangeText={(taxCode) =>
          patchManual({ taxCode: taxCode || null })
        }
        autoCapitalize="characters"
        editable={editable}
        {...fieldUi('taxCode')}
      />

      <DocumentNotesField
        value={getDocumentNotes(card)}
        onChangeText={(notes) =>
          emitChange(
            withDocumentNotes(cardRef.current, notes) as BusinessCard
          )
        }
        onFocus={onFieldFocus}
        editable={editable}
      />

      {hasRawText ? (
        <>
          <TouchableOpacity
            style={[
              styles.aiButton,
              aiNeedsReview && styles.aiButtonCorrect,
              aiRunning && styles.aiButtonDisabled,
            ]}
            onPress={handleAiButtonClick}
            disabled={!editable || aiRunning}
          >
            {aiRunning ? (
              <ActivityIndicator color={colors.textDisabled} size="small" />
            ) : (
              <Text style={[styles.aiButtonText, !editable && styles.aiButtonTextDisabled]}>{aiButtonLabel}</Text>
            )}
          </TouchableOpacity>

          {aiMessage ? <Text style={styles.aiMessage}>{aiMessage}</Text> : null}

          <Text style={styles.section}>{t('rawOcrSection')}</Text>
          <Text style={styles.rawText} selectable>
            {card.rawText.trim()}
          </Text>
        </>
      ) : null}

      <GeminiConfirmationModal
        visible={showGeminiModal}
        onCancel={() => setShowGeminiModal(false)}
        onConfirm={askAiForHelp}
        // For card text support the server is the authoritative credit gate.
        // A stale/unavailable local balance must not render a consent dialog
        // whose only action is disabled; server response stays explicit.
        showCredits={false}
      />
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    ...typography.label,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  rawText: {
    ...typography.caption,
    color: colors.textSecondary,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
    fontFamily: 'monospace',
  },
  aiButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  aiButtonCorrect: {
    backgroundColor: colors.primaryPressed,
  },
  aiButtonDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  aiButtonText: {
    ...typography.button,
    color: colors.textOnPrimary,
    fontWeight: '700',
  },
  aiButtonTextDisabled: { color: colors.textDisabled },
  aiMessage: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: 16,
    fontStyle: 'italic',
  },
  suggestionTitle: {
    ...typography.label,
    color: colors.warning,
    marginTop: -4,
    marginBottom: 6,
  },
  suggestionButton: {
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  suggestionValue: {
    ...typography.bodySecondary,
    color: colors.textPrimary,
    flex: 1,
  },
  suggestionAction: {
    ...typography.label,
    color: colors.primary,
    fontWeight: '700',
  },
  suggestionHint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: 14,
  },
});
