import React, { useCallback, useEffect, useRef } from 'react';
import { BackHandler, View, StyleSheet } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { CardScanner } from '../components/Camera/CardScanner';
import type { OperationInvalidationReason } from '../lib/guarded-operation';

export default function ScanLegacyScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const cancelCurrentRef = useRef<
    ((reason?: OperationInvalidationReason) => void) | null
  >(null);
  const exitRequestedRef = useRef(false);

  const registerCancellation = useCallback(
    (
      cancel: ((reason?: OperationInvalidationReason) => void) | null
    ) => {
      cancelCurrentRef.current = cancel;
    },
    []
  );

  const goBack = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    cancelCurrentRef.current?.('manual');
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/');
  }, [router]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        goBack();
        return true;
      }
    );
    return () => subscription.remove();
  }, [goBack]);

  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        exitRequestedRef.current = true;
        cancelCurrentRef.current?.('manual');
      }),
    [navigation]
  );

  return (
    <View style={styles.container}>
      <CardScanner registerCancellation={registerCancellation} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
