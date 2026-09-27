import { useKeepAwake } from 'expo-keep-awake';

/** Extra keep-awake layer while the export overlay is mounted. */
export function ExportKeepAwake() {
  useKeepAwake('export-overlay');
  return null;
}
