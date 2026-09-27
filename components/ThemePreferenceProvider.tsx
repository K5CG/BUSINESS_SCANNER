import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Appearance, type ColorSchemeName } from 'react-native';
import {
  DEFAULT_THEME_PREFERENCE,
  getSavedThemePreference,
  saveThemePreference,
  type ThemePreference,
} from '../lib/theme-prefs';

interface ThemePreferenceContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => Promise<void>;
}

const ThemePreferenceContext = createContext<ThemePreferenceContextValue | null>(null);

function colorSchemeForPreference(preference: ThemePreference): ColorSchemeName {
  return preference === 'system' ? null : preference;
}

function applyThemePreference(preference: ThemePreference): void {
  Appearance.setColorScheme(colorSchemeForPreference(preference));
}

export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const userSelected = useRef(false);

  useEffect(() => {
    let active = true;
    void getSavedThemePreference().then((savedPreference) => {
      if (!active || userSelected.current) return;
      setPreferenceState(savedPreference);
      applyThemePreference(savedPreference);
    });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback(async (nextPreference: ThemePreference) => {
    userSelected.current = true;
    setPreferenceState(nextPreference);
    applyThemePreference(nextPreference);
    await saveThemePreference(nextPreference);
  }, []);

  return (
    <ThemePreferenceContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemePreferenceContext.Provider>
  );
}

export function useThemePreference(): ThemePreferenceContextValue {
  const context = useContext(ThemePreferenceContext);
  if (!context) throw new Error('useThemePreference must be used within ThemePreferenceProvider');
  return context;
}
