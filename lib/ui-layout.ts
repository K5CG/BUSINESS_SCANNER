export interface UiViewportLayout {
  horizontalPadding: number;
  modalHorizontalPadding: number;
  stackActions: boolean;
  compactHeaderActions: boolean;
}

export function getUiViewportLayout(width: number, fontScale: number): UiViewportLayout {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeFontScale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;

  return {
    horizontalPadding: safeWidth <= 320 ? 12 : safeWidth >= 430 ? 20 : 16,
    modalHorizontalPadding: safeWidth <= 360 ? 12 : 20,
    stackActions: safeWidth <= 360 || safeFontScale >= 1.5,
    compactHeaderActions: safeWidth < 390 || safeFontScale >= 1.3,
  };
}

export function getSafeModalHeight(
  height: number,
  topInset: number,
  bottomInset: number
): number {
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const occupied = Math.max(0, topInset) + Math.max(0, bottomInset) + 24;
  return Math.max(0, safeHeight - occupied);
}

export function getScrollableBottomPadding(
  measuredFooterHeight: number,
  keyboardInset: number
): number {
  const footerHeight = Number.isFinite(measuredFooterHeight)
    ? Math.max(0, measuredFooterHeight)
    : 0;
  const keyboardPadding =
    Number.isFinite(keyboardInset) && keyboardInset > 0 ? keyboardInset + 56 : 0;
  return footerHeight + keyboardPadding + 32;
}
