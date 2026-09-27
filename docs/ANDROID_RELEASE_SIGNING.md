# Android release signing

**Date:** 2026-08-12  
**Status:** `RELEASE_SIGNING_CONFIG_READY` / `PRODUCTION_KEYSTORE_REQUIRED`

The Expo/React Native `android/` tree is gitignored in this repo. Apply the
signing block below to the local `android/app/build.gradle` (already applied on
developer machines that ran the 2026-08-12 hardening task). Do **not** commit
keystores or passwords.

## Goal

- Debug builds keep `debug.keystore`
- Release builds **never** fall back to the debug keystore
- Credentials come from environment variables or an uncommitted `android/keystore.properties`
- No production keystore is invented by tooling

## Environment variables

| Variable | Meaning |
| --- | --- |
| `BUSINESS_SCANNER_UPLOAD_STORE_FILE` | Absolute or project-relative path to `.jks` / `.keystore` |
| `BUSINESS_SCANNER_UPLOAD_STORE_PASSWORD` | Keystore password |
| `BUSINESS_SCANNER_UPLOAD_KEY_ALIAS` | Key alias |
| `BUSINESS_SCANNER_UPLOAD_KEY_PASSWORD` | Key password |

## Optional `android/keystore.properties` (gitignored)

```properties
storeFile=C:/secure/business-scanner-upload.jks
storePassword=***
keyAlias=upload
keyPassword=***
```

## Gradle signing snippet (`android/app/build.gradle`)

Replace the previous `signingConfigs` / `buildTypes` block that used
`signingConfig signingConfigs.debug` for release with:

```gradle
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            def keystorePropertiesFile = rootProject.file('keystore.properties')
            def keystoreProperties = new Properties()
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
            }
            def storeFilePath = System.getenv('BUSINESS_SCANNER_UPLOAD_STORE_FILE')
                    ?: keystoreProperties['storeFile']
            def storePasswordValue = System.getenv('BUSINESS_SCANNER_UPLOAD_STORE_PASSWORD')
                    ?: keystoreProperties['storePassword']
            def keyAliasValue = System.getenv('BUSINESS_SCANNER_UPLOAD_KEY_ALIAS')
                    ?: keystoreProperties['keyAlias']
            def keyPasswordValue = System.getenv('BUSINESS_SCANNER_UPLOAD_KEY_PASSWORD')
                    ?: keystoreProperties['keyPassword']
            if (storeFilePath && storePasswordValue && keyAliasValue && keyPasswordValue) {
                storeFile file(storeFilePath)
                storePassword storePasswordValue
                keyAlias keyAliasValue
                keyPassword keyPasswordValue
            }
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            if (signingConfigs.release.storeFile != null) {
                signingConfig signingConfigs.release
            } else {
                println(
                    "[BusinessScanner] RELEASE signing credentials missing — " +
                    "release will not be Play-upload signed. See docs/ANDROID_RELEASE_SIGNING.md"
                )
            }
            // minify / shrink / crunch settings unchanged
        }
    }
```

## Build artifacts

| Artifact | Command (from repo root) | Typical output |
| --- | --- | --- |
| Debug APK | `cd android && .\\gradlew.bat assembleDebug` | `android/app/build/outputs/apk/debug/` |
| Release APK | `npm run build:android:release` or `assembleRelease` | `android/app/build/outputs/apk/release/` |
| Release AAB (Play) | `cd android && .\\gradlew.bat bundleRelease` | `android/app/build/outputs/bundle/release/` |

Play Console expects a **signed AAB**. Without production keystore credentials,
`bundleRelease` / `assembleRelease` must not be treated as upload-ready.

## Operator checklist

1. Generate upload keystore offline (once); store outside git
2. Create `android/keystore.properties` or set env vars
3. Confirm `android/app/build.gradle` has the release signingConfig above
4. `bundleRelease` and verify signing certificate is the upload key (not debug)
5. Upload AAB to Play — **not** done in this hardening task

## Safety

- `.gitignore` includes `*.jks`, `*.keystore`, `keystore.properties`, `.env*`
- Debug keystore for local QA is preserved
- Do not rotate or invent production keys in CI without operator approval
