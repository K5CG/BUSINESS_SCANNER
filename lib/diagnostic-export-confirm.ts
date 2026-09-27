import { Alert } from 'react-native';

export function confirmDiagnosticExport(labels: {
  title: string;
  message: string;
  cancel: string;
  continue: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(
      labels.title,
      labels.message,
      [
        { text: labels.cancel, style: 'cancel', onPress: () => finish(false) },
        { text: labels.continue, onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) }
    );
  });
}
