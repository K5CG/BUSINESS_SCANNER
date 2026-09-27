import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { colors } from '../../lib/ui-theme';

/** Reindirizza al dettaglio documento unificato. */
export default function ContactRedirectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  useEffect(() => {
    if (id) router.replace(`/document/${id}`);
    else router.replace('/(tabs)/contacts');
  }, [id]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}
