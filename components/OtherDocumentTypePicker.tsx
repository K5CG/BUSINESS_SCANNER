import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { OtherDocumentCategory } from '../lib/document-category';
import { DOCUMENT_CATEGORY_LABEL_KEYS } from '../lib/document-category';
import { colors } from '../lib/ui-theme';
import { radii, spacing, touchTarget, typography } from '../lib/ui-system';

interface Props {
  visible: boolean;
  onSelect: (category: OtherDocumentCategory) => void;
  onCancel: () => void;
}

const OPTIONS: OtherDocumentCategory[] = [
  'delivery_document',
  'proforma_invoice',
  'generic_document',
  'generic_image',
];

export function OtherDocumentTypePicker({ visible, onSelect, onCancel }: Props) {
  const { t } = useTranslation();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityRole="button">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.title}>{t('otherDocumentPickerTitle')}</Text>
          <Text style={styles.message}>{t('otherDocumentPickerMessage')}</Text>
          <View style={styles.actions}>
            {OPTIONS.map((category) => (
              <Pressable
                key={category}
                style={({ pressed }) => [
                  styles.actionButton,
                  pressed && styles.actionButtonPressed,
                ]}
                onPress={() => onSelect(category)}
                accessibilityRole="button"
                accessibilityLabel={t(DOCUMENT_CATEGORY_LABEL_KEYS[category])}
              >
                <Text style={styles.actionButtonText}>
                  {t(DOCUMENT_CATEGORY_LABEL_KEYS[category])}
                </Text>
              </Pressable>
            ))}
            <Pressable
              style={({ pressed }) => [
                styles.cancelButton,
                pressed && styles.cancelButtonPressed,
              ]}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
            >
              <Text style={styles.cancelButtonText}>{t('cancel')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  title: {
    ...typography.heading3,
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  message: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  actions: {
    gap: spacing.sm,
  },
  actionButton: {
    minHeight: touchTarget.comfortable,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  actionButtonPressed: {
    opacity: 0.88,
  },
  actionButtonText: {
    ...typography.label,
    color: colors.textOnPrimary,
    textAlign: 'center',
  },
  cancelButton: {
    minHeight: touchTarget.minimum,
    borderRadius: radii.md,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  cancelButtonPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  cancelButtonText: {
    ...typography.label,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
