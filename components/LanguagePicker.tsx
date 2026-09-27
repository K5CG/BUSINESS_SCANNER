import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../lib/ui-theme';
import { saveLocale, type AppLocale } from '../lib/locale-prefs';
import { useModalAccessibilityFocus } from '../lib/use-modal-accessibility-focus';
import { typography } from '../lib/ui-system';

const LANGUAGES: { code: AppLocale; flag: string; label: string }[] = [
  { code: 'it', flag: '🇮🇹', label: 'Italiano' },
  { code: 'en', flag: '🇬🇧', label: 'English' },
];

function isLocaleActive(current: string | undefined, code: AppLocale): boolean {
  return current === code || (current?.startsWith(code) ?? false);
}

export function LanguagePicker() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<View>(null);
  useModalAccessibilityFocus(open, menuRef);

  const active =
    LANGUAGES.find((lang) => isLocaleActive(i18n.language, lang.code)) ?? LANGUAGES[0];

  const select = async (code: AppLocale) => {
    await i18n.changeLanguage(code);
    await saveLocale(code);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity
        style={styles.trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('languagePickerAccessibility')}
      >
        <Text style={styles.flag}>{active.flag}</Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessible={false} />
          <View
            style={[styles.menu, { top: insets.top + 36, right: 20 }]}
            accessibilityViewIsModal
            importantForAccessibility="yes"
          >
            {LANGUAGES.map((lang) => {
              const selected = isLocaleActive(i18n.language, lang.code);
              return (
                <TouchableOpacity
                  ref={selected ? menuRef : undefined}
                  key={lang.code}
                  style={[styles.option, selected && styles.optionSelected]}
                  onPress={() => select(lang.code)}
                  accessibilityRole="radio"
                  accessibilityLabel={lang.label}
                  accessibilityState={{ selected }}
                >
                  <Text style={styles.optionFlag}>{lang.flag}</Text>
                  <Text style={styles.optionLabel}>{lang.label}</Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
    gap: 2,
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
  },
  flag: {
    fontSize: 11,
    lineHeight: 13,
  },
  chevron: {
    fontSize: 6,
    color: colors.textPrimary,
    marginTop: 1,
  },
  modalRoot: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scrim,
  },
  menu: {
    position: 'absolute',
    minWidth: 84,
    backgroundColor: colors.surface,
    borderRadius: 6,
    paddingVertical: 3,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 6,
    minHeight: 44,
  },
  optionSelected: {
    backgroundColor: colors.infoSurface,
  },
  optionFlag: {
    fontSize: 10,
    marginRight: 5,
  },
  optionLabel: {
    flex: 1,
    ...typography.caption,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  check: {
    fontSize: 8,
    color: colors.primary,
    fontWeight: '700',
  },
});
