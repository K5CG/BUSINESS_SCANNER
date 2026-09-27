import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../lib/ui-theme';
import { useTranslation } from 'react-i18next';
import { resolveImageUri } from '../lib/image-uri';
import { spacing, typography } from '../lib/ui-system';

interface Props {
  photoUri?: string;
  onChange: (photoUri: string | undefined) => void;
  editable?: boolean;
}

export function ContactPhotoSection({ photoUri, onChange, editable = true }: Props) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  const removePhoto = () => {
    Alert.alert(t('contactPhotoRemoveTitle'), t('contactPhotoRemoveMessage'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete'),
        style: 'destructive',
        onPress: () => onChange(undefined),
      },
    ]);
  };

  if (!photoUri) return null;

  const resolved = resolveImageUri(photoUri);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{t('contactPhotoLabel')}</Text>
      <View style={styles.row}>
        {failed ? (
          <View style={[styles.avatar, styles.placeholder]}>
            <Ionicons name="person-outline" size={40} color={colors.textDisabled} />
          </View>
        ) : (
          <Image
            source={{ uri: resolved }}
            style={styles.avatar}
            onError={() => setFailed(true)}
          />
        )}
        {editable ? (
          <TouchableOpacity
            style={styles.removeBtn}
            onPress={removePhoto}
            accessibilityRole="button"
            accessibilityLabel={t('contactPhotoRemove')}
          >
            <Text style={styles.removeText}>{t('contactPhotoRemove')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.hint}>{t('contactPhotoHint')}</Text>
    </View>
  );
}

export function ContactPhotoAvatar({
  photoUri,
  size = 44,
}: {
  photoUri?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!photoUri || failed) {
    return (
      <View style={[styles.listAvatar, styles.listPlaceholder, { width: size, height: size, borderRadius: size / 2 }]}>
        <Ionicons name="person" size={size * 0.45} color={colors.textDisabled} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri: resolveImageUri(photoUri) }}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceMuted }}
      onError={() => setFailed(true)}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 20 },
  label: { ...typography.label, color: colors.textSecondary, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.surfaceMuted,
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  removeText: { ...typography.button, color: colors.danger },
  hint: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  listAvatar: { backgroundColor: colors.surfaceMuted },
  listPlaceholder: { justifyContent: 'center', alignItems: 'center' },
});
