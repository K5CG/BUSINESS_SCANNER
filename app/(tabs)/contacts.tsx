import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useContactStore } from '../../store/useContactStore';
import {
  contactMatchesQuery,
  contactDisplayName,
  CONTACT_SEARCH_MIN_LEN,
} from '../../lib/contact-search';
import { ContactPhotoAvatar } from '../../components/ContactPhotoSection';
import { ContactSortControls } from '../../components/ContactSortControls';
import { SelectionActionBar } from '../../components/SelectionActionBar';
import {
  deselectVisibleDocuments,
  selectVisibleDocuments,
} from '../../lib/document-selection';
import { ExportKeepAwake } from '../../components/ExportKeepAwake';
import { EXPORT_HUB_ICONS, ExportHubMenu } from '../../components/ExportHubMenu';
import { confirmDiagnosticExport } from '../../lib/diagnostic-export-confirm';
import {
  customerExportLocale,
  type CustomerContactExportFormat,
  type CustomerContactExportScope,
} from '../../lib/export-contacts-customer';
import { exportContactsQa, shareContactsQaZip, type QaExportBatchMeta, type QaExportResult } from '../../lib/export-qa';
import { EXPORT_BATCH_SIZE, splitContactsIntoExportBatches } from '../../lib/export-batches';
import { shareCustomerContactsExport } from '../../lib/share-contacts-customer';
import {
  applyPreparedBusinessCardReocrBatch,
  clearAllContactsFromDevice,
  prepareBusinessCardReocrBatch,
  type PreparedBusinessCardReocrBatch,
} from '../../lib/contact-reparse';
import { acquireScreenWake, releaseScreenWake } from '../../lib/screen-wake';
import { runtimeLogger } from '../../lib/safe-runtime-logger';
import { colors } from '../../lib/ui-theme';
import { getUiViewportLayout } from '../../lib/ui-layout';
import { radii, spacing, typography } from '../../lib/ui-system';
import { useModalAccessibilityFocus } from '../../lib/use-modal-accessibility-focus';
import {
  sortContactsForExport,
  type ContactExportSortMode,
} from '../../lib/contact-export-sort';
import type { BusinessCard } from '../../types';

function contactLabel(card: BusinessCard, fallback: string): string {
  const name = [card.firstName, card.lastName].filter(Boolean).join(' ');
  if (name && card.company) return `${name} — ${card.company}`;
  return name || card.company || card.title || fallback;
}

export default function ContactsScreen() {
  const { t, i18n } = useTranslation();
  const { width, fontScale } = useWindowDimensions();
  const { compactHeaderActions } = getUiViewportLayout(width, fontScale);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { contacts, loading, loadContacts, removeContact } = useContactStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<ContactExportSortMode>('newest');
  const [exportingQa, setExportingQa] = useState(false);
  const [exportingCustomer, setExportingCustomer] = useState(false);
  const [reparseRunning, setReparseRunning] = useState(false);
  const [exportMenuKind, setExportMenuKind] = useState<'diagnostic' | 'customer'>('diagnostic');
  const [customerExportFormat, setCustomerExportFormat] = useState<CustomerContactExportFormat | null>(null);
  const [exportMenuVisible, setExportMenuVisible] = useState(false);
  const [exportHubVisible, setExportHubVisible] = useState(false);
  const [exportPickerVisible, setExportPickerVisible] = useState(false);
  const exportMenuTitleRef = useRef<View>(null);
  const exportHubTitleRef = useRef<View>(null);
  const exportPickerTitleRef = useRef<View>(null);
  useModalAccessibilityFocus(exportMenuVisible, exportMenuTitleRef);
  useModalAccessibilityFocus(exportHubVisible, exportHubTitleRef);
  useModalAccessibilityFocus(exportPickerVisible, exportPickerTitleRef);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [listSelectedIds, setListSelectedIds] = useState<Set<string>>(new Set());
  const [deletingSelected, setDeletingSelected] = useState(false);
  const deletingSelectedRef = useRef(false);
  const [exportSortMode, setExportSortMode] = useState<ContactExportSortMode>('newest');
  const [exportingCount, setExportingCount] = useState(0);
  const [exportProgressCurrent, setExportProgressCurrent] = useState(0);
  const [exportProgressText, setExportProgressText] = useState('');
  const [readyExport, setReadyExport] = useState<QaExportResult | null>(null);

  useEffect(() => {
    if (contacts.length === 0) {
      void loadContacts().catch(() => undefined);
    }
  }, [contacts.length, loadContacts]);

  const fallbackLabel = t('businessCard');
  const displayedContacts = useMemo(() => {
    const filtered = contacts.filter((c) => contactMatchesQuery(c, searchQuery));
    return sortContactsForExport(filtered, sortMode, fallbackLabel);
  }, [contacts, searchQuery, sortMode, fallbackLabel]);

  const searchActive = searchQuery.trim().length >= CONTACT_SEARCH_MIN_LEN;
  const allSelected = contacts.length > 0 && selectedIds.size === contacts.length;
  const selectedListCount = listSelectedIds.size;
  const allVisibleContactsSelected =
    displayedContacts.length > 0 &&
    displayedContacts.every((contact) => listSelectedIds.has(contact.id));
  const someVisibleContactsSelected = displayedContacts.some((contact) =>
    listSelectedIds.has(contact.id),
  );

  useEffect(() => {
    const existingIds = new Set(contacts.map((contact) => contact.id));
    setListSelectedIds((current) => {
      const next = new Set([...current].filter((id) => existingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [contacts]);

  const selectAllVisibleContacts = useCallback(() => {
    setListSelectedIds((current) =>
      selectVisibleDocuments(current, displayedContacts.map((contact) => contact.id)),
    );
  }, [displayedContacts]);

  const deselectVisibleSelectedContacts = useCallback(() => {
    setListSelectedIds((current) =>
      deselectVisibleDocuments(current, displayedContacts.map((contact) => contact.id)),
    );
  }, [displayedContacts]);

  const toggleListContactSelection = useCallback((id: string) => {
    setListSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exportBatches = useMemo(
    () => splitContactsIntoExportBatches(contacts, EXPORT_BATCH_SIZE),
    [contacts]
  );
  // I blocchi numerati sono utili soltanto agli export cliente molto grandi.
  // L'export diagnostico deve restare stabile e semplice: tutti, selezione,
  // oppure rielaborazione, senza numerazioni dipendenti dall'ordine della lista.
  const showBatchOptions = exportMenuKind === 'customer' && exportBatches.length > 1;

  const openExportHub = useCallback(() => {
    if (contacts.length === 0) {
      Alert.alert(t('export'), t('exportCustomerNoContacts'));
      return;
    }
    setExportHubVisible(true);
  }, [contacts.length, t]);

  const chooseCustomerFormat = useCallback((format: CustomerContactExportFormat) => {
    setCustomerExportFormat(format);
    setExportHubVisible(false);
    setExportMenuKind('customer');
    setExportMenuVisible(true);
  }, []);

  const chooseDiagnosticExport = useCallback(() => {
    setCustomerExportFormat(null);
    setExportHubVisible(false);
    setExportMenuKind('diagnostic');
    setExportMenuVisible(true);
  }, []);

  const openSelectPicker = useCallback(() => {
    setExportMenuVisible(false);
    setSelectedIds(new Set(contacts.map((c) => c.id)));
    setExportPickerVisible(true);
  }, [contacts]);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (contacts.length > 0 && prev.size === contacts.length) return new Set();
      return new Set(contacts.map((c) => c.id));
    });
  }, [contacts]);

  const toggleContactSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const shareReadyExport = useCallback(
    async (result: QaExportResult) => {
      const ok = await shareContactsQaZip(result.zipPath);
      if (!ok) Alert.alert(t('error'), t('exportShareUnavailable'));
    },
    [t]
  );

  const showExportDone = useCallback(
    (result: QaExportResult) => {
      setReadyExport(result);
      const sizeMb = (result.sizeBytes / (1024 * 1024)).toFixed(1);
      Alert.alert(
        t('exportDoneTitle'),
        t('exportDoneMessage', {
          fileName: result.fileName,
          count: result.contactCount,
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
        ]
      );
    },
    [shareReadyExport, t]
  );

  const runExport = useCallback(
    async (toExport: BusinessCard[], batch?: QaExportBatchMeta) => {
      if (toExport.length === 0) {
        Alert.alert(t('error'), t('exportQaNoneSelected'));
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
      setExportingCount(toExport.length);
      setExportProgressCurrent(0);
      setExportProgressText('');
      setExportingQa(true);
      await acquireScreenWake();
      try {
        const result = await exportContactsQa(
          toExport,
          (progress) => {
            setExportProgressCurrent(progress.current);
            if (progress.phase === 'zip') {
              setExportProgressText(t('exportProgressZip'));
            } else {
              setExportProgressText('');
            }
          },
          batch
        );
        showExportDone(result);
      } catch (error) {
        runtimeLogger.warn('CONTACT_EXPORT_FAILED', error, {
          stage: 'filesystem',
          status: 'failed',
        });
        Alert.alert(t('error'), t('exportQaError'));
      } finally {
        await releaseScreenWake();
        setExportingQa(false);
        setExportingCount(0);
        setExportProgressCurrent(0);
        setExportProgressText('');
      }
    },
    [showExportDone, t]
  );

  const runExportSelected = useCallback(() => {
    const selected = contacts.filter((c) => selectedIds.has(c.id));
    void runExport(selected);
  }, [contacts, selectedIds, runExport]);

  const runExportBatch = useCallback(
    (batch: (typeof exportBatches)[number]) => {
      void runExport(batch.contacts, {
        from: batch.from,
        to: batch.to,
        totalInApp: contacts.length,
      });
    },
    [contacts.length, runExport]
  );

  const runCustomerExport = useCallback(
    async (toExport: BusinessCard[], scope: CustomerContactExportScope) => {
      if (toExport.length === 0) {
        Alert.alert(t('export'), t('exportQaNoneSelected'));
        return;
      }
      if (!customerExportFormat) return;
      setExportMenuVisible(false);
      setExportPickerVisible(false);
      setExportingCustomer(true);
      try {
        const result = await shareCustomerContactsExport({
          contacts: toExport,
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
        runtimeLogger.warn('CONTACT_EXPORT_FAILED', error, {
          stage: 'filesystem',
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
    const selected = contacts.filter((c) => selectedIds.has(c.id));
    void runCustomerExport(selected, { kind: 'selected' });
  }, [contacts, selectedIds, runCustomerExport]);

  const runCustomerExportBatch = useCallback(
    (batch: (typeof exportBatches)[number]) => {
      void runCustomerExport(batch.contacts, {
        kind: 'batch',
        from: batch.from,
        to: batch.to,
      });
    },
    [runCustomerExport]
  );

  const runReparseAll = useCallback(() => {
    if (contacts.length === 0) {
      Alert.alert(t('error'), t('exportQaNoContacts'));
      return;
    }
    setExportMenuVisible(false);
    const applyPreparedBatch = async (batch: PreparedBusinessCardReocrBatch) => {
      setReparseRunning(true);
      setExportingCount(contacts.length);
      setExportProgressCurrent(0);
      setExportProgressText('');
      await acquireScreenWake();
      try {
        const summary = await applyPreparedBusinessCardReocrBatch(batch);
        await loadContacts();
        Alert.alert(
          t('reparseDoneTitle'),
          t('reparseAllDone', {
            updated: summary.applied,
            changed: batch.changed,
            unchanged: batch.unchanged,
            skipped: batch.skipped + summary.stale,
            errors: batch.errors + summary.errors,
            parserBuildId: batch.parserBuildId,
          })
        );
      } catch (error) {
        runtimeLogger.warn('CONTACT_REPARSE_FAILED', error, {
          stage: 'database',
          status: 'failed',
        });
        Alert.alert(t('error'), t('reparseAllError'));
      } finally {
        await releaseScreenWake();
        setReparseRunning(false);
        setExportingCount(0);
        setExportProgressCurrent(0);
        setExportProgressText('');
      }
    };
    const runTrueReocr = async () => {
      setReparseRunning(true);
      setExportingCount(contacts.length);
      setExportProgressCurrent(0);
      setExportProgressText('');
      await acquireScreenWake();
      try {
        const batch = await prepareBusinessCardReocrBatch(
          (progress) => {
            setExportProgressCurrent(progress.current);
            setExportProgressText(
              t('reparseAllRunning', {
                current: progress.current,
                total: progress.total,
              })
            );
          }
        );
        Alert.alert(
          t('reparseAllPreviewTitle'),
          t('reparseAllPreviewMessage', {
            changed: batch.changed,
            unchanged: batch.unchanged,
            skipped: batch.skipped,
            errors: batch.errors,
          })
          ,[
            { text: t('cancel'), style: 'cancel' },
            {
              text: t('reparseAllApply'),
              onPress: () => { void applyPreparedBatch(batch); },
            },
          ]
        );
      } catch (error) {
        runtimeLogger.warn('CONTACT_REPARSE_FAILED', error, {
          stage: 'parse',
          status: 'failed',
        });
        Alert.alert(t('error'), t('reparseAllError'));
      } finally {
        await releaseScreenWake();
        setReparseRunning(false);
        setExportingCount(0);
        setExportProgressCurrent(0);
        setExportProgressText('');
      }
    };
    Alert.alert(t('reparseAllConfirmTitle'), t('reparseAllConfirmMessage', { count: contacts.length }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('reparseAllTitle'),
        onPress: () => {
          void runTrueReocr();
        },
      },
    ]);
  }, [contacts.length, loadContacts, t]);

  const runClearAllContacts = useCallback(() => {
    if (contacts.length === 0) {
      Alert.alert(t('clearAllContactsEmpty'));
      return;
    }
    setExportMenuVisible(false);
    Alert.alert(t('clearAllContactsTitle'), t('clearAllContactsMessage', { count: contacts.length }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('clearAllContactsConfirm'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              const removed = await clearAllContactsFromDevice();
              await loadContacts();
              Alert.alert(t('clearAllContactsDoneTitle'), t('clearAllContactsDone', { count: removed }));
            } catch (error) {
              runtimeLogger.warn('CONTACT_CLEAR_FAILED', error, {
                stage: 'database',
                status: 'failed',
              });
              Alert.alert(t('error'), t('clearAllContactsError'));
            }
          })();
        },
      },
    ]);
  }, [contacts.length, loadContacts, t]);

  const busy = exportingQa || exportingCustomer || reparseRunning;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[styles.headerBtn, busy && styles.headerBtnDisabled]}
            onPress={() => router.push('/scan/business_card')}
            disabled={busy}
            accessibilityLabel={t('scan')}
          >
            {compactHeaderActions ? (
              <Ionicons name="camera-outline" size={20} color={busy ? colors.textDisabled : colors.textOnPrimary} />
            ) : (
              <Text style={[styles.headerBtnText, busy && styles.disabledText]}>{t('scan')}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.headerBtn, busy && styles.headerBtnDisabled]}
            onPress={openExportHub}
            disabled={busy}
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
  }, [navigation, openExportHub, busy, compactHeaderActions, t]);

  const sortedContactsForPicker = useMemo(
    () => sortContactsForExport(contacts, exportSortMode, t('businessCard')),
    [contacts, exportSortMode, t]
  );

  const confirmDelete = (id: string, title: string) => {
    Alert.alert(t('deleteConfirmTitle'), `"${title}"\n${t('deleteConfirmMessage')}`, [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete'),
        style: 'destructive',
        onPress: () => {
          void removeContact(id).catch(() => {
            Alert.alert(t('error'), t('captureFailed'));
          });
        },
      },
    ]);
  };

  const confirmBulkDelete = useCallback(() => {
    if (selectedListCount === 0 || deletingSelectedRef.current) return;
    Alert.alert(
      t('deleteConfirmTitle'),
      t('selectionDeleteConfirmMessage', { count: selectedListCount }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: () => {
            if (deletingSelectedRef.current) return;
            deletingSelectedRef.current = true;
            setDeletingSelected(true);
            const ids = [...listSelectedIds];
            void (async () => {
              const failed = new Set<string>();
              for (const id of ids) {
                try {
                  await removeContact(id);
                } catch {
                  failed.add(id);
                }
              }
              setListSelectedIds(failed);
            })()
              .catch(() => {
                Alert.alert(t('error'), t('captureFailed'));
              })
              .finally(() => {
                deletingSelectedRef.current = false;
                setDeletingSelected(false);
              });
          },
        },
      ],
    );
  }, [listSelectedIds, removeContact, selectedListCount, t]);

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
          <View style={styles.exportBox} accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel={exportingCustomer ? t('exportCustomerPreparing') : (exportProgressText || t('loading'))}>
            <ActivityIndicator size="large" color={colors.primary} />
            {exportingCustomer ? (
              <Text style={styles.exportText}>{t('exportCustomerPreparing')}</Text>
            ) : exportingCount > 0 ? (
              <Text style={styles.exportCounter}>
                {t(reparseRunning ? 'reparseProgressCounter' : 'exportProgressCounter', {
                  current: exportProgressCurrent,
                  total: exportingCount,
                })}
              </Text>
            ) : null}
            {!exportingCustomer && exportProgressText ? (
              <Text style={styles.exportText}>{exportProgressText}</Text>
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
                key: 'csv',
                label: t('exportCustomerFormatCsv'),
                icon: EXPORT_HUB_ICONS.csv,
                onPress: () => chooseCustomerFormat('csv'),
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
                  {exportMenuKind === 'customer' ? t('exportCustomerChooseTitle') : t('exportChooseTitle')}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.menuOption}
                onPress={() =>
                  exportMenuKind === 'customer'
                    ? void runCustomerExport(contacts, { kind: 'all' })
                    : void runExport(contacts)
                }
              >
                <Text style={styles.menuOptionText}>
                  {exportMenuKind === 'customer'
                    ? t('exportCustomerAllOption', { count: contacts.length })
                    : t('exportAllOption', { count: contacts.length })}
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
                        {t('exportBatchOption', {
                          from: batch.from,
                          to: batch.to,
                          count: batch.contacts.length,
                        })}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              <TouchableOpacity style={styles.menuOption} onPress={openSelectPicker}>
                <Text style={styles.menuOptionText}>
                  {exportMenuKind === 'customer' ? t('exportCustomerSelectOption') : t('exportSelectOption')}
                </Text>
              </TouchableOpacity>
              {exportMenuKind === 'diagnostic' && __DEV__ ? (
                <TouchableOpacity style={styles.menuOptionDanger} onPress={runClearAllContacts}>
                  <Text style={styles.menuOptionDangerText}>{t('clearAllContactsTitle')}</Text>
                </TouchableOpacity>
              ) : null}
              {exportMenuKind === 'diagnostic' ? (
                <TouchableOpacity style={styles.menuOption} onPress={runReparseAll}>
                  <Text style={styles.menuOptionText}>{t('reparseAllTitle')}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.menuCancel} onPress={() => setExportMenuVisible(false)}>
                <Text style={styles.menuCancelText}>{t('cancel')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={exportPickerVisible} animationType="slide" onRequestClose={() => setExportPickerVisible(false)}>
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
              <Text style={styles.pickerTitle}>{t('exportQaSelectTitle')}</Text>
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
            onPress={toggleSelectAll}
            accessibilityRole="checkbox"
            accessibilityLabel={t('exportQaSelectAll')}
            accessibilityState={{ checked: allSelected }}
          >
            <Ionicons name={allSelected ? 'checkbox' : 'square-outline'} size={24} color={colors.primary} />
            <Text style={styles.selectAllText}>{t('exportQaSelectAll')}</Text>
            <Text style={styles.selectedCountText}>
              {t('exportQaSelectedCount', { count: selectedIds.size, total: contacts.length })}
            </Text>
          </TouchableOpacity>

          <ContactSortControls
            value={exportSortMode}
            onChange={setExportSortMode}
            accessibilityLabel={t('exportSortLabel')}
            style={styles.exportSortSection}
          />

          <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
            {sortedContactsForPicker.map((item) => {
              const checked = selectedIds.has(item.id);
              const label = contactLabel(item, t('businessCard'));
              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.pickerRow}
                  onPress={() => toggleContactSelection(item.id)}
                  accessibilityRole="checkbox"
                  accessibilityLabel={label}
                  accessibilityState={{ checked }}
                >
                  <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={checked ? colors.primary : colors.textDisabled}
                  />
                  <View style={styles.pickerRowBody}>
                    <Text style={styles.pickerRowTitle} numberOfLines={2}>
                      {label}
                    </Text>
                    {item.emails[0] ? (
                      <Text style={styles.pickerRowSub} numberOfLines={1}>
                        {item.emails[0]}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.pickerFooter}>
            <TouchableOpacity
              style={[styles.pickerExportBtn, selectedIds.size === 0 && styles.pickerExportBtnDisabled]}
              onPress={exportMenuKind === 'customer' ? runCustomerExportSelected : runExportSelected}
              disabled={selectedIds.size === 0}
              accessibilityRole="button"
              accessibilityLabel={t('exportQaExportSelected')}
              accessibilityState={{ disabled: selectedIds.size === 0 }}
            >
              <Text style={[styles.pickerExportBtnText, selectedIds.size === 0 && styles.disabledText]}>
                {t('exportQaExportSelected')}
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
          placeholder={t('contactsSearchPlaceholder')}
          placeholderTextColor={colors.textDisabled}
          multiline={false}
          numberOfLines={1}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel={t('contactsSearchPlaceholder')}
        />
        {searchQuery.length > 0 ? (
          <TouchableOpacity
            onPress={() => setSearchQuery('')}
            style={styles.searchClear}
            accessibilityLabel={t('contactsSearchClear')}
          >
            <Ionicons name="close-circle" size={20} color={colors.textDisabled} />
          </TouchableOpacity>
        ) : null}
      </View>

      <ContactSortControls
        value={sortMode}
        onChange={setSortMode}
        accessibilityLabel={t('contactsSortLabel')}
        style={styles.sortControls}
      />

      {searchActive ? (
        <Text style={styles.searchHint}>
          {t('contactsSearchResults', { count: displayedContacts.length })}
        </Text>
      ) : searchQuery.trim().length > 0 ? (
        <Text style={styles.searchHint}>{t('contactsSearchMinChars', { min: CONTACT_SEARCH_MIN_LEN })}</Text>
      ) : null}

      <SelectionActionBar
        count={selectedListCount}
        allVisibleSelected={allVisibleContactsSelected}
        someVisibleSelected={someVisibleContactsSelected}
        onSelectAll={selectAllVisibleContacts}
        onDeselectVisible={deselectVisibleSelectedContacts}
        onDismiss={() => setListSelectedIds(new Set())}
        onDelete={confirmBulkDelete}
        busy={deletingSelected}
      />

      {readyExport ? (
        <View style={styles.readyExportBanner}>
          <TouchableOpacity
            style={styles.readyExportShare}
            onPress={() => void shareReadyExport(readyExport)}
            accessibilityRole="button"
            accessibilityLabel={t('exportReadyBanner', { count: readyExport.contactCount })}
          >
            <Ionicons name="share-outline" size={22} color={colors.textOnPrimary} />
            <Text style={styles.readyExportBannerText}>
              {t('exportReadyBanner', { count: readyExport.contactCount })}
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

      <FlatList
        data={displayedContacts}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.empty}>
            {searchActive ? t('contactsSearchNoResults') : t('noContacts')}
          </Text>
        }
        renderItem={({ item }) => {
          const title = contactDisplayName(item, fallbackLabel);
          return (
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.checkbox}
                onPress={() => toggleListContactSelection(item.id)}
                disabled={deletingSelected}
                accessibilityRole="checkbox"
                accessibilityLabel={title}
                accessibilityState={{ checked: listSelectedIds.has(item.id), disabled: deletingSelected }}
              >
                <Ionicons
                  name={listSelectedIds.has(item.id) ? 'checkbox' : 'square-outline'}
                  size={24}
                  color={listSelectedIds.has(item.id) ? colors.primary : colors.textSecondary}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.item}
                onPress={() => router.push(`/document/${item.id}`)}
                accessibilityRole="button"
                accessibilityLabel={title}
              >
                <ContactPhotoAvatar photoUri={item.contactPhotoUri} size={40} />
                <View style={styles.itemBody}>
                  <Text style={styles.itemTitle} numberOfLines={1}>
                    {item.firstName} {item.lastName}
                  </Text>
                  <Text style={styles.itemSubtitle} numberOfLines={1}>
                    {item.company || item.emails[0]}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => confirmDelete(item.id, title)}
                accessibilityRole="button"
                accessibilityLabel={`${t('delete')}: ${title}`}
              >
                <Ionicons name="trash-outline" size={22} color={colors.danger} />
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
  exportOverlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  exportBox: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 28,
    paddingHorizontal: 32,
    alignItems: 'center',
    minWidth: 260,
  },
  exportCounter: {
    marginTop: spacing.lg,
    ...typography.heading3,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  exportText: { marginTop: spacing.sm, ...typography.bodySecondary, color: colors.textSecondary, textAlign: 'center' },
  exportHint: { marginTop: spacing.md, ...typography.bodySecondary, color: colors.textSecondary, textAlign: 'center' },
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
  menuOptionDanger: {
    backgroundColor: colors.dangerSurface,
    padding: 16,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  menuOptionDangerText: { ...typography.body, fontWeight: '600', color: colors.danger, textAlign: 'center' },
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
  exportSortSection: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
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
  pickerRowBody: { flex: 1 },
  pickerRowTitle: { ...typography.label, color: colors.textPrimary },
  pickerRowSub: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xxs },
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
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
  // `textAlignVertical: center` evita che su Android il testo scivoli sotto la
  // linea di base lasciando frammenti visibili sotto il segnaposto.
  searchInput: {
    ...typography.input,
    flex: 1,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    textAlignVertical: 'center',
  },
  searchClear: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sortControls: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  searchHint: {
    marginHorizontal: 16,
    marginBottom: 8,
    ...typography.caption,
    color: colors.textSecondary,
  },
  readyExportBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.success,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  readyExportShare: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
  },
  readyExportDismiss: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readyExportBannerText: { ...typography.button, color: colors.textOnPrimary, flexShrink: 1 },
  empty: { ...typography.body, textAlign: 'center', color: colors.textSecondary, marginTop: 40 },
  checkbox: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginHorizontal: 16,
    marginBottom: 6,
    gap: 6,
  },
  item: {
    flex: 1,
    backgroundColor: colors.surface,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  itemBody: { flex: 1, minWidth: 0 },
  // Stesso comando di eliminazione dell'elenco documenti: icona rossa su
  // superficie neutra, senza cornice che riquadri la riga.
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 0,
    minWidth: 42,
    minHeight: 44,
  },
  itemTitle: { ...typography.label, color: colors.textPrimary },
  itemSubtitle: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xxs },
});
