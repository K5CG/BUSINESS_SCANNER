export async function openDatabaseAsync(): Promise<never> {
  throw new Error('expo-sqlite non disponibile nel test dedup');
}
