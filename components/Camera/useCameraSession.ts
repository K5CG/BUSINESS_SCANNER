import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { runtimeLogger } from '../../lib/safe-runtime-logger';

const ACTIVATE_DELAY_MS = 120;
// onCameraReady segnala la surface pronta, non la sincronizzazione fra
// Preview e ImageCapture. Il primo JPEG richiede una breve stabilizzazione.
const CAPTURE_STABILIZATION_MS = 700;
const CAMERA_STUCK_MS = 12000;

function logCameraSession(event: string, diagnostic?: Record<string, unknown>) {
  runtimeLogger.debug('CAMERA_DIAGNOSTIC', undefined, { event, ...diagnostic });
}

/**
 * Android: smonta la CameraView quando la schermata perde focus, poi la rimonta
 * dopo una breve pausa (evita anteprima nera al ritorno / cambio schermata).
 *
 * activationKey identifica una singola acquisizione documento. Quando cambia,
 * il lifecycle della CameraView viene resettato anche se Expo Router riutilizza
 * la stessa schermata dinamica.
 */
export function useCameraSession(activationKey?: string) {
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraCaptureReady, setCameraCaptureReady] = useState(false);
  const [cameraSession, setCameraSession] = useState(0);
  const [cameraMountError, setCameraMountError] = useState<string | null>(null);
  const [cameraStuck, setCameraStuck] = useState(false);

  useFocusEffect(
    useCallback(() => {
      logCameraSession('focus_reset', {
        activationKey: activationKey ?? 'legacy',
      });

      setCameraActive(false);
      setCameraReady(false);
      setCameraCaptureReady(false);
      setCameraMountError(null);
      setCameraStuck(false);

      const activateTimer = setTimeout(() => {
        logCameraSession('activate', {
          activationKey: activationKey ?? 'legacy',
        });
        setCameraSession((session) => session + 1);
        setCameraActive(true);
      }, ACTIVATE_DELAY_MS);

      return () => {
        clearTimeout(activateTimer);
        logCameraSession('cleanup', {
          activationKey: activationKey ?? 'legacy',
        });
        setCameraActive(false);
        setCameraReady(false);
        setCameraCaptureReady(false);
        setCameraStuck(false);
      };
    }, [activationKey])
  );

  useEffect(() => {
    if (!cameraActive || cameraReady || cameraMountError) {
      setCameraStuck(false);
      return;
    }

    const timer = setTimeout(() => {
      logCameraSession('stuck', {
        activationKey: activationKey ?? 'legacy',
        cameraSession,
      });
      setCameraStuck(true);
    }, CAMERA_STUCK_MS);

    return () => clearTimeout(timer);
  }, [
    activationKey,
    cameraActive,
    cameraReady,
    cameraMountError,
    cameraSession,
  ]);

  const onCameraReady = useCallback(() => {
    logCameraSession('ready', {
      activationKey: activationKey ?? 'legacy',
    });
    setCameraReady(true);
    setCameraCaptureReady(false);
    setCameraMountError(null);
    setCameraStuck(false);
  }, [activationKey]);

  useEffect(() => {
    if (!cameraReady || !cameraActive || cameraMountError) {
      setCameraCaptureReady(false);
      return;
    }
    setCameraCaptureReady(false);
    const timer = setTimeout(() => setCameraCaptureReady(true), CAPTURE_STABILIZATION_MS);
    return () => clearTimeout(timer);
  }, [cameraActive, cameraMountError, cameraReady, cameraSession]);

  const onMountError = useCallback(
    (message: string) => {
      logCameraSession('mount_error', {
        activationKey: activationKey ?? 'legacy',
        message,
      });
      setCameraReady(false);
      setCameraMountError(message);
      setCameraStuck(false);
    },
    [activationKey]
  );

  const remountCamera = useCallback(() => {
    logCameraSession('manual_remount', {
      activationKey: activationKey ?? 'legacy',
    });
    setCameraReady(false);
    setCameraCaptureReady(false);
    setCameraMountError(null);
    setCameraStuck(false);
    setCameraSession((session) => session + 1);
    setCameraActive(true);
  }, [activationKey]);

  const cameraStarting = cameraActive && !cameraReady && !cameraMountError;

  return {
    cameraActive,
    cameraReady,
    cameraCaptureReady,
    cameraSession,
    cameraMountError,
    cameraStarting,
    cameraStuck,
    onCameraReady,
    onMountError,
    remountCamera,
    setCameraReady,
  };
}
