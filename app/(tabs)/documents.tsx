import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Text,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDocumentStore } from '../../store/useDocumentStore';
import { isSupabaseConfigured } from '../../lib/config';
import { isRcPdfImportEnabled } from '../../lib/release-rc-policy';
import { useLicense } from '../../components/LicenseProvider';
import { getEntitlementCapabilities } from '../../lib/entitlement-capabilities';
import { guardNewAcquisition } from '../../lib/trial-acquisition-guard';
import {
  DOCUMENT_SEARCH_MIN_LEN,
  filterDocuments,
  isDocumentListFilterActive,
  type StoredDocumentType,
} from '../../lib/document-search';
import {
  COMMERCIAL_SCAN_TYPES,
  createDefaultDocumentTypeSelection,
  getSingleSelectedDocumentType,
  isAllDocumentTypesSelected,
  toggleDocumentTypeSelection,
  type DocumentTypeSelection,
} from '../../lib/document-type-filters';
import { DocumentScanTypePicker } from '../../components/DocumentScanTypePicker';
import { OtherDocumentTypePicker } from '../../components/OtherDocumentTypePicker';
import { SelectionActionBar } from '../../components/SelectionActionBar';
import { ExportKeepAwake } from '../../components/ExportKeepAwake';
import { EXPORT_HUB_ICONS, ExportHubMenu } from '../../components/ExportHubMenu';
import {
  exportDocumentsQa,
  isStoredDocument,
  shareDocumentsQaZip,
  type DocumentsQaExportResult,
} from '../../lib/export-qa-documents';
import { confirmDiagnosticExport } from '../../lib/diagnostic-export-confirm';
import { customerExportLocale } from '../../lib/export-contacts-customer';
import type { CustomerDocumentExportFormat, CustomerDocumentExportScope } from '../../lib/export-documents-customer';
import { EXPORT_BATCH_SIZE } from '../../lib/export-batches';
import { shareCustomerDocumentsExport } from '../../lib/share-documents-customer';
import { runtimeLogger } from '../../lib/safe-runtime-logger';
import { useModalAccessibilityFocus } from '../../lib/use-modal-accessibility-focus';
import { colors } from '../../lib/ui-theme';
import { getUiViewportLayout } from '../../lib/ui-layout';
import { radii, spacing, typography } from '../../lib/ui-system';
import {
  deselectVisibleDocuments,
  pruneDocumentSelection,
  selectVisibleDocuments,
  toggleDocumentSelection,
} from '../../lib/document-selection';
import type { FreeDocument, InvoiceDocument, OrderDocument, QuoteDocument } from '../../types';
import {
  DOCUMENT_CATEGORY_LABEL_KEYS,
  processingTypeForCategory,
  type OtherDocumentCategory,
} from '../../lib/document-category';
import { buildDocumentScanHref, createDocumentScanSessionId } from '../../lib/document-scan-navigation';

type StoredDocument = QuoteDocument | OrderDocument | InvoiceDocument | FreeDocument;

function documentCategoryLabelKey(document: { type: string; category?: keyof typeof DOCUMENT_CATEGORY_LABEL_KEYS }): string {
  if (document.category) return DOCUMENT_CATEGORY_LABEL_KEYS[document.category];

  switch (document.type) {
    case 'business_card':
      return 'businessCard';
    case 'quote':
      return DOCUMENT_CATEGORY_LABEL_KEYS.quote;
    case 'order':
      return DOCUMENT_CATEGORY_LABEL_KEYS.order;
    case 'invoice':
      return DOCUMENT_CATEGORY_LABEL_KEYS.invoice;
    case 'free_document':
      return DOCUMENT_CATEGORY_LABEL_KEYS.generic_document;
    default:
      return 'otherDocument';
  }
}

/** Match camera overlay border colors for list badges. */
const TYPE_BADGE_COLORS: Record<StoredDocumentType, string> = {
  quote: '#5856D6',
  order: '#FF9500',
  invoice: '#FF3B30',
  free_document: '#34C759',
};

const TYPE_FILTER_LABELS: Record<'all' | StoredDocumentType, string> = {
  all: 'documentsFilterAll',
  quote: 'documentsFilterQuote',
  order: 'documentsFilterOrder',
  invoice: 'documentsFilterInvoice',
  free_document: 'documentsFilterFreeDocument',
};

const FILTER_KEYS = ['all', 'quote', 'order', 'invoice', 'free_document'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

function isFilterChipActive(filter: FilterKey, selection: DocumentTypeSelection): boolean {
  if (filter === 'all') return isAllDocumentTypesSelected(selection);
  return selection[filter];
}

function typeFilterLabel(filter: FilterKey, t: (key: string) => string): string {
  return t(TYPE_FILTER_LABELS[filter]);
}

function splitDocumentExportBatches(documents: StoredDocument[]) {
  if (documents.length === 0) return [];
  const batches: Array<{ from: number; to: number; documents: StoredDocument[] }> = [];
  for (let start = 0; start < documents.length; start += EXPORT_BATCH_SIZE) {
    const slice = documents.slice(start, start + EXPORT_BATCH_SIZE);
    batches.push({
      from: start + 1,
      to: start + slice.length,
      documents: slice,
    });
  }
  return batches;
}

export default function DocumentsScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const { compactHeaderActions } = getUiViewportLayout(width, fontScale);
  const navigation = useNavigation();
  const { scanContext } = useLocalSearchParams<{ scanContext?: string }>();
  const { openActivation, status } = useLicense();
  const caps = getEntitlementCapabilities(
    status.entitlement,
    status.aiCreditsRemaining
  );
  const { documents, loading, loadDocuments, removeDocument, removeDocuments } = useDocumentStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [typeSelection, setTypeSelection] = useState<DocumentTypeSelection>(
    createDefaultDocumentTypeSelection,
  );
  const [scanPickerVisible, setScanPickerVisible] = useState(false);
  const [otherPickerVisible, setOtherPickerVisible] = useState(false);
  const scanIntentRef = useRef<'camera' | 'pdf'>('camera');
  // L'analisi del PDF avviene lato cloud: senza configurazione il comando
  // porterebbe solo a un errore.
  const pdfImportAvailable = useMemo(() => isSupabaseConfigured(), []);
  const [exportingQa, setExportingQa] = useState(false);
  const [exportingCustomer, setExportingCustomer] = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0 });
  const [readyExport, setReadyExport] = useState<DocumentsQaExportResult | null>(null);
  const [exportHubVisible, setExportHubVisible] = useState(false);
  const [exportMenuKind, setExportMenuKind] = useState<'diagnostic' | 'customer'>('diagnostic');
  const [customerExportFormat, setCustomerExportFormat] = useState<CustomerDocumentExportFormat | null>(null);
  const [exportMenuVisible, setExportMenuVisible] = useState(false);
  const [exportPickerVisible, setExportPickerVisible] = useState(false);
  const [exportPickerIds, setExportPickerIds] = useState<Set<string>>(() => new Set());
  const exportHubTitleRef = useRef<View>(null);
  const exportMenuTitleRef = useRef<View>(null);
  const exportPickerTitleRef = useRef<View>(null);
  useModalAccessibilityFocus(exportHubVisible, exportHubTitleRef);
  useModalAccessibilityFocus(exportMenuVisible, exportMenuTitleRef);
  useModalAccessibilityFocus(exportPickerVisible, exportPickerTitleRef);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(() => new Set());
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0 });
  const deletingSelectedRef = React.useRef(false);

  useEffect(() => {
    void loadDocuments().catch(() => undefined);
  }, [loadDocuments]);

  const storedDocuments = documents.filter(isStoredDocument) as StoredDocument[];
  const exportBatches = useMemo(
    () => splitDocumentExportBatches(storedDocuments),
    [storedDocuments],
  );
  const showBatchOptions = exportBatches.length > 1;
  const exportPickerAllSelected =
    storedDocuments.length > 0 && exportPickerIds.size === storedDocuments.length;
  const searchActive = searchQuery.trim().length >= DOCUMENT_SEARCH_MIN_LEN;
  const typeFilterActive = isDocumentListFilterActive(typeSelection);
  const displayedDocuments = useMemo(
    () => filterDocuments(documents, searchQuery, typeSelection),
    [documents, searchQuery, typeSelection]
  );
  const selectedCount = selectedDocumentIds.size;
  const allVisibleDocumentsSelected =
    displayedDocuments.length > 0 &&
    displayedDocuments.every((document) => selectedDocumentIds.has(document.id));
  const someVisibleDocumentsSelected = displayedDocuments.some((document) =>
    selectedDocumentIds.has(document.id),
  );

  useEffect(() => {
    const existingIds = new Set(documents.map((document) => document.id));
    setSelectedDocumentIds((current) => {
      const next = pruneDocumentSelection(current, existingIds);
      return next.size === current.size ? current : next;
    });
    if (readyExport && readyExport.documentCount !== documents.filter(isStoredDocument).length) setReadyExport(null);
  }, [documents, readyExport]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedDocumentIds((current) => toggleDocumentSelection(current, id));
  }, []);

  const selectAllDocuments = useCallback(() => {
    setSelectedDocumentIds((current) =>
      selectVisibleDocuments(current, displayedDocuments.map((document) => document.id)),
    );
  }, [displayedDocuments]);

  const deselectVisibleSelectedDocuments = useCallback(() => {
    setSelectedDocumentIds((current) =>
      deselectVisibleDocuments(current, displayedDocuments.map((document) => document.id)),
    );
  }, [displayedDocuments]);

  const confirmBulkDelete = useCallback(() => {
    if (selectedCount === 0 || deletingSelectedRef.current) return;
    Alert.alert(
      t('documentsBulkDeleteTitle'),
      t('documentsBulkDeleteMessage', { count: selectedCount }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: () => {
            if (deletingSelectedRef.current) return;
            deletingSelectedRef.current = true;
            setDeletingSelected(true);
            const ids = [...selectedDocumentIds];
            const selectedTitles = new Map(documents.map((document) => [document.id, document.title]));
            setDeleteProgress({ current: 0, total: ids.length });
            void removeDocuments(ids, (current, total) => setDeleteProgress({ current, total })).then((result) => {
              const failedIds = result.failed.map((entry) => entry.id);
              setSelectedDocumentIds(new Set(failedIds));
              if (result.failed.length > 0 || result.cleanupPendingIds.length > 0) {
                const affected = [...new Set([...failedIds, ...result.cleanupPendingIds])]
                  .map((id) => selectedTitles.get(id) ?? id)
                  .join('\n• ');
                const summary = t('documentsBulkDeletePartialMessage', {
                  deleted: result.deletedIds.length,
                  failed: result.failed.length,
                  cleanupPending: result.cleanupPendingIds.length,
                });
                Alert.alert(t('documentsBulkDeletePartialTitle'), affected ? `${summary}\n\n• ${affected}` : summary);
              } else {
                Alert.alert(t('documentsBulkDeleteDoneTitle'), t('documentsBulkDeleteDoneMessage', { count: result.deletedIds.length }));
              }
            }).catch(() => {
              Alert.alert(t('error'), t('captureFailed'));
            }).finally(() => {
              deletingSelectedRef.current = false;
              setDeletingSelected(false);
              setDeleteProgress({ current: 0, total: 0 });
            });
          },
        },
      ],
    );
  }, [documents, removeDocuments, selectedCount, selectedDocumentIds, t]);

  const startOtherDocumentScan = useCallback((category: OtherDocumentCategory) => {
    setOtherPickerVisible(false);
    const processingType = processingTypeForCategory(category);
    router.push(buildDocumentScanHref(processingType, category, createDocumentScanSessionId()));
  }, []);

  const openScan = useCallback(() => {
    if (!guardNewAcquisition(caps, 'document', t, openActivation)) return;
    if (scanContext === 'other') {
      setOtherPickerVisible(true);
      return;
    }
    const singleType = getSingleSelectedDocumentType(typeSelection);
    if (singleType) {
      router.push(`/scan/${singleType}`);
      return;
    }
    scanIntentRef.current = 'camera';
    setScanPickerVisible(true);
  }, [caps, openActivation, scanContext, t, typeSelection]);

  // L'importazione PDF vive nella schermata di acquisizione, che possiede il
  // consenso all'analisi cloud e la persistenza del documento. Qui si sceglie
  // solo il tipo, esattamente come per lo scatto.
  const openPdfImport = useCallback(() => {
    // Il PDF viene letto da Gemini: senza il permesso dedicato il comando deve
    // dirlo, non aprire un percorso che aggirerebbe la sospensione AI.
    if (!isRcPdfImportEnabled()) {
      Alert.alert(t('importPdf'), t('pdfImportAiDeferred'));
      return;
    }
    if (!guardNewAcquisition(caps, 'pdf', t, openActivation)) return;
    const singleType = getSingleSelectedDocumentType(typeSelection);
    if (singleType) {
      router.push(`/scan/${singleType}?intent=pdf`);
      return;
    }
    scanIntentRef.current = 'pdf';
    setScanPickerVisible(true);
  }, [caps, openActivation, t, typeSelection]);

  const handleFilterPress = useCallback((filter: FilterKey) => {
    if (filter === 'all') {
      setTypeSelection(createDefaultDocumentTypeSelection());
      return;
    }
    setTypeSelection((current) => {
      const next = toggleDocumentTypeSelection(current, filter);
      if (!Object.values(next).some(Boolean)) {
        return createDefaultDocumentTypeSelection();
      }
      return next;
    });
  }, []);

  const handleScanTypePick = useCallback((scanType: (typeof COMMERCIAL_SCAN_TYPES)[number]) => {
    setScanPickerVisible(false);
    const intent = scanIntentRef.current;
    scanIntentRef.current = 'camera';
    router.push(intent === 'pdf' ? `/scan/${scanType}?intent=pdf` : `/scan/${scanType}`);
  }, []);

  const shareReadyExport = useCallback(
    async (result: DocumentsQaExportResult) => {
      const ok = await shareDocumentsQaZip(result.zipPath);
      if (!ok) Alert.alert(t('error'), t('exportShareUnavailable'));
    },
    [t],
  );

  const showExportDone = useCallback(
    (result: DocumentsQaExportResult) => {
      setReadyExport(result);
      const sizeMb = (result.sizeBytes / (1024 * 1024)).toFixed(1);
      Alert.alert(
        t('exportDoneTitle'),
        t('exportDoneMessageDocuments', {
          fileName: result.fileName,
          count: result.documentCount,
          size: sizeMb,
        }),
        [
          {
            text: t('exportShareAgain'),
            onPress: () => {
              void shareReadyExport(result);
            },
          },
          { text: t('exportClose'), style: 'cancel' },
        ],
      );
    },
    [shareReadyExport, t],
  );

  const runExport = useCallback(
    async (toExport: StoredDocument[]) => {
      if (toExport.length === 0) {
        Alert.alert(t('error'), t('exportQaDocumentsNoneSelected'));
        return;
      }
      const confirmed = await confirmDiagnosticExport({
        title: t('diagnosticExportTitle'),
        message: t('diagnosticExportWarning'),
        cancel: t('cancel'),
        continue: t('diagnosticExportContinue'),
      });
      if (!confirmed) return;
      setExportMenuVisible(false);
      setExportPickerVisible(false);
      setExportingQa(true);
      setExportProgress({ current: 0, total: toExport.length });
      try {
        const result = await exportDocumentsQa(toExport, (progress) => {
          setExportProgress({ current: progress.current, total: progress.total });
        });
        showExportDone(result);
      } catch {
        Alert.alert(t('error'), t('exportQaError'));
      } finally {
        setExportingQa(false);
        setExportProgress({ current: 0, total: 0 });
      }
    },
    [showExportDone, t],
  );

  const openExportHub = useCallback(() => {
    if (storedDocuments.length === 0) {
      Alert.alert(t('export'), t('exportQaDocumentsNoDocuments'));
      return;
    }
    setExportHubVisible(true);
  }, [storedDocuments.length, t]);

  const chooseDiagnosticExport = useCallback(() => {
    setCustomerExportFormat(null);
    setExportHubVisible(false);
    setExportMenuKind('diagnostic');
    setExportMenuVisible(true);
  }, []);

  const chooseCustomerFormat = useCallback((format: CustomerDocumentExportFormat) => {
    setCustomerExportFormat(format);
    setExportHubVisible(false);
    setExportMenuKind('customer');
    setExportMenuVisible(true);
  }, []);

  const runCustomerExport = useCallback(
    async (toExport: StoredDocument[], scope: CustomerDocumentExportScope) => {
      if (toExport.length === 0) {
        Alert.alert(t('export'), t('exportQaDocumentsNoneSelected'));
        return;
      }
      if (!customerExportFormat) return;
      setExportMenuVisible(false);
      setExportPickerVisible(false);
      setExportingCustomer(true);
      try {
        const result = await shareCustomerDocumentsExport({
          documents: toExport,
          format: customerExportFormat,
          scope,
          locale: customerExportLocale(i18n.language),
        });
        if (result === 'unavailable') {
          Alert.alert(t('error'), t('exportShareUnavailable'));
        } else if (result === 'failed') {
          Alert.alert(t('error'), t('exportCustomerError'));
        }
      } catch (error) {
        runtimeLogger.warn('QA_SHARE_FAILED', error, {
          source: 'filesystem',
          stage: 'write',
          status: 'failed',
        });
        Alert.alert(t('error'), t('exportCustomerError'));
      } finally {
        setExportingCustomer(false);
      }
    },
    [customerExportFormat, i18n.language, t]
  );

  const runCustomerExportSelected = useCallback(() => {
    const selected = storedDocuments.filter((document) => exportPickerIds.has(document.id));
    void runCustomerExport(selected, { kind: 'selected' });
  }, [exportPickerIds, runCustomerExport, storedDocuments]);

  const runCustomerExportBatch = useCallback(
    (batch: (typeof exportBatches)[number]) => {
      void runCustomerExport(batch.documents, {
        kind: 'batch',
        from: batch.from,
        to: batch.to,
      });
    },
    [runCustomerExport]
  );

  const openExportPicker = useCallback(() => {
    setExportMenuVisible(false);
    setExportPickerIds(new Set(storedDocuments.map((document) => document.id)));
    setExportPickerVisible(true);
  }, [storedDocuments]);

  const toggleExportPickerSelectAll = useCallback(() => {
    setExportPickerIds((current) => {
      if (storedDocuments.length > 0 && current.size === storedDocuments.length) {
        return new Set();
      }
      return new Set(storedDocuments.map((document) => document.id));
    });
  }, [storedDocuments]);

  const toggleExportPickerSelection = useCallback((id: string) => {
    setExportPickerIds((current) => toggleDocumentSelection(current, id));
  }, []);

  const runExportSelectedFromPicker = useCallback(() => {
    const selected = storedDocuments.filter((document) => exportPickerIds.has(document.id));
    void runExport(selected);
  }, [exportPickerIds, runExport, storedDocuments]);

  const runExportBatch = useCallback(
    (batch: (typeof exportBatches)[number]) => {
      void runExport(batch.documents);
    },
    [runExport],
  );

  const busy = exportingQa || exportingCustomer;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={openScan}
            disabled={busy}
            style={[styles.headerBtn, busy && styles.headerBtnDisabled]}
            accessibilityLabel={t('scan')}
          >
            {compactHeaderActions ? (
              <Ionicons name="camera-outline" size={20} color={busy ? colors.textDisabled : colors.textOnPrimary} />
            ) : (
              <Text style={[styles.headerBtnText, busy && styles.disabledText]}>{t('scan')}</Text>
            )}
          </TouchableOpacity>
          {pdfImportAvailable ? (
            <TouchableOpacity
              onPress={openPdfImport}
              disabled={busy}
              style={[styles.headerBtn, busy && styles.headerBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t('importPdf')}
            >
              <Text style={[styles.headerBtnText, busy && styles.disabledText]}>
                {t('importPdfShort')}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={openExportHub}
            disabled={busy}
            style={[styles.headerBtn, busy && styles.headerBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel={t('export')}
          >
            {compactHeaderActions ? (
              <Ionicons name={EXPORT_HUB_ICONS.header} size={20} color={busy ? colors.textDisabled : colors.textOnPrimary} />
            ) : (
              <Text style={[styles.headerBtnText, busy && styles.disabledText]}>{t('export')}</Text>
            )}
          </TouchableOpacity>
        </View>
      ),
    });
  }, [
    navigation,
    openExportHub,
    openScan,
    openPdfImport,
    pdfImportAvailable,
    busy,
    compactHeaderActions,
    t,
  ]);

  const confirmDelete = (docId: string, title: string) => {
    Alert.alert(t('deleteConfirmTitle'), `"${title}"\n${t('deleteConfirmMessage')}`, [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete'),
        style: 'destructive',
        onPress: () => {
          void removeDocument(docId).catch(() => {
            Alert.alert(t('error'), t('captureFailed'));
          });
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center} accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel={t('loading')}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Modal visible={busy} transparent animationType="fade">
        {busy ? <ExportKeepAwake /> : null}
        <View style={styles.exportOverlay}>
          <View style={styles.exportBox} accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel={exportingCustomer ? t('exportCustomerPreparing') : t('loading')}>
            <ActivityIndicator size="large" color={colors.primary} />
            {exportingCustomer ? (
              <Text style={styles.exportHint}>{t('exportCustomerPreparing')}</Text>
            ) : exportProgress.total > 0 ? (
              <Text style={styles.exportCounter}>
                {t('exportProgressDocumentsCounter', {
                  current: exportProgress.current,
                  total: exportProgress.total,
                })}
              </Text>
            ) : null}
            {!exportingCustomer ? (
              <Text style={styles.exportHint}>{t('exportKeepScreenOn')}</Text>
            ) : null}
          </View>
        </View>
      </Modal>

      <ExportHubMenu
        visible={exportHubVisible}
        title={t('export')}
        titleRef={exportHubTitleRef}
        cancelLabel={t('cancel')}
        onClose={() => setExportHubVisible(false)}
        sections={[
          {
            key: 'data',
            title: t('exportDataSection'),
            actions: [
              {
                key: 'xlsx',
                label: t('exportCustomerFormatXlsx'),
                icon: EXPORT_HUB_ICONS.xlsx,
                onPress: () => chooseCustomerFormat('xlsx'),
              },
              {
                key: 'pdf',
                label: t('exportCustomerFormatPdf'),
                icon: EXPORT_HUB_ICONS.pdf,
                onPress: () => chooseCustomerFormat('pdf'),
              },
            ],
          },
          {
            key: 'support',
            title: t('exportSupportSection'),
            actions: [
              {
                key: 'diagnostic',
                label: t('exportQa'),
                icon: EXPORT_HUB_ICONS.diagnostic,
                variant: 'support',
                onPress: chooseDiagnosticExport,
              },
            ],
          },
        ]}
      />

      <Modal
        visible={exportMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExportMenuVisible(false)}
      >
        <View style={styles.exportOverlay}>
          <TouchableOpacity
            style={styles.menuBackdrop}
            activeOpacity={1}
            onPress={() => setExportMenuVisible(false)}
            accessible={false}
          />
          <View style={styles.menuCard} accessibilityViewIsModal importantForAccessibility="yes">
            <ScrollView
              style={styles.menuScroll}
              contentContainerStyle={styles.menuScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              <View ref={exportMenuTitleRef} accessible accessibilityRole="header">
                <Text style={styles.menuTitle}>
                  {exportMenuKind === 'customer'
                    ? t('exportCustomerChooseDocumentsTitle')
                    : t('exportChooseDocumentsTitle')}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.menuOption}
                onPress={() =>
                  exportMenuKind === 'customer'
                    ? void runCustomerExport(storedDocuments, { kind: 'all' })
                    : void runExport(storedDocuments)
                }
              >
                <Text style={styles.menuOptionText}>
                  {exportMenuKind === 'customer'
                    ? t('exportCustomerAllDocumentsOption', { count: storedDocuments.length })
                    : t('exportAllOption', { count: storedDocuments.length })}
                </Text>
              </TouchableOpacity>
              {showBatchOptions ? (
                <View style={styles.menuBatchSection}>
                  <Text style={styles.menuSectionLabel}>{t('exportBatchSection')}</Text>
                  {exportBatches.map((batch) => (
                    <TouchableOpacity
                      key={`${batch.from}-${batch.to}`}
                      style={styles.menuOption}
                      onPress={() =>
                        exportMenuKind === 'customer'
                          ? runCustomerExportBatch(batch)
                          : runExportBatch(batch)
                      }
                    >
                      <Text style={styles.menuOptionText}>
                        {t('exportBatchDocumentsOption', {
                          from: batch.from,
                          to: batch.to,
                          count: batch.documents.length,
                        })}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              <TouchableOpacity style={styles.menuOption} onPress={openExportPicker}>
                <Text style={styles.menuOptionText}>
                  {exportMenuKind === 'customer'
                    ? t('exportCustomerSelectDocumentsOption')
                    : t('exportSelectOption')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.menuCancel} onPress={() => setExportMenuVisible(false)}>
                <Text style={styles.menuCancelText}>{t('cancel')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={exportPickerVisible}
        animationType="slide"
        onRequestClose={() => setExportPickerVisible(false)}
      >
        <View
          style={[
            styles.pickerContainer,
            { paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <View style={styles.pickerHeader}>
            <View ref={exportPickerTitleRef} accessible accessibilityRole="header" style={styles.pickerTitleWrap}>
              <Text style={styles.pickerTitle}>{t('exportQaDocumentsSelectTitle')}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setExportPickerVisible(false)}
              style={styles.pickerClose}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
            >
              <Ionicons name="close" size={26} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.selectAllRow}
            onPress={toggleExportPickerSelectAll}
            accessibilityRole="checkbox"
            accessibilityLabel={t('exportQaSelectAll')}
            accessibilityState={{ checked: exportPickerAllSelected }}
          >
            <Ionicons
              name={exportPickerAllSelected ? 'checkbox' : 'square-outline'}
              size={24}
              color={colors.primary}
            />
            <Text style={styles.selectAllText}>{t('exportQaSelectAll')}</Text>
            <Text style={styles.selectedCountText}>
              {t('exportQaSelectedCount', {
                count: exportPickerIds.size,
                total: storedDocuments.length,
              })}
            </Text>
          </TouchableOpacity>

          <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
            {storedDocuments.map((item) => {
              const checked = exportPickerIds.has(item.id);
              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.pickerRow}
                  onPress={() => toggleExportPickerSelection(item.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                >
                  <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={checked ? colors.primary : colors.textSecondary}
                  />
                  <View style={styles.pickerRowText}>
                    <Text style={styles.pickerRowTitle} numberOfLines={2}>{item.title}</Text>
                    <Text style={styles.pickerRowMeta}>{t(documentCategoryLabelKey(item))}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.pickerFooter}>
            <TouchableOpacity
              style={[styles.pickerExportBtn, exportPickerIds.size === 0 && styles.pickerExportBtnDisabled]}
              onPress={exportMenuKind === 'customer' ? runCustomerExportSelected : runExportSelectedFromPicker}
              disabled={exportPickerIds.size === 0 || busy}
              accessibilityRole="button"
              accessibilityLabel={t('exportQaDocumentsExportSelected')}
            >
              <Text style={[styles.pickerExportBtnText, exportPickerIds.size === 0 && styles.disabledText]}>
                {t('exportQaDocumentsExportSelected')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={20} color={colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('documentsSearchPlaceholder')}
          placeholderTextColor={colors.textDisabled}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel={t('documentsSearchPlaceholder')}
        />
        {searchQuery.length > 0 ? (
          <TouchableOpacity
            onPress={() => setSearchQuery('')}
            style={styles.searchClear}
            accessibilityLabel={t('documentsSearchClear')}
          >
            <Ionicons name="close-circle" size={20} color={colors.textDisabled} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.typeFilterRow}>
        {FILTER_KEYS.map((filter) => {
          const active = isFilterChipActive(filter, typeSelection);
          return (
            <TouchableOpacity
              key={filter}
              style={[styles.typeFilterChip, active && styles.typeFilterChipActive]}
              onPress={() => handleFilterPress(filter)}
              accessibilityRole="button"
              accessibilityLabel={typeFilterLabel(filter, t)}
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.typeFilterChipText, active && styles.typeFilterChipTextActive]}>
                {typeFilterLabel(filter, t)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <OtherDocumentTypePicker
        visible={otherPickerVisible}
        onSelect={startOtherDocumentScan}
        onCancel={() => setOtherPickerVisible(false)}
      />

      <DocumentScanTypePicker
        visible={scanPickerVisible}
        onSelect={handleScanTypePick}
        onCancel={() => setScanPickerVisible(false)}
      />

      {searchActive || typeFilterActive ? (
        <Text style={styles.searchHint}>
          {t('documentsSearchResults', { count: displayedDocuments.length })}
        </Text>
      ) : searchQuery.trim().length > 0 ? (
        <Text style={styles.searchHint}>
          {t('documentsSearchMinChars', { min: DOCUMENT_SEARCH_MIN_LEN })}
        </Text>
      ) : null}

      {readyExport ? (
        <View style={styles.readyExportBanner}>
          <TouchableOpacity
            style={styles.readyExportShare}
            onPress={() => void shareReadyExport(readyExport)}
            accessibilityRole="button"
            accessibilityLabel={t('exportReadyBannerDocuments', { count: readyExport.documentCount })}
          >
            <Ionicons name="share-outline" size={18} color={colors.textOnPrimary} />
            <Text style={styles.readyExportBannerText}>
              {t('exportReadyBannerDocuments', { count: readyExport.documentCount })}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.readyExportDismiss}
            onPress={() => setReadyExport(null)}
            accessibilityRole="button"
            accessibilityLabel={t('exportClose')}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <Ionicons name="close" size={18} color={colors.textOnPrimary} />
          </TouchableOpacity>
        </View>
      ) : null}

      <SelectionActionBar
        count={selectedCount}
        allVisibleSelected={allVisibleDocumentsSelected}
        someVisibleSelected={someVisibleDocumentsSelected}
        onSelectAll={selectAllDocuments}
        onDeselectVisible={deselectVisibleSelectedDocuments}
        onDismiss={() => setSelectedDocumentIds(new Set())}
        onDelete={confirmBulkDelete}
        busy={deletingSelected}
        busyLabel={
          deletingSelected
            ? t('documentsDeleteProgress', { current: deleteProgress.current, total: deleteProgress.total })
            : undefined
        }
      />

      <FlatList
        data={displayedDocuments}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.empty}>
            {searchActive || typeFilterActive ? t('documentsSearchNoResults') : t('noDocuments')}
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.checkbox}
              onPress={() => toggleSelected(item.id)}
              disabled={deletingSelected}
              accessibilityRole="checkbox"
              accessibilityLabel={t('documentsSelectDocument', { title: item.title })}
              accessibilityHint={t('documentsSelectDocumentHint')}
              accessibilityState={{ checked: selectedDocumentIds.has(item.id), disabled: deletingSelected }}
            >
              <Ionicons
                name={selectedDocumentIds.has(item.id) ? 'checkbox' : 'square-outline'}
                size={24}
                color={selectedDocumentIds.has(item.id) ? colors.primary : colors.textSecondary}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.item}
              onPress={() => router.push(`/document/${item.id}`)}
              accessibilityRole="button"
              accessibilityLabel={item.title}
            >
              <Text
                style={[
                  styles.itemType,
                  {
                    color:
                      TYPE_BADGE_COLORS[item.type as StoredDocumentType] ?? colors.primary,
                  },
                ]}
              >
                {t(documentCategoryLabelKey(item))}
              </Text>
              <Text style={styles.itemTitle} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.itemDate}>
                {new Date(item.updatedAt).toLocaleDateString()}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.deleteBtn}
              onPress={() => confirmDelete(item.id, item.title)}
              accessibilityRole="button"
              accessibilityLabel={`${t('delete')}: ${item.title}`}
            >
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { ...typography.bodySecondary, textAlign: 'center', color: colors.textSecondary, marginTop: 40 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginRight: spacing.md },
  headerBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  headerBtnText: { ...typography.label, color: colors.textOnPrimary },
  disabledText: { color: colors.textDisabled },
  typeFilterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    marginHorizontal: 8,
    marginBottom: 8,
  },
  typeFilterChip: {
    flexGrow: 1,
    flexBasis: 0,
    paddingVertical: 6,
    paddingHorizontal: 8,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  typeFilterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  typeFilterChipText: { ...typography.caption, fontWeight: '600', color: colors.textSecondary, textAlign: 'center' },
  typeFilterChipTextActive: { color: colors.textOnPrimary },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchIcon: { marginRight: 8 },
  searchInput: { ...typography.input, flex: 1, paddingVertical: spacing.sm, color: colors.textPrimary },
  searchClear: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  searchHint: {
    marginHorizontal: 16,
    marginBottom: 8,
    ...typography.caption,
    color: colors.textSecondary,
  },
  exportOverlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  exportBox: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    minWidth: 240,
  },
  exportCounter: { marginTop: spacing.md, ...typography.body, fontWeight: '600', color: colors.textPrimary },
  exportHint: { marginTop: spacing.sm, ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
  menuBackdrop: { ...StyleSheet.absoluteFillObject },
  menuCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 340,
    maxHeight: '80%',
  },
  menuScroll: { flexGrow: 0 },
  menuScrollContent: { paddingBottom: 4 },
  menuTitle: { ...typography.heading3, color: colors.textPrimary, marginBottom: spacing.lg, textAlign: 'center' },
  menuBatchSection: { marginBottom: 4 },
  menuSectionLabel: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 8,
    textAlign: 'center',
  },
  menuOption: {
    backgroundColor: colors.infoSurface,
    padding: 16,
    borderRadius: 10,
    marginBottom: 10,
  },
  menuOptionText: { ...typography.body, fontWeight: '600', color: colors.primary, textAlign: 'center' },
  menuCancel: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  menuCancelText: { ...typography.body, color: colors.textSecondary },
  pickerContainer: { flex: 1, backgroundColor: colors.background },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pickerTitle: { ...typography.heading3, color: colors.textPrimary, flex: 1 },
  pickerTitleWrap: { flex: 1 },
  pickerClose: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  selectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 10,
  },
  selectAllText: { ...typography.body, fontWeight: '600', color: colors.textPrimary, flex: 1 },
  selectedCountText: { ...typography.caption, color: colors.textSecondary },
  pickerList: { flex: 1, marginTop: 8 },
  pickerListContent: { paddingHorizontal: 16, paddingBottom: 16 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
  },
  pickerRowText: { flex: 1 },
  pickerRowTitle: { ...typography.label, color: colors.textPrimary },
  pickerRowMeta: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xxs },
  pickerFooter: {
    padding: 16,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pickerExportBtn: {
    backgroundColor: colors.primary,
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  pickerExportBtnDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  pickerExportBtnText: { ...typography.button, color: colors.textOnPrimary },
  readyExportBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  readyExportShare: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
  },
  readyExportDismiss: {
    width: spacing.xxxl + 4,
    height: spacing.xxxl + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readyExportBannerText: { ...typography.button, color: colors.textOnPrimary, flexShrink: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginHorizontal: 16,
    marginBottom: 6,
    gap: 6,
  },
  checkbox: {
    minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center', backgroundColor: colors.surface, borderRadius: radii.sm,
  },
  item: {
    flex: 1,
    backgroundColor: colors.surface,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  itemType: { ...typography.caption, color: colors.primary, fontWeight: '600', marginBottom: spacing.xxs },
  itemTitle: { ...typography.label, color: colors.textPrimary },
  itemDate: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xxs },
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 42,
    minHeight: 44,
  },
});
