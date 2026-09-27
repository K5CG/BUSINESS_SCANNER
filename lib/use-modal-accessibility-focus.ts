import { useEffect, type RefObject } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  InteractionManager,
  type View,
} from 'react-native';

/** Moves screen-reader focus into a modal after its entrance animation settles. */
export function useModalAccessibilityFocus(
  visible: boolean,
  modalRef: RefObject<View | null>,
  focusKey?: unknown
): void {
  useEffect(() => {
    if (!visible) return;

    const task = InteractionManager.runAfterInteractions(() => {
      const node = findNodeHandle(modalRef.current);
      if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
    });

    return () => task.cancel();
  }, [focusKey, modalRef, visible]);
}
