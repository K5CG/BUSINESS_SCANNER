import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  Alert,
  ScrollView,
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  useWindowDimensions,
} from 'react-native';
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
  router,
} from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  useDocumentStore,
  DocumentDuplicateCancelledError,
  DocumentDuplicateOpenExistingError,
} from '../../store/useDocumentStore';
import { resolveDocumentDuplicate } from '../../lib/document-duplicate-guard';
import {
  useContactStore,
  DuplicateContactCancelledError,
  DuplicateContactStaleError,
} from '../../store/useContactStore';
import { getDocumentById, getContactById } from '../../lib/storage';
import { readAfterPersistenceSettles } from '../../lib/persistence';
import { AnyDocument, BusinessCard } from '../../types';
import { useTranslation } from 'react-i18next';
import { DocumentImagesPreview } from '../../components/DocumentImagesPreview';
import { DocumentHybridReview } from '../../components/DocumentHybridReview';
import { DocumentPageExtractionReview } from '../../components/DocumentPageExtractionReview';
import {
  DocumentReviewAlerts,
  DocumentStructuredDetails,
} from '../../components/DocumentStructuredDetails';
import { OcrQualityIndicator } from '../../components/OcrQualityIndicator';
import { BusinessCardEditor } from '../../components/BusinessCardEditor';
import { EditableField } from '../../components/EditableField';
import { DocumentNotesField } from '../../components/DocumentNotesField';
import { GeminiConfirmationModal } from '../../components/GeminiConfirmationModal';
import { getDocumentNotes, withDocumentNotes } from '../../lib/document-notes';
import { normalizeAddress } from '../../lib/address-format';
import { showSaveToast } from '../../lib/save-toast';
import { useKeyboardInset } from '../../lib/use-keyboard-inset';
import {
  applyBusinessCardReocrProposal,
  buildBusinessCardReocrProposal,
  buildBusinessCardReparseProposal,
  rotateDraftBusinessCardImagePage,
  type BusinessCardReocrProposalResult,
} from '../../lib/contact-reparse';
import {
  parseSparseDocumentPageFields,
} from '../../lib/document-parser';
import {
  applyUserDocumentFieldEdit,
  type DocumentUserEditableField,
} from '../../lib/document-field-merge-application';
import { buildDocumentFromExtract } from '../../lib/document-from-extract';
import { extractDocumentWithGeminiVerbose } from '../../lib/gemini-ocr';
import { runDocumentAiReview } from '../../lib/document-ai-review';
import { reconcileStructuredDocument } from '../../lib/document-ai-reconciler';
import { validateStructuredAiDocument } from '../../lib/document-deterministic-validation';
import {
  createHybridDocumentReview,
  decideHybridReview,
  hybridFieldCanAccept,
  hybridReviewCanSave,
  materializeAcceptedHybridDocument,
  setHybridManualValue,
  type HybridDocumentReviewState,
} from '../../lib/document-hybrid-review';
import { scanDocumentBest } from '../../lib/ocr';
import { legacyOcrQualityMetadata } from '../../lib/ocr-quality';
import {
  BusinessCardExtractionResult,
  EXPERIMENTAL_EXTRACTION_REVIEW,
  pagesFromRawText,
  computeExtractionReview,
} from '../../lib/extraction-review';
import { createLatestOperationController } from '../../lib/guarded-operation';
import { isInactiveScanOperationError } from '../../lib/scan-operation-lifecycle';
import { cleanupScanSessionImageUri } from '../../lib/draft-image-storage';
import { runtimeLogger } from '../../lib/safe-runtime-logger';
import { createExclusiveOperationGate } from '../../lib/exclusive-operation-gate';
import { ContactReparseProposalModal } from '../../components/ContactReparseProposalModal';
import { useLicense } from '../../components/LicenseProvider';
import type {
  ContactReparseFieldKey,
  ContactReparseProposal,
} from '../../lib/contact-review-state';
import { colors } from '../../lib/ui-theme';
import {
  getScrollableBottomPadding,
  getUiViewportLayout,
} from '../../lib/ui-layout';
import { radii, spacing, typography } from '../../lib/ui-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveDocumentAiCreditState } from '../../lib/document-ai-credits';
import { traceScan } from '../../lib/scan-trace';
import {
  acceptAllPendingHybridReview,
  countHybridReviewDecisions,
  hasPendingHybridReview,
} from '../../lib/document-ai-review-actions';

function logDocumentAiDiagnostic(event: string, diagnostic?: Record<string, unknown>) {
  runtimeLogger.debug('DOCUMENT_AI_DIAGNOSTIC', undefined, { event, ...diagnostic });
}

export default function DocumentScreen() {
  const { id, partial } = useLocalSearchParams<{ id: string; partial?: string }>();
  const { updateDocument, removeDocument, documents } = useDocumentStore();
  const {
    updateContact,
    removeContact,
    addContact,
    clearDraftContact,
    setDraftContact,
    rotateContactImagePage,
  } = useContactStore();
  const [document, setDocument] = useState<AnyDocument | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  const [isDraft, setIsDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [imageRotationRunning, setImageRotationRunning] = useState(false);
  const [documentAiRunning, setDocumentAiRunning] = useState(false);
  const [documentAiMessage, setDocumentAiMessage] = useState<string | null>(null);
  const [showDocumentAiModal, setShowDocumentAiModal] = useState(false);
  const [hybridReview, setHybridReview] = useState<HybridDocumentReviewState | null>(null);
  const [hybridBaseDocument, setHybridBaseDocument] = useState<AnyDocument | null>(null);
  const [hybridPersistenceRunning, setHybridPersistenceRunning] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [lazyExtractionReview, setLazyExtractionReview] = useState<BusinessCardExtractionResult | null>(
    null
  );
  const [reparseProposal, setReparseProposal] =
    useState<ContactReparseProposal | null>(null);
  const [pendingReocr, setPendingReocr] =
    useState<BusinessCardReocrProposalResult | null>(null);
  const { t } = useTranslation();
  const { status: licenseStatus, loading: licenseLoading, updateAiCreditsRemaining } = useLicense();
  const { width, fontScale } = useWindowDimensions();
  const responsive = getUiViewportLayout(width, fontScale);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const scrollRef = useRef<ScrollView>(null);
  const keyboardInset = useKeyboardInset();
  const documentAiCreditState = resolveDocumentAiCreditState(
    !licenseLoading &&
      licenseStatus.access === 'active' &&
      'aiCreditsRemaining' in licenseStatus
      ? licenseStatus.aiCreditsRemaining
      : undefined
  );
  const mountedRef = useRef(true);
  const screenActiveRef = useRef(false);
  const loadOperationsRef = useRef(createLatestOperationController());
  const actionOperationsRef = useRef(createLatestOperationController());
  const saveExportGateRef = useRef(createExclusiveOperationGate());
  const documentRef = useRef<AnyDocument | null>(null);
  const isDraftRef = useRef(false);
  const draftPersistenceOwnerRef = useRef<string | null>(null);
  const draftCleanupRequestedRef = useRef(false);
  const businessEditorCancellationRef = useRef<(() => void) | null>(null);
  const imageRotationRunningRef = useRef(false);
  const persistenceRunningRef = useRef(false);
  const hybridPersistenceRef = useRef(false);
  const reloadAfterInactiveMutationRef = useRef(false);
  const partialNoticeShownRef = useRef(false);
  const aiReviewTopYRef = useRef(0);
  const scrollToAiReviewRequestedRef = useRef(false);
  const [showPartialNotice, setShowPartialNotice] = useState(false);

  documentRef.current = document;
  isDraftRef.current = isDraft;

  const handleRotationStateChange = useCallback((running: boolean) => {
    imageRotationRunningRef.current = running;
    if (running) {
      businessEditorCancellationRef.current?.();
      setReparseProposal(null);
      setPendingReocr(null);
    }
    if (mountedRef.current) setImageRotationRunning(running);
  }, []);

  const cleanupDraftAssets = useCallback(() => {
    const storeDraft = useContactStore.getState().draftContact;
    const routeId = String(id ?? '').trim();
    const storeOwnsRouteDraft =
      !!routeId && storeDraft?.id === routeId;
    const current = storeOwnsRouteDraft ? storeDraft : documentRef.current;
    if (
      (!isDraftRef.current && !storeOwnsRouteDraft) ||
      current?.type !== 'business_card'
    ) {
      return;
    }
    const card = current as BusinessCard;
    clearDraftContact(card.id);
    for (const uri of [...card.images, ...(card.originalImages ?? []), card.contactPhotoUri].filter(
      (value): value is string => typeof value === 'string' && !!value.trim()
    )) {
      void cleanupScanSessionImageUri(uri);
    }
    draftCleanupRequestedRef.current = false;
    isDraftRef.current = false;
  }, [clearDraftContact, id]);

  const requestDraftCleanup = useCallback(() => {
    const routeId = String(id ?? '').trim();
    const storeOwnsRouteDraft =
      !!routeId &&
      useContactStore.getState().draftContact?.id === routeId;
    if (!isDraftRef.current && !storeOwnsRouteDraft) return;
    if (draftPersistenceOwnerRef.current) {
      draftCleanupRequestedRef.current = true;
      return;
    }
    cleanupDraftAssets();
  }, [cleanupDraftAssets, id]);

  const releaseDraftPersistence = useCallback(
    (operationId: string) => {
      if (draftPersistenceOwnerRef.current !== operationId) return;
      draftPersistenceOwnerRef.current = null;
      if (draftCleanupRequestedRef.current) cleanupDraftAssets();
    },
    [cleanupDraftAssets]
  );

  const cancelScreenOperations = useCallback(() => {
    if (
      imageRotationRunningRef.current ||
      persistenceRunningRef.current
    ) {
      reloadAfterInactiveMutationRef.current = true;
    }
    loadOperationsRef.current.invalidateCurrent('screen_blurred');
    actionOperationsRef.current.invalidateCurrent('screen_blurred');
    saveExportGateRef.current.invalidateCurrent();
    businessEditorCancellationRef.current?.();
    imageRotationRunningRef.current = false;
    persistenceRunningRef.current = false;
    if (mountedRef.current) {
      setReparseProposal(null);
      setImageRotationRunning(false);
      setSaving(false);
      setDocumentAiRunning(false);
      setShowDocumentAiModal(false);
      setShowTechnicalDetails(false);
    }
  }, []);

  const registerBusinessEditorCancellation = useCallback(
    (cancel: (() => void) | null) => {
      businessEditorCancellationRef.current = cancel;
    },
    []
  );

  const isReviewScreenActive = useCallback(
    () => mountedRef.current && screenActiveRef.current,
    []
  );

  const handleBack = useCallback(() => {
    cancelScreenOperations();
    requestDraftCleanup();
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(
        documentRef.current?.type === 'business_card'
          ? '/(tabs)/contacts'
          : '/(tabs)/documents'
      );
    }
  }, [cancelScreenOperations, requestDraftCleanup]);

  // Il triangolo Android deve avere lo stesso comportamento della freccia
  // nell'header. La registrazione e' limitata alla schermata in primo piano,
  // cosi' non resta attiva dopo il ritorno alla lista o durante una scansione.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          handleBack();
          return true;
        }
      );
      return () => subscription.remove();
    }, [handleBack])
  );

  useEffect(() => {
    mountedRef.current = true;
    saveExportGateRef.current = createExclusiveOperationGate();
    return () => {
      mountedRef.current = false;
      screenActiveRef.current = false;
      loadOperationsRef.current.dispose();
      actionOperationsRef.current.dispose();
      saveExportGateRef.current.dispose();
      requestDraftCleanup();
    };
  }, [requestDraftCleanup]);

  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        cancelScreenOperations();
        requestDraftCleanup();
      }),
    [cancelScreenOperations, navigation, requestDraftCleanup]
  );

  const handleDocumentFieldEdit = useCallback(
    (field: DocumentUserEditableField, rawValue: unknown) => {
      setDocument((current) => {
        if (!current) return current;
        const edited = applyUserDocumentFieldEdit(current, field, rawValue);
        if (!hybridReview) return edited;
        const reviewPath = field === 'date'
          ? 'issueDate'
          : field === 'vatNumber'
            ? 'customerVatNumber'
            : field;
        if (!hybridReview.decisions[reviewPath]) return edited;
        const nextReview = decideHybridReview(hybridReview, reviewPath, 'manual');
        const editedWithReview = { ...edited, aiReviewState: nextReview };
        setHybridReview(nextReview);
        // Manual edits become the new local base for later pending AI decisions.
        // They are persisted by the normal Save action, never overwritten by a later Accept.
        setHybridBaseDocument(editedWithReview);
        logDocumentAiDiagnostic('field_manual', { documentId: current.id, path: reviewPath });
        return editedWithReview;
      });
    },
    [hybridReview]
  );

  const scrollToEnd = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 300);
  }, []);

  const handleAiReviewLayout = useCallback((event: { nativeEvent: { layout: { y: number } } }) => {
    aiReviewTopYRef.current = event.nativeEvent.layout.y;
    if (!scrollToAiReviewRequestedRef.current) return;
    scrollToAiReviewRequestedRef.current = false;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, aiReviewTopYRef.current - spacing.sm), animated: true });
    });
  }, []);

  const loadOnce = useCallback(async () => {
    if (!id) return;
    const operation = loadOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    setLoading(true);
    try {
      const fromDb = await readAfterPersistenceSettles(async () => {
        const contact = await getContactById(id);
        return contact ?? (await getDocumentById(id));
      });
      if (!isActive()) return;
      if (fromDb) {
        documentRef.current = fromDb;
        setDocument(fromDb);
        setIsDraft(false);
        if (fromDb.type !== 'business_card' && fromDb.aiReviewState) {
          setHybridReview(fromDb.aiReviewState);
          setHybridBaseDocument(fromDb);
          logDocumentAiDiagnostic('review_reload', {
            documentId: fromDb.id,
            decisions: countHybridReviewDecisions(fromDb.aiReviewState),
          });
        } else {
          setHybridReview(null);
          setHybridBaseDocument(null);
        }
        return;
      }
      const draft = useContactStore.getState().draftContact;
      if (draft?.id === id && isActive()) {
        documentRef.current = draft;
        setDocument(draft);
        setIsDraft(true);
      }
    } catch {
      if (!isActive()) return;
      documentRef.current = null;
      setDocument(null);
      Alert.alert(t('error'), t('captureFailed'));
    } finally {
      const wasCurrent = loadOperationsRef.current.isCurrent(operation);
      if (wasCurrent) loadOperationsRef.current.finish(operation);
      if (wasCurrent && mountedRef.current && screenActiveRef.current) {
        setLoading(false);
      }
    }
  }, [id, t]);

  const reconcileAfterInactiveMutation = useCallback(() => {
    reloadAfterInactiveMutationRef.current = true;
    if (mountedRef.current && screenActiveRef.current) {
      reloadAfterInactiveMutationRef.current = false;
      void loadOnce();
    }
  }, [loadOnce]);

  useFocusEffect(
    useCallback(() => {
      screenActiveRef.current = true;
      reloadAfterInactiveMutationRef.current = false;
      void loadOnce();
      return () => {
        screenActiveRef.current = false;
        cancelScreenOperations();
      };
    }, [cancelScreenOperations, loadOnce])
  );

  useEffect(() => {
    if (loading || partial !== '1' || partialNoticeShownRef.current || !document) return;
    if (document.type === 'business_card') return;
    partialNoticeShownRef.current = true;
    setShowPartialNotice(true);
    const timer = setTimeout(() => {
      if (mountedRef.current) setShowPartialNotice(false);
    }, 8000);
    return () => clearTimeout(timer);
  }, [document, loading, partial]);

  useEffect(() => {
    if (!document || document.type !== 'business_card') {
      setLazyExtractionReview(null);
      return;
    }
    const card = document as BusinessCard;
    if (card.extractionReview) {
      setLazyExtractionReview(null);
      return;
    }
    if (!EXPERIMENTAL_EXTRACTION_REVIEW || !card.rawText?.trim()) {
      setLazyExtractionReview(null);
      return;
    }
    const pages = pagesFromRawText(card.rawText);
    const timer = setTimeout(() => {
      setLazyExtractionReview(computeExtractionReview(pages));
    }, 0);
    return () => clearTimeout(timer);
  }, [document?.id, document?.type, (document as BusinessCard | undefined)?.extractionReview, (document as BusinessCard | undefined)?.rawText]);

  const persistAndVerifyAiReview = useCallback(async (
    candidate: AnyDocument & { aiReviewState: HybridDocumentReviewState },
    reason: 'review_created' | 'field_decision' | 'accept_all',
    acceptedCount = 0,
  ): Promise<AnyDocument> => {
    logDocumentAiDiagnostic('persist_start', {
      documentId: candidate.id,
      reason,
      acceptedCount,
    });
    const persisted = await updateDocument(candidate);
    const verified = await readAfterPersistenceSettles(() => getDocumentById(persisted.id));
    if (!verified?.aiReviewState) {
      throw new Error('AI_REVIEW_STATE_NOT_PERSISTED');
    }
    const expectedDecisions = countHybridReviewDecisions(candidate.aiReviewState);
    const verifiedDecisions = countHybridReviewDecisions(verified.aiReviewState);
    if (JSON.stringify(expectedDecisions) !== JSON.stringify(verifiedDecisions)) {
      throw new Error('AI_REVIEW_DECISIONS_NOT_PERSISTED');
    }
    logDocumentAiDiagnostic('persist_done', {
      documentId: verified.id,
      reason,
      acceptedCount,
      decisions: verifiedDecisions,
    });
    return verified;
  }, [updateDocument]);

  const openDocumentAiModal = useCallback(() => {
    if (
      !document ||
      document.type === 'business_card' ||
      document.images.length === 0 ||
      documentAiRunning
    ) {
      return;
    }
    Keyboard.dismiss();
    setDocumentAiMessage(null);
    setShowDocumentAiModal(true);
  }, [document, documentAiRunning]);

  const handleDocumentAiConfirm = useCallback(async () => {
    setShowDocumentAiModal(false);
    if (
      !document ||
      document.type === 'business_card' ||
      documentAiRunning
    ) {
      return;
    }

    const localDocument = document;
    if (!screenActiveRef.current) return;
    const operation = actionOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    setDocumentAiRunning(true);
    setDocumentAiMessage(null);
    let latestAiCreditsRemaining: number | undefined;
    try {
      logDocumentAiDiagnostic('review_start', {
        documentId: localDocument.id,
        pageCount: localDocument.images.length,
      });
      const outcome = await runDocumentAiReview(
        'confirm',
        localDocument,
        async (imageUri, pageIndex, pageCount) => {
          const currentPage = (pageIndex ?? 0) + 1;
          const totalPages = pageCount ?? localDocument.images.length;
          setDocumentAiMessage(
            t('documentAiProgressPage', { current: currentPage, total: totalPages })
          );
          logDocumentAiDiagnostic('provider_start', {
            documentId: localDocument.id,
            pageIndex: pageIndex ?? 0,
            pageCount: totalPages,
          });
          const pageOutcome = await extractDocumentWithGeminiVerbose(
            imageUri,
            pageIndex,
            pageCount
          );
          logDocumentAiDiagnostic('provider_done', {
            documentId: localDocument.id,
            pageIndex: pageIndex ?? 0,
            status: pageOutcome.status,
            ...(pageOutcome.status === 'ok' && typeof pageOutcome.aiCreditsRemaining === 'number'
              ? { aiCreditsRemaining: pageOutcome.aiCreditsRemaining }
              : {}),
          });
          if (
            pageOutcome.status === 'ok' &&
            typeof pageOutcome.aiCreditsRemaining === 'number'
          ) {
            latestAiCreditsRemaining = pageOutcome.aiCreditsRemaining;
          }
          return pageOutcome;
        },
        buildDocumentFromExtract,
        scanDocumentBest,
        parseSparseDocumentPageFields
      );
      if (!isActive()) return;
      if (typeof latestAiCreditsRemaining === 'number') {
        updateAiCreditsRemaining(latestAiCreditsRemaining, 'document');
      }

      if (outcome.status === 'ok') {
        if (outcome.aiExtract.structured && localDocument.structuredExtraction) {
          const reconciliation = reconcileStructuredDocument({
            local: localDocument.structuredExtraction,
            ai: outcome.aiExtract.structured,
            ocrText: localDocument.rawText,
          });
          const validation = validateStructuredAiDocument(outcome.aiExtract.structured);
          const review = createHybridDocumentReview(reconciliation, validation);
          const proposalCount = Object.values(review.decisions).filter((decision) => decision === 'pending').length;
          logDocumentAiDiagnostic('proposals_built', {
            documentId: localDocument.id,
            proposalCount,
          });
          const reviewDocument = { ...localDocument, aiReviewState: review };
          const persistedReview = await persistAndVerifyAiReview(reviewDocument, 'review_created');
          if (!isActive()) return;
          scrollToAiReviewRequestedRef.current = true;
          documentRef.current = persistedReview;
          setDocument(persistedReview);
          setHybridBaseDocument(persistedReview);
          setHybridReview(review);
          setDocumentAiMessage(t('documentHybridReviewReady'));
          return;
        }
        setDocumentAiMessage(t('documentHybridSchemaUnavailable'));
        return;
      }
      if (outcome.status === 'not_configured') {
        setDocumentAiMessage(t('documentAiNotConfigured'));
        return;
      }
      if (outcome.status === 'cancelled') {
        return;
      }
      if (outcome.status === 'error') {
        if (outcome.reason === 'credits_exhausted') {
          setDocumentAiMessage(t('documentAiCreditsExhausted'));
          return;
        }
        if (outcome.reason === 'provider_unavailable') {
          const message = t('documentAiConnectionError');
          setDocumentAiMessage(message);
          logDocumentAiDiagnostic('review_abort', {
            documentId: localDocument.id,
            reason: 'provider_unavailable',
          });
          Alert.alert(
            t('documentAiConnectionErrorTitle'),
            message,
            [
              { text: t('documentAiClose'), style: 'cancel' },
              {
                text: t('documentAiRetry'),
                onPress: () => {
                  if (mountedRef.current && screenActiveRef.current) {
                    setDocumentAiMessage(null);
                    setShowDocumentAiModal(true);
                  }
                },
              },
            ]
          );
          return;
        }
        setDocumentAiMessage(t('documentAiError'));
        return;
      }
    } catch (error) {
      runtimeLogger.error('DOCUMENT_AI_FAILED', error, {
        stage: 'persist',
        status: 'failed',
      });
      if (isActive()) setDocumentAiMessage(t('documentHybridPersistError'));
    } finally {
      const wasCurrent = actionOperationsRef.current.isCurrent(operation);
      if (wasCurrent) actionOperationsRef.current.finish(operation);
      if (wasCurrent && mountedRef.current && screenActiveRef.current) {
        setDocumentAiRunning(false);
      }
    }
  }, [document, documentAiRunning, persistAndVerifyAiReview, t, updateAiCreditsRemaining]);

  const projectAcceptedDocumentIdentity = useCallback((
    candidate: AnyDocument,
    review: HybridDocumentReviewState,
  ): AnyDocument => {
    if (candidate.type === 'business_card') return candidate;

    let projected = candidate;
    if (review.decisions.documentNumber === 'accepted' || review.decisions.documentNumber === 'manual') {
      const numberValue = review.decisions.documentNumber === 'manual'
        ? review.reconciliation.fields.documentNumber?.selectedValue
        : review.reconciliation.fields.documentNumber?.aiValue;
      if (numberValue !== undefined && numberValue !== null && String(numberValue).trim()) {
        const number = String(numberValue).trim();
        if (projected.type === 'free_document') {
          projected = { ...projected, documentNumber: number, title: `Documento ${number}` };
        } else if (projected.type === 'quote') {
          projected = { ...projected, quoteNumber: number, title: `Preventivo ${number}` };
        } else if (projected.type === 'order') {
          projected = { ...projected, orderNumber: number, title: `Ordine ${number}` };
        } else if (projected.type === 'invoice') {
          projected = { ...projected, invoiceNumber: number, title: `Fattura ${number}` };
        }
      }
    }

    if (review.decisions.issueDate === 'accepted' || review.decisions.issueDate === 'manual') {
      const dateValue = review.decisions.issueDate === 'manual'
        ? review.reconciliation.fields.issueDate?.selectedValue
        : review.reconciliation.fields.issueDate?.aiValue;
      if (dateValue !== undefined && dateValue !== null) {
        const date = new Date(String(dateValue));
        if (!Number.isNaN(date.getTime())) {
          if (projected.type === 'free_document') projected = { ...projected, documentDate: date };
          else if (projected.type === 'quote') projected = { ...projected, quoteDate: date };
          else if (projected.type === 'order') projected = { ...projected, orderDate: date };
          else if (projected.type === 'invoice') projected = { ...projected, invoiceDate: date };
        }
      }
    }

    return projected;
  }, []);

  const persistHybridReview = useCallback(async (
    nextReview: HybridDocumentReviewState,
    reason: 'field_decision' | 'accept_all',
    acceptedPaths: readonly string[] = [],
  ) => {
    if (!document || document.type === 'business_card' || hybridPersistenceRef.current) return;
    const base = hybridBaseDocument ?? document;
    const materialized = materializeAcceptedHybridDocument(base, nextReview);
    const projected = projectAcceptedDocumentIdentity(materialized, nextReview);
    const candidate = { ...projected, aiReviewState: nextReview };
    hybridPersistenceRef.current = true;
    persistenceRunningRef.current = true;
    setHybridPersistenceRunning(true);
    try {
      const persisted = await persistAndVerifyAiReview(candidate, reason, acceptedPaths.length);
      if (!mountedRef.current || !screenActiveRef.current) return;
      documentRef.current = persisted;
      setDocument(persisted);
      setHybridReview(nextReview);
      setHybridBaseDocument(persisted);
    } catch (error) {
      runtimeLogger.error('DOCUMENT_AI_FAILED', error, {
        stage: 'persist',
        status: 'failed',
      });
      if (mountedRef.current && screenActiveRef.current) setDocumentAiMessage(t('documentHybridPersistError'));
    } finally {
      hybridPersistenceRef.current = false;
      persistenceRunningRef.current = false;
      if (mountedRef.current && screenActiveRef.current) setHybridPersistenceRunning(false);
    }
  }, [document, hybridBaseDocument, persistAndVerifyAiReview, projectAcceptedDocumentIdentity, t]);

  const handleHybridDecision = useCallback((
    path: string,
    decision: 'accepted' | 'rejected' | 'manual',
  ) => {
    if (decision === 'accepted' && (!hybridReview || !hybridFieldCanAccept(hybridReview, path))) return;
    if (!hybridReview || hybridPersistenceRef.current) return;
    const next = decideHybridReview(hybridReview, path, decision);
    logDocumentAiDiagnostic(`field_${decision}`, { documentId: document?.id ?? null, path });
    void persistHybridReview(next, 'field_decision', decision === 'accepted' ? [path] : []);
  }, [document?.id, hybridReview, persistHybridReview]);

  const handleHybridManualValue = useCallback((path: string, rawValue: unknown) => {
    if (!hybridReview || !document || document.type === 'business_card' || hybridPersistenceRef.current) return;
    const nextReview = setHybridManualValue(hybridReview, path, rawValue);
    if (nextReview === hybridReview) return;
    const base = hybridBaseDocument ?? document;
    const materialized = materializeAcceptedHybridDocument(base, nextReview);
    const projected = projectAcceptedDocumentIdentity(materialized, nextReview);
    const candidate = { ...projected, aiReviewState: nextReview };
    documentRef.current = candidate;
    setDocument(candidate);
    setHybridReview(nextReview);
    setHybridBaseDocument(candidate);
    logDocumentAiDiagnostic('field_manual_draft', { documentId: document.id, path });
  }, [document, hybridBaseDocument, hybridReview, projectAcceptedDocumentIdentity]);

  const handleHybridAcceptAll = useCallback(() => {
    if (!hybridReview || hybridPersistenceRef.current) return;
    const result = acceptAllPendingHybridReview(hybridReview, hybridFieldCanAccept, decideHybridReview);
    if (result.acceptedPaths.length === 0 && result.ignoredPaths.length === 0) return;
    logDocumentAiDiagnostic('accept_all', {
      documentId: document?.id ?? null,
      acceptedCount: result.acceptedPaths.length,
      ignoredCount: result.ignoredPaths.length,
      pendingCount: 0,
    });
    void persistHybridReview(result.state, 'accept_all', result.acceptedPaths);
  }, [document?.id, hybridReview, persistHybridReview]);

  const handleSave = async () => {
    if (!document) {
      traceScan('save:blocked', { reason: 'no_document' });
      return;
    }
    if (saving) {
      traceScan('save:blocked', { reason: 'saving' });
      return;
    }
    if (documentAiRunning) {
      traceScan('save:blocked', { reason: 'document_ai_running' });
      return;
    }
    if (imageRotationRunningRef.current) {
      traceScan('save:blocked', { reason: 'image_rotation' });
      return;
    }
    if (persistenceRunningRef.current) {
      traceScan('save:blocked', { reason: 'persistence_running' });
      return;
    }
    if (!screenActiveRef.current) {
      traceScan('save:blocked', { reason: 'screen_inactive' });
      return;
    }
    const exclusiveLease = saveExportGateRef.current.tryAcquire();
    if (!exclusiveLease) {
      traceScan('save:blocked', { reason: 'exclusive_gate_locked' });
      return;
    }
    traceScan('save:begin', { id: document.id, type: document.type });
    businessEditorCancellationRef.current?.();
    persistenceRunningRef.current = true;
    const operation = actionOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    Keyboard.dismiss();
    setSaving(true);
    let toSave = document;
    if (document.type === 'business_card') {
      const card = document as BusinessCard;
      const address = normalizeAddress(card.address);
      if (address) {
        toSave = { ...card, address };
      }
    }
    const savingDraft =
      isDraft && toSave.type === 'business_card';
    if (savingDraft) {
      draftPersistenceOwnerRef.current = operation.operationId;
    }
    let navigated = false;
    try {
      if (toSave.type !== 'business_card') {
        const resolution = await resolveDocumentDuplicate(toSave, {
          excludeDocumentId: toSave.id,
          existing: documents,
        });
        if (resolution.decision === 'cancel') return;
        if (resolution.decision === 'open_existing') {
          router.replace(`/document/${resolution.match.document.id}`);
          navigated = true;
          return;
        }
      }
      let persisted: AnyDocument;
      if (toSave.type === 'business_card') {
        if (isDraft) {
          persisted = await addContact(toSave as BusinessCard, {
            operationId: operation.operationId,
            isActive,
          });
        } else {
          persisted = await updateContact(toSave as BusinessCard, {
            operationId: operation.operationId,
            isActive,
          });
        }
      } else {
        persisted = await updateDocument(toSave, {
          operationId: operation.operationId,
          isActive,
        });
      }
      if (!isActive() || !operation.tryFinalize()) return;
      if (savingDraft) {
        if (draftPersistenceOwnerRef.current === operation.operationId) {
          draftPersistenceOwnerRef.current = null;
        }
        cleanupDraftAssets();
        setIsDraft(false);
      }
      documentRef.current = persisted;
      setDocument(persisted);
      if (persisted.type === 'business_card') {
        showSaveToast(t('businessCardSavedSuccess'));
        router.replace('/(tabs)/contacts');
        navigated = true;
        return;
      }
      showSaveToast(t('documentSaved'));
      traceScan('save:done', { id: persisted.id, type: persisted.type });
      const otherContext = persisted.category && !['quote', 'order', 'invoice'].includes(persisted.category);
      router.replace(otherContext ? '/(tabs)/documents?scanContext=other' : '/(tabs)/documents');
      navigated = true;
      return;
    } catch (error) {
      if (error instanceof DuplicateContactCancelledError) return;
      if (error instanceof DocumentDuplicateCancelledError) return;
      if (error instanceof DocumentDuplicateOpenExistingError) {
        router.replace(`/document/${error.existingId}`);
        navigated = true;
        return;
      }
      if (error instanceof DuplicateContactStaleError) {
        Alert.alert(
          t('contactDuplicateStaleTitle'),
          t('contactDuplicateStaleMessage')
        );
        return;
      }
      if (isInactiveScanOperationError(error) || !isActive()) {
        reconcileAfterInactiveMutation();
        return;
      }
      runtimeLogger.error('CONTACT_SAVE_FAILED', error, {
        source: 'filesystem',
        stage: 'persist',
        status: 'failed',
      });
      Alert.alert(
        t('error'),
        toSave.type === 'business_card'
          ? t('contactSaveFailed')
          : t('documentSaveFailed')
      );
    } finally {
      if (savingDraft) releaseDraftPersistence(operation.operationId);
      if (!navigated) exclusiveLease.release();
      persistenceRunningRef.current = false;
      const wasCurrent = actionOperationsRef.current.isCurrent(operation);
      if (wasCurrent) actionOperationsRef.current.finish(operation);
      if (wasCurrent && mountedRef.current && screenActiveRef.current) {
        setSaving(false);
      }
    }
  };

  const handleExport = async () => {
    if (
      !document ||
      saving ||
      documentAiRunning ||
      imageRotationRunningRef.current ||
      persistenceRunningRef.current ||
      !screenActiveRef.current
    ) return;
    const exclusiveLease = saveExportGateRef.current.tryAcquire();
    if (!exclusiveLease) return;
    businessEditorCancellationRef.current?.();
    persistenceRunningRef.current = true;
    setSaving(true);
    const operation = actionOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    let toExport = document;
    if (document.type === 'business_card') {
      const card = document as BusinessCard;
      const address = normalizeAddress(card.address);
      if (address) {
        toExport = { ...card, address };
      }
    }
    const savingDraft =
      isDraft && toExport.type === 'business_card';
    if (savingDraft) {
      draftPersistenceOwnerRef.current = operation.operationId;
    }
    let navigated = false;
    try {
      if (toExport.type !== 'business_card') {
        const resolution = await resolveDocumentDuplicate(toExport, {
          excludeDocumentId: toExport.id,
          existing: documents,
        });
        if (resolution.decision === 'cancel') return;
        if (resolution.decision === 'open_existing') {
          router.replace(`/document/${resolution.match.document.id}`);
          navigated = true;
          return;
        }
      }
      let persisted: AnyDocument;
      if (toExport.type === 'business_card') {
        if (isDraft) {
          persisted = await addContact(toExport as BusinessCard, {
            operationId: operation.operationId,
            isActive,
          });
        } else {
          persisted = await updateContact(toExport as BusinessCard, {
            operationId: operation.operationId,
            isActive,
          });
        }
      } else {
        persisted = await updateDocument(toExport, {
          operationId: operation.operationId,
          isActive,
        });
      }
      if (!isActive() || !operation.tryFinalize()) return;
      if (savingDraft) {
        if (draftPersistenceOwnerRef.current === operation.operationId) {
          draftPersistenceOwnerRef.current = null;
        }
        cleanupDraftAssets();
        setIsDraft(false);
      }
      documentRef.current = persisted;
      setDocument(persisted);
      router.push(`/export/${persisted.id}`);
      navigated = true;
    } catch (error) {
      if (error instanceof DuplicateContactCancelledError) return;
      if (error instanceof DocumentDuplicateCancelledError) return;
      if (error instanceof DocumentDuplicateOpenExistingError) {
        router.replace(`/document/${error.existingId}`);
        navigated = true;
        return;
      }
      if (error instanceof DuplicateContactStaleError) {
        Alert.alert(
          t('contactDuplicateStaleTitle'),
          t('contactDuplicateStaleMessage')
        );
        return;
      }
      if (isInactiveScanOperationError(error) || !isActive()) {
        reconcileAfterInactiveMutation();
        return;
      }
      Alert.alert(t('error'), t('captureFailed'));
    } finally {
      if (savingDraft) releaseDraftPersistence(operation.operationId);
      if (!navigated) exclusiveLease.release();
      persistenceRunningRef.current = false;
      const wasCurrent = actionOperationsRef.current.isCurrent(operation);
      if (wasCurrent) actionOperationsRef.current.finish(operation);
      if (wasCurrent && mountedRef.current && screenActiveRef.current) {
        setSaving(false);
      }
    }
  };

  const handleReparse = () => {
    if (
      !document ||
      document.type !== 'business_card' ||
      saving ||
      documentAiRunning ||
      imageRotationRunningRef.current ||
      persistenceRunningRef.current ||
      !screenActiveRef.current
    ) {
      return;
    }
    const card = document as BusinessCard;
    if ((card.images ?? []).length === 0) {
      Alert.alert(t('error'), t('reparseContactNoOcr'));
      return;
    }
    const warning =
      `${t('reparseContactConfirmMessage')}\n\n` +
      'ATTENZIONE: le foto salvate verranno lette di nuovo. Dati modificati che non risultano marcati come manuali potrebbero essere sostituiti: controlla ogni campo proposto. Annullando non verrà modificato nulla.';
    Alert.alert(t('reparseContactConfirmTitle'), warning, [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('reparseContactTitle'),
        onPress: async () => {
          if (
            !mountedRef.current ||
            !screenActiveRef.current ||
            imageRotationRunningRef.current
          ) return;
          const operation = actionOperationsRef.current.begin();
          const isActive = () =>
            mountedRef.current &&
            screenActiveRef.current &&
            operation.isActive();
          try {
            handleRotationStateChange(true);
            const reocr = await buildBusinessCardReocrProposal(card, {
              operation,
            });
            if (!isActive() || !operation.tryFinalize()) return;
            if (reocr.status !== 'ready') {
              Alert.alert(t('error'), t('reparseContactNoOcr'));
              return;
            }
            if (!reocr.proposal || reocr.proposal.fields.length === 0) {
              documentRef.current = reocr.reocrCard;
              setDocument(reocr.reocrCard);
              if (isDraftRef.current) setDraftContact(reocr.reocrCard);
              Alert.alert(t('reparseDoneTitle'), t('reparseNoChanges'));
              return;
            }
            setPendingReocr(reocr);
            setReparseProposal(reocr.proposal);
          } catch (error) {
            if (isInactiveScanOperationError(error) || !isActive()) return;
            Alert.alert(t('error'), t('reparseContactFailed'));
          } finally {
            if (actionOperationsRef.current.isCurrent(operation)) {
              actionOperationsRef.current.finish(operation);
            }
            handleRotationStateChange(false);
          }
        },
      },
    ]);
  };

  const handleApplyReparseProposal = (
    selectedFields: ContactReparseFieldKey[]
  ) => {
    const current = documentRef.current;
    if (
      !reparseProposal ||
      !pendingReocr ||
      !current ||
      current.type !== 'business_card' ||
      imageRotationRunningRef.current ||
      persistenceRunningRef.current ||
      !screenActiveRef.current
    ) {
      return;
    }
    const result = applyBusinessCardReocrProposal(
      current as BusinessCard,
      pendingReocr,
      selectedFields
    );
    if (result.status === 'stale') {
      setReparseProposal(null);
      setPendingReocr(null);
      Alert.alert(t('error'), t('reparseProposalStale'));
      return;
    }
    if (result.status === 'unchanged') {
      setReparseProposal(null);
      setPendingReocr(null);
      Alert.alert(t('reparseDoneTitle'), t('reparseNoChanges'));
      return;
    }
    documentRef.current = result.appliedResult;
    setDocument(result.appliedResult);
    if (isDraftRef.current) setDraftContact(result.appliedResult);
    setReparseProposal(null);
    setPendingReocr(null);
    Alert.alert(t('reparseDoneTitle'), t('reparseContactDone'));
  };

  const confirmDelete = () => {
    if (
      !document ||
      imageRotationRunningRef.current ||
      persistenceRunningRef.current
    ) return;
    Alert.alert(t('deleteConfirmTitle'), t('deleteConfirmMessage'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete'),
        style: 'destructive',
        onPress: async () => {
          if (!mountedRef.current || !screenActiveRef.current) return;
          const operation = actionOperationsRef.current.begin();
          const isActive = () =>
            mountedRef.current &&
            screenActiveRef.current &&
            operation.isActive();
          try {
            if (document.type === 'business_card') {
              if (isDraft) {
                cleanupDraftAssets();
              } else {
                await removeContact(document.id, {
                  operationId: operation.operationId,
                  isActive,
                });
              }
              if (!isActive() || !operation.tryFinalize()) return;
              router.replace('/(tabs)/contacts');
            } else {
              await removeDocument(document.id, {
                operationId: operation.operationId,
                isActive,
              });
              if (!isActive() || !operation.tryFinalize()) return;
              router.replace('/(tabs)/documents');
            }
          } catch (error) {
            if (isInactiveScanOperationError(error) || !isActive()) return;
            Alert.alert(t('error'), t('captureFailed'));
          } finally {
            if (actionOperationsRef.current.isCurrent(operation)) {
              actionOperationsRef.current.finish(operation);
            }
          }
        },
      },
    ]);
  };

  const handleImageRotated = useCallback(
    async (index: number, rotatedUri: string) => {
      const current = documentRef.current;
      if (
        !current ||
        current.type !== 'business_card' ||
        persistenceRunningRef.current ||
        !screenActiveRef.current
      ) {
        void cleanupScanSessionImageUri(rotatedUri);
        return;
      }
      const operation = actionOperationsRef.current.begin();
      const isActive = () =>
        mountedRef.current &&
        screenActiveRef.current &&
        operation.isActive();
      const card = current as BusinessCard;
      const rotatingDraft = isDraftRef.current;
      try {
        const next = rotatingDraft
          ? await rotateDraftBusinessCardImagePage(card, index, rotatedUri)
          : await rotateContactImagePage(
              card,
              index,
              rotatedUri,
              {
                operationId: operation.operationId,
                isActive,
              }
            );
        if (!isActive() || !operation.tryFinalize()) {
          void cleanupScanSessionImageUri(rotatedUri);
          return;
        }
        documentRef.current = next;
        setDocument(next);
        if (rotatingDraft) {
          setDraftContact(next);
        }
        const proposal = buildBusinessCardReparseProposal(next);
        return () => {
          if (
            !mountedRef.current ||
            !screenActiveRef.current ||
            documentRef.current?.id !== next.id
          ) {
            return;
          }
          if (proposal?.fields.length) {
            setReparseProposal(proposal);
          } else {
            Alert.alert(t('reparseDoneTitle'), t('reparseNoChanges'));
          }
        };
      } catch (error) {
        if (isInactiveScanOperationError(error) || !isActive()) {
          reconcileAfterInactiveMutation();
          void cleanupScanSessionImageUri(rotatedUri);
          return;
        }
        throw error;
      } finally {
        if (actionOperationsRef.current.isCurrent(operation)) {
          actionOperationsRef.current.finish(operation);
        }
      }
    },
    [
      reconcileAfterInactiveMutation,
      rotateContactImagePage,
      setDraftContact,
      t,
    ]
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!document) return <View style={styles.container} />;

  const bottomPad = getScrollableBottomPadding(footerHeight, keyboardInset);
  const hasDocumentNotes =
    document.type === 'quote' ||
    document.type === 'order' ||
    document.type === 'invoice' ||
    document.type === 'free_document';
  const hasReviewableDocumentImages =
    document.type !== 'business_card' && document.images.length > 0;
  const ocrQuality =
    document.ocrQuality ??
    legacyOcrQualityMetadata(document.confidence.ocrQuality);

  const renderDocumentAiSection = () => (
    <>
      {hasReviewableDocumentImages ? (
        <View style={styles.documentAiBox}>
          <Text style={styles.documentAiSectionTitle}>
            {t('documentAiSectionTitle')}
          </Text>
          <Text style={styles.documentAiHint}>{t('documentLocalReviewHint')}</Text>
          {documentAiCreditState.kind === 'remaining' ? (
            <Text style={styles.documentAiCredits}>
              {t('documentAiCreditsRemaining', { count: documentAiCreditState.value })}
            </Text>
          ) : documentAiCreditState.kind === 'exhausted' ? (
            <Text style={styles.documentAiCredits}>{t('documentAiCreditsExhausted')}</Text>
          ) : null}
          <TouchableOpacity
            style={[
              styles.documentAiButton,
              documentAiRunning && styles.buttonDisabled,
            ]}
            onPress={openDocumentAiModal}
            disabled={documentAiRunning}
            accessibilityRole="button"
            accessibilityLabel={t('documentAiButton')}
          >
            {documentAiRunning ? (
              <ActivityIndicator color={colors.textDisabled} size="small" />
            ) : (
              <Text style={styles.documentAiButtonText}>
                {t('documentAiButton')}
              </Text>
            )}
          </TouchableOpacity>
          {documentAiMessage ? (
            <Text style={styles.documentAiMessage}>{documentAiMessage}</Text>
          ) : null}
        </View>
      ) : null}
      {hybridReview ? (
        <View onLayout={handleAiReviewLayout}>
          <DocumentHybridReview
            state={hybridReview}
            onDecision={handleHybridDecision}
            onManualValue={handleHybridManualValue}
            onAcceptAll={handleHybridAcceptAll}
            acceptAllDisabled={
              saving ||
              documentAiRunning ||
              hybridPersistenceRunning ||
              !hasPendingHybridReview(hybridReview)
            }
          />
        </View>
      ) : null}
    </>
  );

  const renderEditor = () => {
    switch (document.type) {
      case 'business_card': {
        const card = document as BusinessCard;
        const extractionReview = card.extractionReview ?? lazyExtractionReview;
        return (
          <BusinessCardEditor
            card={card}
            onChange={(next) => {
              if (
                !screenActiveRef.current ||
                imageRotationRunningRef.current ||
                persistenceRunningRef.current
              ) return;
              documentRef.current = next;
              setDocument(next);
              if (isDraft) setDraftContact(next);
            }}
            isScreenActive={isReviewScreenActive}
            registerCancellation={registerBusinessEditorCancellation}
            onFieldFocus={scrollToEnd}
            editable={!imageRotationRunning && !saving}
            extractionReview={extractionReview}
          />
        );
      }
      case 'quote':
        return (
          <>
            <Text style={styles.docTypeBadge}>{t('quote')}</Text>
            <DocumentStructuredDetails
              document={document}
              onFieldChange={handleDocumentFieldEdit}
              onFocus={scrollToEnd}
              editable={!saving && !documentAiRunning}
              afterSummary={renderDocumentAiSection()}
            />
          </>
        );
      case 'order':
        return (
          <>
            <Text style={styles.docTypeBadge}>{t('order')}</Text>
            <DocumentStructuredDetails
              document={document}
              onFieldChange={handleDocumentFieldEdit}
              onFocus={scrollToEnd}
              editable={!saving && !documentAiRunning}
              afterSummary={renderDocumentAiSection()}
            />
          </>
        );
      case 'invoice':
        return (
          <>
            <Text style={styles.docTypeBadge}>{t('invoice')}</Text>
            <DocumentStructuredDetails
              document={document}
              onFieldChange={handleDocumentFieldEdit}
              onFocus={scrollToEnd}
              editable={!saving && !documentAiRunning}
              afterSummary={renderDocumentAiSection()}
            />
          </>
        );
      default:
        return (
          <>
            <Text style={styles.section}>{t('editDataSection')}</Text>
            <EditableField
              label={t('title')}
              value={document.title}
              onChangeText={(title) => setDocument({ ...document, title })}
              onFocus={scrollToEnd}
                editable={!saving && !documentAiRunning}
            />
            <DocumentStructuredDetails
              document={document}
              onFieldChange={handleDocumentFieldEdit}
              onFocus={scrollToEnd}
              editable={!saving && !documentAiRunning}
              afterSummary={renderDocumentAiSection()}
            />
          </>
        );
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={
        Platform.OS === 'ios' || keyboardInset > 0 ? 'padding' : undefined
      }
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 28}
    >
      <Stack.Screen
        options={{
          title: document.type === 'business_card' ? 'Contatto' : 'Documento',
          headerBackTitle: '',
          headerLeft: () => (
            <TouchableOpacity
              onPress={handleBack}
              style={styles.headerBack}
              accessibilityLabel={t('backAccessibility')}
            >
              <Ionicons name="chevron-back" size={26} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView
        ref={scrollRef}
        style={styles.content}
        contentContainerStyle={[
          styles.contentInner,
          {
            paddingHorizontal: responsive.horizontalPadding,
            paddingBottom: bottomPad,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.title}>{document.title}</Text>
        <DocumentImagesPreview
          images={document.images}
          originalImages={document.type === 'business_card' ? document.originalImages : undefined}
          onImageRotated={document.type === 'business_card' ? handleImageRotated : undefined}
          onRotationStateChange={
            document.type === 'business_card'
              ? handleRotationStateChange
              : undefined
          }
          disabled={saving || documentAiRunning}
        />
        {ocrQuality ? <OcrQualityIndicator quality={ocrQuality} /> : null}
        {renderEditor()}
        {hasDocumentNotes ? (
          <View style={styles.notesSection}>
            <Text style={styles.section}>{t('documentDetailsNotesSection')}</Text>
            <DocumentNotesField
              value={getDocumentNotes(document)}
              onChangeText={(notes) => setDocument(withDocumentNotes(document, notes))}
              onFocus={scrollToEnd}
              editable={!saving && !documentAiRunning}
            />
          </View>
        ) : null}
        {document.type !== 'business_card' ? (
          <DocumentReviewAlerts document={document} />
        ) : null}
        {document.type !== 'business_card' &&
        (document.pageExtractions?.length ||
          document.fieldMerge ||
          Object.keys(document.fieldReliability ?? {}).length ||
          document.rawText?.trim()) ? (
          <View style={styles.technicalSection}>
            <TouchableOpacity
              style={styles.technicalToggle}
              onPress={() => setShowTechnicalDetails((visible) => !visible)}
              accessibilityRole="button"
              accessibilityLabel={t('documentTechnicalDetails')}
              accessibilityHint={t('documentTechnicalDetailsHint')}
              accessibilityState={{ expanded: showTechnicalDetails }}
              activeOpacity={0.65}
            >
              <Text style={styles.technicalToggleText}>
                {t('documentTechnicalDetails')}
              </Text>
              <Ionicons
                name={showTechnicalDetails ? 'chevron-up' : 'chevron-down'}
                size={22}
                color={colors.primary}
              />
            </TouchableOpacity>
            {showTechnicalDetails ? (
              <View style={styles.technicalContent}>
                <DocumentPageExtractionReview
                  results={document.pageExtractions}
                  fieldMerge={document.fieldMerge}
                  fieldReliability={document.fieldReliability}
                  structuredPages={document.structuredExtraction?.pages}
                />
                {document.rawText?.trim() ? (
                  <View style={styles.rawOcrBox}>
                    <Text style={styles.rawOcrLabel}>{t('ocrReadText')}</Text>
                    <Text style={styles.rawOcrBody} selectable>
                      {document.rawText.trim()}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {showPartialNotice ? (
        <View
          style={[
            styles.partialNoticeBanner,
            { marginHorizontal: responsive.horizontalPadding },
          ]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Ionicons name="information-circle-outline" size={18} color="#9A6A00" accessible={false} />
          <Text style={styles.partialNoticeText}>{t('processing.partialNotice')}</Text>
        </View>
      ) : null}

      <View
        style={[styles.footer, { paddingBottom: insets.bottom }]}
        onLayout={(event) => {
          const nextHeight = Math.ceil(event.nativeEvent.layout.height);
          setFooterHeight((current) => (current === nextHeight ? current : nextHeight));
        }}
      >
        {document.type === 'business_card' ? (
          <TouchableOpacity
            style={[
              styles.reparseButton,
              { paddingHorizontal: responsive.horizontalPadding },
              imageRotationRunning && styles.buttonDisabled,
            ]}
            onPress={handleReparse}
            disabled={imageRotationRunning}
          >
            {imageRotationRunning ? (
              <ActivityIndicator color={colors.textDisabled} />
            ) : (
              <Text style={styles.reparseText}>{t('reparseContactTitle')}</Text>
            )}
          </TouchableOpacity>
        ) : null}
        <View
          style={[
            styles.buttons,
            responsive.stackActions && styles.buttonsStacked,
            { paddingHorizontal: responsive.horizontalPadding },
          ]}
        >
          <TouchableOpacity
            style={[
              styles.button,
              responsive.stackActions && styles.buttonStacked,
              (saving || documentAiRunning || imageRotationRunning) &&
                styles.buttonDisabled,
            ]}
            onPress={handleSave}
            disabled={saving || documentAiRunning || imageRotationRunning}
          >
            {saving ? (
              <ActivityIndicator color={colors.textDisabled} />
            ) : (
              <Text
                style={[
                  styles.buttonText,
                  (documentAiRunning || imageRotationRunning) && styles.buttonTextDisabled,
                ]}
              >
                {document.type === 'business_card' ? t('save') : t('documentSave')}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.button,
              styles.buttonExport,
              responsive.stackActions && styles.buttonStacked,
              (saving || documentAiRunning || imageRotationRunning || !hybridReviewCanSave(hybridReview)) &&
                styles.buttonDisabled,
            ]}
            onPress={handleExport}
            disabled={saving || documentAiRunning || imageRotationRunning || !hybridReviewCanSave(hybridReview)}
          >
            <Text
              style={[
                styles.buttonText,
                (saving || documentAiRunning || imageRotationRunning || !hybridReviewCanSave(hybridReview)) && styles.buttonTextDisabled,
              ]}
            >
              {t('sendData')}
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[
            styles.deleteButton,
            imageRotationRunning && styles.buttonDisabled,
          ]}
          onPress={confirmDelete}
          disabled={imageRotationRunning}
        >
          <Text style={[styles.deleteText, imageRotationRunning && styles.buttonTextDisabled]}>
            {t('delete')}
          </Text>
        </TouchableOpacity>
      </View>

      <GeminiConfirmationModal
        visible={showDocumentAiModal}
        onCancel={() => setShowDocumentAiModal(false)}
        onConfirm={handleDocumentAiConfirm}
        contentKind="images"
        pageCount={document.images.length}
        creditsToConsume={Math.max(1, document.images.length)}
        showCredits
      />
      <ContactReparseProposalModal
        visible={reparseProposal != null}
        proposal={reparseProposal}
        onCancel={() => {
          setReparseProposal(null);
          setPendingReocr(null);
        }}
        onApply={handleApplyReparseProposal}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  contentInner: { paddingVertical: spacing.xl, paddingBottom: spacing.xxxl },
  title: { ...typography.heading1, color: colors.textPrimary, marginBottom: spacing.lg },
  docTypeBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.infoSurface,
    color: colors.info,
    ...typography.caption,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.sm,
    marginBottom: 8,
    overflow: 'hidden',
  },
  section: {
    ...typography.label,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  partialNoticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: '#FFF9E6',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E7C96B',
  },
  partialNoticeText: {
    ...typography.caption,
    color: colors.textPrimary,
    flex: 1,
    flexWrap: 'wrap',
  },
  reparseButton: {
    paddingTop: 12,
    alignItems: 'center',
  },
  reparseText: {
    ...typography.button,
    color: colors.primary,
    fontWeight: '600',
  },
  buttons: {
    flexDirection: 'row',
    paddingTop: 12,
    gap: spacing.md,
  },
  buttonsStacked: {
    flexDirection: 'column',
  },
  button: {
    flex: 1,
    backgroundColor: colors.primary,
    padding: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'center',
  },
  buttonStacked: {
    flex: 0,
    width: '100%',
  },
  buttonExport: { backgroundColor: colors.success },
  buttonDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  buttonText: { ...typography.button, color: colors.textOnPrimary, fontWeight: '600' },
  buttonTextDisabled: { color: colors.textDisabled },
  deleteButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  deleteText: { ...typography.button, color: colors.danger, fontWeight: '600' },
  headerBack: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rawOcrBox: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  rawOcrLabel: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  rawOcrBody: { ...typography.caption, color: colors.textSecondary },
  notesSection: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  technicalSection: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
  },
  technicalToggle: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  technicalToggleText: {
    ...typography.button,
    color: colors.primary,
    flexShrink: 1,
  },
  technicalContent: {
    marginTop: spacing.sm,
  },
  documentAiBox: {
    backgroundColor: colors.infoSurface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.info,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  documentAiSectionTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  documentAiHint: {
    color: colors.info,
    ...typography.bodySecondary,
    marginBottom: spacing.md,
  },
  documentAiCredits: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    flexShrink: 1,
  },
  documentAiButton: {
    backgroundColor: colors.primary,
    minHeight: 44,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  documentAiButtonText: {
    ...typography.button,
    color: colors.textOnPrimary,
  },
  documentAiMessage: {
    ...typography.bodySecondary,
    color: colors.info,
    marginTop: 10,
  },
});
