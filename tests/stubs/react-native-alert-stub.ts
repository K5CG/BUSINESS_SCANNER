export interface StubAlertButton {
  text?: string;
  style?: string;
  onPress?: () => void;
}

export interface StubAlertOptions {
  cancelable?: boolean;
  onDismiss?: () => void;
}

export interface StubAlertCall {
  title: string;
  message?: string;
  buttons: StubAlertButton[];
  options?: StubAlertOptions;
}

let latestAlert: StubAlertCall | null = null;
let alertHistory: StubAlertCall[] = [];

export function resetAlertStub(): void {
  latestAlert = null;
  alertHistory = [];
}

export function getLatestAlert(): StubAlertCall {
  if (!latestAlert) throw new Error('Alert non registrato');
  return latestAlert;
}

export function getAlertHistory(): StubAlertCall[] {
  return [...alertHistory];
}

export const Alert = {
  alert(
    title: string,
    message?: string,
    buttons: StubAlertButton[] = [],
    options?: StubAlertOptions
  ): void {
    latestAlert = { title, message, buttons, options };
    alertHistory.push(latestAlert);
  },
};

export const Platform = {
  OS: 'android',
};
