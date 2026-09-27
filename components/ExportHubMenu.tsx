import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type View as ViewType,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../lib/ui-theme';
import { radii, spacing, touchTarget, typography } from '../lib/ui-system';

export const EXPORT_HUB_ICONS = {
  header: 'share-outline',
  xlsx: 'grid-outline',
  csv: 'document-text-outline',
  pdf: 'document-outline',
  diagnostic: 'construct-outline',
} as const satisfies Record<string, keyof typeof Ionicons.glyphMap>;

export type ExportHubIconName = keyof typeof Ionicons.glyphMap;

export interface ExportHubAction {
  key: string;
  label: string;
  icon: ExportHubIconName;
  onPress: () => void;
  accessibilityLabel?: string;
  variant?: 'primary' | 'support';
}

export interface ExportHubSection {
  key: string;
  title: string;
  actions: ExportHubAction[];
}

export function ExportHubMenu({
  visible,
  title,
  titleRef,
  sections,
  cancelLabel,
  onClose,
}: {
  visible: boolean;
  title: string;
  titleRef?: React.RefObject<ViewType | null>;
  sections: ExportHubSection[];
  cancelLabel: string;
  onClose: () => void;
}) {
  const visibleSections = sections.filter((section) => section.actions.length > 0);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} accessible={false} />
        <View style={styles.card} accessibilityViewIsModal importantForAccessibility="yes">
          <View ref={titleRef} accessible accessibilityRole="header">
            <Text style={styles.title}>{title}</Text>
          </View>
          {visibleSections.map((section, index) => (
            <View key={section.key} style={index > 0 ? styles.sectionAfter : undefined}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.actions.map((action) => {
                const support = action.variant === 'support';
                return (
                  <TouchableOpacity
                    key={action.key}
                    style={[styles.option, support && styles.supportOption]}
                    onPress={action.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={action.accessibilityLabel ?? action.label}
                  >
                    <Ionicons
                      name={action.icon}
                      size={20}
                      color={support ? colors.textSecondary : colors.primary}
                      accessible={false}
                    />
                    <Text
                      style={[styles.optionText, support && styles.supportOptionText]}
                      numberOfLines={support ? 2 : 1}
                    >
                      {action.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
          <TouchableOpacity
            style={styles.cancel}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
          >
            <Text style={styles.cancelText}>{cancelLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  backdrop: { ...StyleSheet.absoluteFillObject },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 340,
  },
  title: {
    ...typography.heading3,
    color: colors.textPrimary,
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
  sectionAfter: { marginTop: spacing.sm },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 8,
  },
  option: {
    minHeight: touchTarget.minimum,
    backgroundColor: colors.infoSurface,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  supportOption: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingVertical: 10,
    marginBottom: 4,
    minHeight: touchTarget.minimum,
  },
  optionText: {
    ...typography.body,
    fontWeight: '600',
    color: colors.primary,
    flex: 1,
  },
  supportOptionText: {
    ...typography.body,
    color: colors.textSecondary,
    fontWeight: '400',
  },
  cancel: {
    minHeight: touchTarget.minimum,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  cancelText: { ...typography.body, color: colors.textSecondary },
});
