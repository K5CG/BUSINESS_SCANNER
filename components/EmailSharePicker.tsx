import React, { useRef } from 'react';
import {
  Modal,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmailShareMode } from '../lib/share-document';
import { colors } from '../lib/ui-theme';
import { getSafeModalHeight, getUiViewportLayout } from '../lib/ui-layout';
import { radii, spacing, typography } from '../lib/ui-system';
import { useModalAccessibilityFocus } from '../lib/use-modal-accessibility-focus';
import { getNativeUiPolicy } from '../lib/ui-native-policy';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (mode: EmailShareMode) => void;
}

export function EmailSharePicker({ visible, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const responsive = getUiViewportLayout(width, fontScale);
  const sheetMaxHeight = getSafeModalHeight(height, insets.top, insets.bottom);
  const sheetRef = useRef<View>(null);
  const nativeUi = getNativeUiPolicy(Platform.OS);
  useModalAccessibilityFocus(visible, sheetRef);

  const options: { mode: EmailShareMode; label: string }[] = [
    { mode: 'text', label: t('emailShareTextOnly') },
    { mode: 'photos', label: t('emailSharePhotosOnly') },
    { mode: 'both', label: t('emailShareBoth') },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType={nativeUi.modalAnimation}
      onRequestClose={onClose}
    >
      <Pressable
        style={[
          styles.backdrop,
          {
            paddingHorizontal: responsive.modalHorizontalPadding,
            paddingTop: Math.max(insets.top, 12),
            paddingBottom: Math.max(insets.bottom, 12),
            justifyContent: nativeUi.actionSheetAlignment,
          },
        ]}
        onPress={onClose}
        accessible={false}
      >
        <Pressable
          style={[styles.sheet, { maxHeight: sheetMaxHeight }]}
          onPress={(event) => event.stopPropagation()}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <ScrollView showsVerticalScrollIndicator contentContainerStyle={styles.sheetContent}>
            <View ref={sheetRef} accessible accessibilityRole="header">
              <Text style={styles.title}>{t('emailSharePrompt')}</Text>
            </View>
            {options.map((opt) => (
              <TouchableOpacity
                key={opt.mode}
                style={styles.option}
                onPress={() => {
                  onSelect(opt.mode);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={opt.label}
              >
                <Text style={styles.optionText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.option, styles.cancelOption]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
            >
              <Text style={styles.cancelText}>{t('cancel')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    overflow: 'hidden',
    width: '100%',
    maxWidth: 500,
    alignSelf: 'center',
  },
  sheetContent: { flexGrow: 0 },
  title: {
    ...typography.heading3,
    padding: spacing.xl,
    paddingBottom: spacing.md,
    color: colors.textPrimary,
  },
  option: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  optionText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  cancelOption: {
    backgroundColor: colors.surfaceMuted,
  },
  cancelText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
