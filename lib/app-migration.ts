import * as FileSystem from 'expo-file-system/legacy';
import { getDb } from './storage';

/**
 * Reset manuale distruttivo. Non deve essere richiamato dal bootstrap:
 * il chiamante deve eseguirlo solo dopo una conferma esplicita dell'utente.
 */
export async function clearAllAppData(): Promise<void> {
  const database = await getDb();
  await database.execAsync('DELETE FROM documents');
  await database.execAsync('DELETE FROM contacts');

  const root = FileSystem.documentDirectory;
  if (root) {
    await FileSystem.deleteAsync(`${root}scans`, { idempotent: true });
  }
}
