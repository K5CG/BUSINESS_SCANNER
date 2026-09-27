import type { CameraViewProps } from 'expo-camera';

declare module 'expo-camera' {
  interface CameraViewProps {
    /** Patch v4 — evento AF nativo Android (CameraX). */
    onAutofocusStateChanged?: (event: { nativeEvent: Record<string, unknown> }) => void;
  }

  namespace CameraView {
    function getAvailablePictureSizesAsync(): Promise<string[]>;
  }
}

export type PatchedCameraViewProps = CameraViewProps;
