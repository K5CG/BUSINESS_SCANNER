import Constants from 'expo-constants';

export function getSupabaseUrl(): string | undefined {
  const fromEnv = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const fromExtra = (
    Constants.expoConfig?.extra as { supabaseUrl?: string } | undefined
  )?.supabaseUrl?.trim();
  return fromEnv || fromExtra || undefined;
}

export function getSupabaseAnonKey(): string | undefined {
  const fromEnv = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const fromExtra = (
    Constants.expoConfig?.extra as { supabaseAnonKey?: string } | undefined
  )?.supabaseAnonKey?.trim();
  return fromEnv || fromExtra || undefined;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseAnonKey());
}

/** @deprecated Usa isSupabaseConfigured */
export function isSupabasePdfConfigured(): boolean {
  return isSupabaseConfigured();
}

export function isDocumentOcrConfigured(): boolean {
  return isSupabaseConfigured();
}
