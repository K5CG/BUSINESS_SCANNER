export interface NativeUiPolicy {
  stackAnimation: 'default' | 'fade_from_bottom';
  stackGesturesEnabled: boolean;
  fullScreenBackGesture: boolean;
  modalAnimation: 'fade' | 'slide';
  actionSheetAlignment: 'center' | 'flex-end';
  scrollBounces: boolean;
  androidOverScrollMode: 'auto' | 'never';
}

export function getNativeUiPolicy(platform: string): NativeUiPolicy {
  if (platform === 'ios') {
    return {
      stackAnimation: 'default',
      stackGesturesEnabled: true,
      fullScreenBackGesture: true,
      modalAnimation: 'slide',
      actionSheetAlignment: 'flex-end',
      scrollBounces: true,
      androidOverScrollMode: 'auto',
    };
  }

  return {
    stackAnimation: 'fade_from_bottom',
    stackGesturesEnabled: false,
    fullScreenBackGesture: false,
    modalAnimation: 'fade',
    actionSheetAlignment: 'center',
    scrollBounces: false,
    androidOverScrollMode: 'never',
  };
}
