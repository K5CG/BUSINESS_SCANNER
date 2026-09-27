# Business Scanner AI — Project History and Durable Decisions

**Consolidated:** 3 September 2026  
**Purpose:** preserve only durable technical/product decisions extracted from the historical Markdown archive.  
**Status note:** historical test results, old defects, intermediate parser percentages, old APK names, temporary release blockers and superseded implementation plans are intentionally not carried forward as current truth.

The live operational status remains in `MASTER_STATUS.md`.

---

## 1. Why this file exists

The project evolved through many successive parser, camera, document, privacy, licensing and release-hardening phases.

The old `docs\archive\*.md` files were useful while those phases were active, but most of their:
- bug lists;
- pass/fail matrices;
- intermediate metrics;
- implementation plans;
- temporary recommendations;
- APK references;
- phase-specific instructions

are now superseded by later code and tests.

This document keeps only decisions that are still useful for understanding or maintaining the current project.

---

## 2. Core architecture decisions

### Local-first capture and OCR
- Business-card OCR is designed to run on-device with ML Kit.
- Local OCR and local parsing remain the default path for business cards.
- Cloud AI is optional and must remain an explicit user action.
- Local OCR/parser paths must not silently become Gemini-dependent.

### Documents
- Document capture, OCR, structural extraction, mathematical validation, review and persistence are separate concerns.
- Multi-page documents must preserve page provenance and page order.
- Missing fields remain missing; they must not be converted to invented zeros.
- Printed/raw values must not be silently overwritten merely to make arithmetic reconcile.
- Arithmetic inconsistencies are review signals.

### Generic fixes only
Production logic must never be patched for:
- company names;
- fixture names;
- specific document numbers;
- specific monetary values;
- individual real-world examples.

Acceptable fixes are generalizable through:
- semantic header roles;
- geometry;
- row ownership;
- confidence/evidence;
- OCR normalization;
- arithmetic consistency;
- provenance;
- language/general document structure.

---

## 3. Business-card parser contract

The parser architecture evolved from older V4/V5 and legacy implementations toward the modular parser engine.

The important durable rule is the **public API contract**. Existing consumers must continue to be able to use:

- `parseCardFromPages`
- `parseCard`
- `buildCardTitle`
- `mergeAiCardFields`
- `cardNeedsAiHelp`
- `reconcileEmailsWithCardContext`
- `normalizeAddress`

Relevant public types include:
- `CardPage`
- `CardFields`
- `AiCardFields`

The modular parser design separates:
- normalization;
- extractors;
- validators;
- scoring;
- resolution/reconciliation;
- page merge;
- AI merge.

Historical shim/legacy migration plans are no longer authoritative by themselves; the current codebase and current tests are the source of truth.

### Parser quality principle
A green synthetic test suite is not sufficient by itself. Real-device/business-card corpus evidence remains necessary.

### September 2026 parser closure
On 3 September 2026, the current parser-v5 regression dataset reached **118/118 PASS**. This is a regression-closure milestone, not a claim of universal 100% recognition accuracy. Broader real-world/holdout evidence remains necessary for reliability claims.

The closing fixes preserved the durable generic-rule policy: production logic must not contain company-name, person-name, fixture-specific or value-specific exceptions.

---

## 4. Camera / capture decisions

Historical camera work established these durable principles:

- capture geometry must match what the user sees;
- OCR input and persisted image provenance must be explicit;
- orientation must be derived generically from reliable evidence, never by document-specific rotation rules;
- unstable post-shutter orientation listeners/rotations are not acceptable;
- crop/full-frame decisions must remain deterministic and auditable;
- sharpness diagnostics are development/QA mechanisms, not reasons to invent data.

Current camera/document acceptance status belongs in `MASTER_STATUS.md`, not in this historical summary.

---

## 5. Privacy and consent

Durable product principles:

- privacy starts on the device;
- first-launch consent is required;
- the app presents a concise notice and links to the complete privacy information;
- consent versioning must be identifiable;
- changing the privacy version must be capable of requiring re-consent;
- privacy/consent audit evidence must not include user document/card content unnecessarily;
- user content must not be logged in production diagnostics;
- app/legal privacy files are authoritative over old audit notes.

Keep the active legal files outside the archive:
- `legal\PRIVACY_POLICY_GDPR.md`
- `legal\PRIVACY_POLICY_GDPR_EN.md`
- `legal\TESTO_PRIVACY_PRIMA_PAGINA_APP.md`

A permanent privacy entry in the app UI may remain a product task if not already implemented in the current code.

---

## 6. Gemini / AI architecture

Historical audits converged on these durable rules:

- Gemini calls are server-side, not directly from the mobile client.
- The mobile client must not contain the Gemini API key.
- Supported model selection is server-controlled.
- AI failure must fail visibly or fall back to reviewable local OCR; it must not silently invent success.
- AI is optional for user content.
- Commercial AI operations must remain credit-gated when that commercial model is enabled.
- Local OCR and local parser operations do not consume Gemini.

Historical model names, exact prices, quotas and temporary RC flags may change and must not be treated as permanent facts merely because they appear in old documents.

### September 2026 unified AI regression
On 3 September 2026, unified AI support QA passed for the covered automated scope: AI support contract **6/6 PASS**, document AI review **8/8 PASS**, production TypeScript PASS, final generic P0 regression PASS, and AI-credit synchronization PASS for both business-card and document AI flows.

---

## 7. AI credits and commercial accounting

Important durable distinction:

**Gemini technical cost is not the same thing as a Business Scanner commercial credit.**

Technical cost depends on provider token/image/PDF pricing.  
A Business Scanner credit is an internal commercial unit.

Historical implementation work introduced a durable credit/ledger concept:
- operations have an operation type;
- reservations/commits/releases are idempotent;
- server-side logic owns commercial credit mutation;
- the client must never self-grant credits;
- production must fail closed if the durable commercial ledger is unavailable;
- store transactions, when implemented, must be verified server-side before granting entitlement or credits.

Do not use old historical numbers as current commercial policy without checking current code/configuration.

---

## 8. Licensing / trial durable decisions

Historical work established:

- manual license activation may remain useful for QA/B2B/internal flows;
- manual license keys are not a substitute for the final consumer App Store / Play Store purchase path;
- entitlement decisions belong server-side;
- reinstall protection cannot be made fully durable/privacy-safe from a purely local installation identifier;
- final consumer reinstall/restore should rely on Store/account entitlement rather than invasive device fingerprinting;
- offline/local grace must never imply free cloud AI.

Historical trial duration and credit amounts must be checked against current configuration before being quoted.

---

## 9. Cross-platform purchase architecture

Future consumer purchasing should use a shared abstraction rather than Google-only or Apple-only logic inside shared screens.

Conceptually:
- Android → Google Play Billing;
- iOS → Apple StoreKit / In-App Purchase;
- server verifies purchase/transaction;
- server maps product to entitlement/credit pack;
- server grants idempotently;
- restore purchases must be supported;
- refunds/revocations must be handled;
- client never self-grants paid credits.

This design was documented historically but should be considered a specification until verified in current code.

---

## 10. Supabase / backend security principles

Durable principles from security/release audits:

- privileged commercial tables must not be directly writable by anonymous client access;
- credit/license changes go through controlled Edge/RPC paths;
- sensitive secrets must not be shipped in the app;
- production logs must not expose document/card content, license secrets, private keys or provider secrets;
- rate limiting/idempotency/fail-closed behavior are expected on AI/commercial endpoints;
- security state must be verified against current migrations and deployed Edge functions before release.

---

## 11. Android release signing

Historical release hardening identified an important requirement:

- debug signing is acceptable only for debug/QA builds;
- Play Store release artifacts require a production/upload keystore;
- release configuration must not silently fall back to the debug keystore;
- production keystore material must remain outside source control;
- release signing instructions belong in the active `docs\ANDROID_RELEASE_SIGNING.md`.

Old audit statements about whether the keystore/AAB existed at a particular date are historical only.

---

## 12. iOS handoff

The historical archive contains design/audit context, but the active iOS documentation should remain in the live docs directory.

Keep:
- `docs\INVIO-SVILUPPATORE-IOS.md`
- `docs\IOS_DEVELOPER_HANDOFF.md`
- `docs\SUPABASE-IOS-DEVELOPER.md`

Current iOS readiness must be determined from current code and these active handoff files, not old archived status documents.

---

## 13. Release-quality principles worth preserving

Across the old QA/release documents, several rules remain valuable:

1. A subsystem marked closed should not be reopened without new reproducible evidence.
2. Real-device evidence outranks synthetic assumptions for camera/OCR behavior.
3. Do not silently “repair” uncertain extracted values.
4. Production logging must be sanitized.
5. Client-side secrets and self-granted commercial state are forbidden.
6. Release signing and store purchasing are separate concerns.
7. Historical APK filenames and old test matrices are not current release evidence.
8. Current code + current automated tests + current device acceptance are the release source of truth.

---

## 14. Historical files intentionally superseded

The following archive files are now represented by this consolidation and may be deleted after retaining a backup ZIP if desired:

- `AI_COST_AND_CREDITS_AUDIT_2026-08-11.md`
- `BUSINESS_SCANNER_PROJECT_STATUS_2026-08-11.md`
- `CAMERA_SHARPNESS_TEST.md`
- `DOCUMENT_CORPUS_CERTIFICATION_2026-08-12.md`
- `FINAL_PHONE_QA_2026-08-12.md`
- `FINAL_STABILIZATION_NOTES.md`
- `LAYOUT_BLOCK_DETECTOR_SPEC.md`
- `PARSER_ENGINE_FIX_PLAN_FROM_E2E.md`
- `PARSER_ENGINE_REGRESSION_ANALYSIS.md`
- `PARSER_ENGINE_SPEC.md`
- `PARSER_ENGINE_STATUS_AND_DECISION.md`
- `PARSER_V4_DELIVERY.md`
- `PARSER_V4_README.md`
- `PARSER_V5_BULK_QA_RESULTS.md`
- `PARSER_V5_BULK_QA_ROOT_CAUSES.md`
- `PHASE_20_SCOPE_AND_IMPACT_REPORT.md`
- `POST_SHIM_E2E_FAILURES.md`
- `PRIVACY_CONSENT_TECHNICAL_AUDIT_2026-08-12.md`
- `PURCHASE_PROVIDER_CROSS_PLATFORM_SPEC.md`
- `RELEASE_HARDENING_2026-08-12.md`
- `SHIM_PLAN.md`
- `TRIAL_EXPIRY_AND_REINSTALL_AUDIT_2026-08-12.md`
- `V5_BULK_QA_FIX_PLAN.md`

They are useful as historical evidence, but they should no longer compete with `MASTER_STATUS.md` as live project documentation.

---

## 15. Documentation hierarchy going forward

Recommended authoritative hierarchy:

### Root
- `MASTER_STATUS.md` — **single live operational status**
- `README.md` — project/setup overview

### `docs`
- `PROJECT_HISTORY_AND_DECISIONS.md` — this consolidated historical reference
- `ANDROID_RELEASE_SIGNING.md`
- `AI_CREDITS_LICENSING_AND_STORE_PLAN_2026-08-12.md`
- `INVIO-SVILUPPATORE-IOS.md`
- `IOS_DEVELOPER_HANDOFF.md`
- `SUPABASE-IOS-DEVELOPER.md`

### `legal`
- `PRIVACY_POLICY_GDPR.md`
- `PRIVACY_POLICY_GDPR_EN.md`
- `TESTO_PRIVACY_PRIMA_PAGINA_APP.md`

Everything else should exist only if it is still operationally useful and current.

---

## 16. Source-of-truth rule

When historical documentation disagrees with current implementation:

1. current production code;
2. current tests;
3. current real-device QA;
4. current `MASTER_STATUS.md`;
5. this historical consolidation;
6. old archive

is the preferred evidence order.

---

**End of consolidated history and durable decisions.**
