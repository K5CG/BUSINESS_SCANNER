import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../lib/ui-theme';
import { getSafeModalHeight, getUiViewportLayout } from '../lib/ui-layout';
import { radii, spacing, typography } from '../lib/ui-system';
import { useModalAccessibilityFocus } from '../lib/use-modal-accessibility-focus';
import { getNativeUiPolicy } from '../lib/ui-native-policy';
import type {
  ContactFieldOrigin,
  ContactReparseFieldKey,
  ContactReparseProposal,
} from '../lib/contact-review-state';

interface Props {
  visible: boolean;
  proposal: ContactReparseProposal | null;
  onCancel: () => void;
  onApply: (fields: ContactReparseFieldKey[]) => void;
}

const FIELD_LABEL_KEYS: Record<ContactReparseFieldKey, string> = {
  firstName: 'firstName',
  lastName: 'lastName',
  company: 'company',
  role: 'role',
  emails: 'emailsFieldHint',
  phones: 'phonesFieldHint',
  website: 'website',
  address: 'address',
  vatNumber: 'vatNumber',
  taxCode: 'taxCode',
};

const ORIGIN_LABEL_KEYS: Record<ContactFieldOrigin, string> = {
  parser: 'contactFieldOriginParser',
  ocr: 'contactFieldOriginOcr',
  ai: 'contactFieldOriginAi',
  user: 'contactFieldOriginUser',
  reparse: 'contactFieldOriginReparse',
};

export function ContactReparseProposalModal({
  visible,
  proposal,
  onCancel,
  onApply,
}: Props) {
  const { t } = useTranslation();
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const responsive = getUiViewportLayout(width, fontScale);
  const panelMaxHeight = getSafeModalHeight(height, insets.top, insets.bottom);
  const selectableFields = useMemo(
    () =>
      proposal?.fields
        .filter((item) => !item.protectedByManualOverride)
        .map((item) => item.field) ?? [],
    [proposal]
  );
  const [selected, setSelected] = useState<Set<ContactReparseFieldKey>>(
    new Set()
  );
  const panelRef = useRef<View>(null);
  const nativeUi = getNativeUiPolicy(Platform.OS);
  useModalAccessibilityFocus(visible, panelRef);

  useEffect(() => {
    setSelected(new Set(selectableFields));
  }, [proposal?.baseFingerprint, selectableFields]);

  const toggle = (field: ContactReparseFieldKey) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={nativeUi.modalAnimation}
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View
          style={[
            styles.panel,
            {
              maxHeight: panelMaxHeight,
              paddingBottom: Math.max(insets.bottom, 16),
              paddingHorizontal: responsive.horizontalPadding,
            },
          ]}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <View ref={panelRef} accessible accessibilityRole="header">
            <Text style={styles.title}>{t('reparseProposalTitle')}</Text>
          </View>
          <Text style={styles.intro}>{t('reparseProposalMessage')}</Text>

          <ScrollView
            style={styles.list}
            bounces={nativeUi.scrollBounces}
            overScrollMode={nativeUi.androidOverScrollMode}
          >
            {proposal?.fields.map((item) => {
              const locked = item.protectedByManualOverride;
              const checked = !locked && selected.has(item.field);
              return (
                <TouchableOpacity
                  key={item.field}
                  style={[styles.row, locked && styles.rowLocked]}
                  onPress={() => {
                    if (!locked) toggle(item.field);
                  }}
                  disabled={locked}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked, disabled: locked }}
                  accessibilityLabel={t(FIELD_LABEL_KEYS[item.field])}
                >
                  <Ionicons
                    name={
                      locked
                        ? 'lock-closed'
                        : checked
                          ? 'checkbox'
                          : 'square-outline'
                    }
                    size={22}
                    color={locked ? colors.warning : colors.primary}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.fieldLabel}>
                      {t(FIELD_LABEL_KEYS[item.field])}
                    </Text>
                    <Text style={styles.origin}>
                      {t('reparseCurrentOrigin', {
                        origin: t(ORIGIN_LABEL_KEYS[item.currentOrigin]),
                      })}
                    </Text>
                    <Text style={styles.currentValue}>
                      {t('reparseCurrentValue', {
                        value: item.currentDisplay,
                      })}
                    </Text>
                    <Text style={styles.proposedValue}>
                      {t('reparseProposedValue', {
                        value: item.proposedDisplay,
                      })}
                    </Text>
                    {locked ? (
                      <Text style={styles.protected}>
                        {t('reparseManualProtected')}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={[styles.actions, responsive.stackActions && styles.actionsStacked]}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton, responsive.stackActions && styles.buttonStacked]}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
            >
              <Text style={styles.cancelText}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.button,
                styles.applyButton,
                responsive.stackActions && styles.buttonStacked,
                selected.size === 0 && styles.buttonDisabled,
              ]}
              onPress={() => onApply([...selected])}
              disabled={selected.size === 0}
              accessibilityRole="button"
              accessibilityLabel={t('reparseApplySelected')}
              accessibilityState={{ disabled: selected.size === 0 }}
            >
              <Text style={[styles.applyText, selected.size === 0 && styles.applyTextDisabled]}>
                {t('reparseApplySelected')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: colors.scrim,
  },
  panel: {
    width: '100%',
    maxWidth: 640,
    flexShrink: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: spacing.xl,
  },
  title: {
    ...typography.heading2,
    color: colors.textPrimary,
  },
  intro: {
    ...typography.bodySecondary,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    color: colors.textSecondary,
  },
  list: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLocked: {
    backgroundColor: colors.warningSurface,
  },
  rowBody: {
    flex: 1,
  },
  fieldLabel: {
    ...typography.label,
    color: colors.textPrimary,
  },
  origin: {
    marginTop: 2,
    color: colors.textSecondary,
    ...typography.caption,
  },
  currentValue: {
    ...typography.bodySecondary,
    marginTop: spacing.xs,
    color: colors.textSecondary,
  },
  proposedValue: {
    ...typography.bodySecondary,
    marginTop: spacing.xxs,
    color: colors.success,
    fontWeight: '600',
  },
  protected: {
    marginTop: 5,
    color: colors.warning,
    ...typography.caption,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  actionsStacked: {
    flexDirection: 'column',
  },
  button: {
    flex: 1,
    alignItems: 'center',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    minHeight: 48,
  },
  buttonStacked: {
    flex: 0,
    width: '100%',
  },
  cancelButton: {
    backgroundColor: colors.surfaceMuted,
  },
  applyButton: {
    backgroundColor: colors.primary,
  },
  buttonDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  cancelText: {
    ...typography.button,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  applyText: {
    ...typography.button,
    color: colors.textOnPrimary,
    fontWeight: '700',
  },
  applyTextDisabled: { color: colors.textDisabled },
});
