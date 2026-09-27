import 'intl-pluralrules';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import it from './it.json';
import en from './en.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';
import { DEFAULT_LOCALE } from '../lib/locale-prefs';

i18n.use(initReactI18next).init({
  resources: {
    it: { translation: it },
    en: { translation: en },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: 'en',
  supportedLngs: ['it', 'en', 'fr', 'de', 'es'],
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
