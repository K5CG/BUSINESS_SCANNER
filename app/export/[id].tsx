import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  ScrollView,
  ActivityIndicator,
  Share,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
} from 'expo-router';
import { useDocumentStore } from '../../store/useDocumentStore';
import { useContactStore } from '../../store/useContactStore';
import { getDocumentById, getContactById } from '../../lib/storage';
import { AnyDocument, BusinessCard } from '../../types';
import { exportToJson, exportToCsv } from '../../lib/export';
import { shareContactVCardFile } from '../../lib/share-vcard';
import { shareDocumentByEmail, EmailShareMode } from '../../lib/share-document';
import { getDocumentNotes, withDocumentNotes } from '../../lib/document-notes';
import { EmailSharePicker } from '../../components/EmailSharePicker';
import { DocumentNotesField } from '../../components/DocumentNotesField';
import { useTranslation } from 'react-i18next';
import { useKeyboardInset } from '../../lib/use-keyboard-inset';
import { createLatestOperationController } from '../../lib/guarded-operation';
import {
  isInactiveScanOperationError,
  type ActiveOperationGuard,
} from '../../lib/scan-operation-lifecycle';
import { createExclusiveOperationGate } from '../../lib/exclusive-operation-gate';
import { colors } from '../../lib/ui-theme';
import { radii, spacing, typography } from '../../lib/ui-system';

export default function ExportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { updateDocument } = useDocumentStore();
  const { updateContact } = useContactStore();
  const [item, setItem] = useState<AnyDocument | BusinessCard | null>(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [pickerVisible, setPickerVisible] = useState(false);
  const { t } = useTranslation();
  const navigation = useNavigation();
  const scrollRef = useRef<ScrollView>(null);
  const keyboardInset = useKeyboardInset();
  const mountedRef = useRef(true);
  const screenActiveRef = useRef(false);
  const loadOperationsRef = useRef(createLatestOperationController());
  const actionOperationsRef = useRef(createLatestOperationController());
  const shareGateRef = useRef(createExclusiveOperationGate());

  const keyboardPadding = keyboardInset > 0 ? keyboardInset + 56 : 0;

  const scrollToNotes = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: 100, animated: true });
    }, 300);
  }, []);

  const cancelScreenOperations = useCallback(() => {
    loadOperationsRef.current.invalidateCurrent('screen_blurred');
    actionOperationsRef.current.invalidateCurrent('screen_blurred');
    shareGateRef.current.invalidateCurrent();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    shareGateRef.current = createExclusiveOperationGate();
    return () => {
      mountedRef.current = false;
      screenActiveRef.current = false;
      loadOperationsRef.current.dispose();
      actionOperationsRef.current.dispose();
      shareGateRef.current.dispose();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      screenActiveRef.current = true;
      return () => {
        screenActiveRef.current = false;
        cancelScreenOperations();
      };
    }, [cancelScreenOperations])
  );

  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        cancelScreenOperations();
      }),
    [cancelScreenOperations, navigation]
  );

  useEffect(() => {
    if (!id) return;
    const operation = loadOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    (async () => {
      if (isActive()) setLoading(true);
      try {
        const fromDoc = await getDocumentById(id);
        if (!isActive()) return;
        const fromContact = fromDoc ? null : await getContactById(id);
        if (!isActive()) return;
        setItem(fromDoc ?? fromContact);
        setNotes(getDocumentNotes(fromDoc ?? fromContact ?? ({} as AnyDocument)));
        setLoading(false);
      } catch {
        if (isActive()) {
          setItem(null);
          setLoading(false);
        }
      } finally {
        if (loadOperationsRef.current.isCurrent(operation)) {
          loadOperationsRef.current.finish(operation);
        }
      }
    })();
  }, [id]);

  const persistNotes = async (
    doc: AnyDocument,
    operation: ActiveOperationGuard
  ) => {
    const updated = withDocumentNotes(doc, notes);
    const persisted =
      updated.type === 'business_card'
        ? await updateContact(updated as BusinessCard, operation)
        : await updateDocument(updated, operation);
    if (!operation.isActive()) return persisted;
    setItem(persisted);
    return persisted;
  };

  const shareVCardFile = async (contact: BusinessCard) => {
    if (!screenActiveRef.current) return;
    const exclusiveLease = shareGateRef.current.tryAcquire();
    if (!exclusiveLease) return;
    const operation = actionOperationsRef.current.begin();
    try {
      if (!operation.tryFinalize()) return;
      const shared = await shareContactVCardFile(contact);
      if (
        !shared &&
        mountedRef.current &&
        screenActiveRef.current &&
        operation.isCurrent()
      ) {
        Alert.alert(t('error'), t('exportShareUnavailable'));
      }
    } catch {
      if (
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) {
        return;
      }
      Alert.alert(t('error'), t('shareError'));
    } finally {
      exclusiveLease.release();
      if (actionOperationsRef.current.isCurrent(operation)) {
        actionOperationsRef.current.finish(operation);
      }
    }
  };

  const shareContent = async (content: string, title: string) => {
    if (!screenActiveRef.current) return;
    const exclusiveLease = shareGateRef.current.tryAcquire();
    if (!exclusiveLease) return;
    const operation = actionOperationsRef.current.begin();
    try {
      if (!operation.tryFinalize()) return;
      await Share.share({ message: content, title });
    } catch {
      if (
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) {
        return;
      }
      Alert.alert(t('error'), t('shareError'));
    } finally {
      exclusiveLease.release();
      if (actionOperationsRef.current.isCurrent(operation)) {
        actionOperationsRef.current.finish(operation);
      }
    }
  };

  const handleEmailMode = async (mode: EmailShareMode) => {
    if (!item || !screenActiveRef.current) return;
    const exclusiveLease = shareGateRef.current.tryAcquire();
    if (!exclusiveLease) return;
    const operation = actionOperationsRef.current.begin();
    const isActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    try {
      const updated = await persistNotes(item, {
        operationId: operation.operationId,
        isActive,
      });
      if (!isActive() || !operation.tryFinalize()) return;
      await shareDocumentByEmail(updated, mode, notes);
    } catch (error) {
      if (
        isInactiveScanOperationError(error) ||
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) {
        return;
      }
      Alert.alert(t('error'), t('shareError'));
    } finally {
      exclusiveLease.release();
      if (actionOperationsRef.current.isCurrent(operation)) {
        actionOperationsRef.current.finish(operation);
      }
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!item) return <View style={styles.container} />;

  const isBusinessCard = item.type === 'business_card';

  return (
    <>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' || keyboardInset > 0 ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 28}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.container}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: 40 + keyboardPadding },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          <Text style={styles.title}>{t('export')}</Text>
          <Text style={styles.hint}>{t('exportHint')}</Text>

          <DocumentNotesField
            value={notes}
            onChangeText={setNotes}
            onFocus={scrollToNotes}
          />

          <Text style={styles.section}>{t('sendByEmail')}</Text>
          <TouchableOpacity
            style={[styles.option, styles.optionPrimary]}
            onPress={() => setPickerVisible(true)}
          >
            <Text style={styles.optionTextPrimary}>{t('sendByEmail')}</Text>
            <Text style={styles.optionSubtext}>{t('emailShareSubtext')}</Text>
          </TouchableOpacity>

          <Text style={styles.section}>{t('otherFormats')}</Text>

          {isBusinessCard && (
            <TouchableOpacity
              style={styles.option}
              onPress={() => void shareVCardFile(item as BusinessCard)}
            >
              <Text style={styles.optionText}>{t('exportVCard')}</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.option}
            onPress={() => shareContent(exportToJson(item as AnyDocument), 'JSON')}
          >
            <Text style={styles.optionText}>{t('exportJson')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.option}
            onPress={() => shareContent(exportToCsv(item as AnyDocument), 'CSV')}
          >
            <Text style={styles.optionText}>{t('exportCsv')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <EmailSharePicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={handleEmailMode}
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: spacing.xl, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { ...typography.heading1, color: colors.textPrimary, marginBottom: spacing.sm },
  hint: { ...typography.bodySecondary, color: colors.textSecondary, marginBottom: spacing.lg },
  section: {
    ...typography.label,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: 10,
    marginTop: 8,
  },
  option: {
    backgroundColor: colors.surface,
    padding: 18,
    borderRadius: radii.md,
    marginBottom: spacing.md,
  },
  optionPrimary: {
    backgroundColor: colors.primary,
  },
  optionText: { ...typography.body, fontWeight: '600', color: colors.primary },
  optionTextPrimary: { ...typography.button, color: colors.textOnPrimary },
  optionSubtext: { ...typography.caption, color: colors.textOnPrimary, marginTop: spacing.xs },
});
