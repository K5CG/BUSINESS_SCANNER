// Carica variabili da .env in build (EXPO_PUBLIC_*)
// Build TEST (package/bundle separati): APP_VARIANT=test npx expo prebuild --platform android
const appJson = require('./app.json');

/** Canonical store identity. Do not invent a second production id. */
const CANONICAL_APP_ID = 'com.mybizscanner.ai';

const IS_TEST_BUILD =
  process.env.APP_VARIANT === 'test' || process.env.EXPO_PUBLIC_APP_VARIANT === 'test';

const production = appJson.expo;
const productionAndroidPackage = production.android?.package;
const productionIosBundle = production.ios?.bundleIdentifier;

if (productionAndroidPackage !== CANONICAL_APP_ID) {
  throw new Error(
    `android.package must be ${CANONICAL_APP_ID} (got ${String(productionAndroidPackage)})`,
  );
}
if (productionIosBundle !== CANONICAL_APP_ID) {
  throw new Error(
    `ios.bundleIdentifier must be ${CANONICAL_APP_ID} (got ${String(productionIosBundle)})`,
  );
}

const testAndroidPackage = `${CANONICAL_APP_ID}.test`;
const testIosBundle = `${CANONICAL_APP_ID}.test`;

module.exports = () => ({
  expo: {
    ...production,
    name: IS_TEST_BUILD ? 'Business Scanner TEST' : production.name,
    ios: {
      ...production.ios,
      bundleIdentifier: IS_TEST_BUILD ? testIosBundle : CANONICAL_APP_ID,
    },
    android: {
      ...production.android,
      package: IS_TEST_BUILD ? testAndroidPackage : CANONICAL_APP_ID,
    },
    extra: {
      appVariant: IS_TEST_BUILD ? 'test' : 'production',
      canonicalAppId: CANONICAL_APP_ID,
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
      privacyPolicyUrl: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL ?? '',
    },
  },
});

