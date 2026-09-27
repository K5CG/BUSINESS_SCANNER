export interface AppBootstrapDependencies {
  initDatabase: () => Promise<void>;
  getSavedLocale: () => Promise<string>;
  changeLanguage: (locale: string) => Promise<unknown>;
  loadContacts: () => Promise<void>;
}

/**
 * Inizializzazione non distruttiva dell'app.
 *
 * Le dipendenze ammesse inizializzano o leggono dati: il reset manuale non fa
 * parte del contratto e non può quindi essere attivato dal bootstrap.
 */
export async function runAppBootstrap(
  dependencies: AppBootstrapDependencies,
  currentLanguage: string
): Promise<void> {
  await dependencies.initDatabase();

  const savedLocale = await dependencies.getSavedLocale();
  if (savedLocale !== currentLanguage) {
    await dependencies.changeLanguage(savedLocale);
  }

  await dependencies.loadContacts();
}
