import React from 'react';
import { useTranslation } from 'react-i18next';
import { EditableField } from './EditableField';

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  editable?: boolean;
}

export function DocumentNotesField({
  value,
  onChangeText,
  onFocus,
  editable = true,
}: Props) {
  const { t } = useTranslation();

  return (
    <EditableField
      label={t('notes')}
      value={value}
      onChangeText={onChangeText}
      onFocus={onFocus}
      multiline
      editable={editable}
    />
  );
}
