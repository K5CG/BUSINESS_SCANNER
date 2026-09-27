# Supabase — brief for iOS developer (Business Scanner)

> **For:** freelance iOS migration developer  
> **From:** KFIVE di Chiozza Giovanni S.a.s.  
> **Date:** July 2026  
> **Contact:** info@kfive.it

---

## Summary

**You do NOT need to change application source code for Supabase.**

The app reads Supabase URL and API key from **environment variables at build time**.  
All backend calls go through `lib/config.ts` → `lib/supabase-functions.ts`.

**Production backend:** Supabase project **`topscanner`**  
**Ref:** `hhomzzkocgkxzvaycfod`  
**URL:** `https://hhomzzkocgkxzvaycfod.supabase.co`

Do **not** use LabTracker (`hcklnxcpjqhfskidffgk`).

---

## What is `.env`? (plain language)

KFIVE will **not** send you a `.env` file inside the Git repository (it is gitignored for security).

Instead, KFIVE sends you **two values** in a **private message**:

```
EXPO_PUBLIC_SUPABASE_URL=https://hhomzzkocgkxzvaycfod.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...paste_here...
```

You create `.env` on your machine **or** set **EAS Secrets** with the same values, then run a **full iOS build**.

At build time, Expo bakes these values into the app binary. The installed app then talks to topscanner automatically.

---

## What is the **anon key**?

| | |
|--|--|
| **What** | Supabase **anon public** JWT (long string starting with `eyJ`) |
| **Where** | Supabase Dashboard → topscanner → **Project Settings → API → anon public** |
| **Not** | Database password, `service_role` key, or `sb_publishable_...` |
| **Purpose** | Lets the app call edge functions (OCR, license checks) |
| **After change** | **Full rebuild** required |

---

## What NOT to change

Do **not** hardcode Supabase URLs or keys in:

- `lib/config.ts`
- `lib/supabase-functions.ts`
- `lib/gemini-ocr.ts`
- `lib/parse-pdf.ts`
- `lib/license-service.ts`
- React components

These files already use `getSupabaseUrl()` and `getSupabaseAnonKey()`.

---

## What to configure (build time only)

### Option A — Local `.env` (development / local release build)

File: **`.env`** in project root (not committed to Git). Copy from **`.env.example`**.

```env
EXPO_PUBLIC_SUPABASE_URL=https://hhomzzkocgkxzvaycfod.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...your_anon_jwt...
```

Do not add a Gemini key or model to the mobile build. Gemini runs on
Supabase Edge Functions and is configured only through server-side secrets.

### Option B — Expo EAS Build (recommended for iOS cloud build)

Set the same variables as **EAS secrets**:

| Variable | Description |
|----------|-------------|
| `EXPO_PUBLIC_SUPABASE_URL` | Project URL from Supabase Dashboard → Settings → API |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | **anon public** JWT (`eyJ...`), NOT `sb_publishable_...` |

Values are injected via `app.config.js` into `expo.extra`.

---

## Edge functions used by the app

All called as `POST {SUPABASE_URL}/functions/v1/{name}`:

| Function | Purpose |
|----------|---------|
| `parse-document` | OCR quotes/orders from **photo** (Gemini) |
| `parse-pdf` | OCR from **PDF** import (Gemini) |
| `validate-license` | License activation (email + key) |
| `check-license` | License/trial check on **every app start** |

Backend deploy (KFIVE side, already done):

```bash
supabase link --project-ref hhomzzkocgkxzvaycfod
npm run supabase:deploy
```

Supabase secrets (KFIVE dashboard): `GEMINI_API_KEY`,
`GEMINI_MODEL=gemini-3.5-flash-lite`. `GEMINI_API_KEY` must be a current
Gemini API **auth key**, not a legacy Standard API key.

---

## Features that need Supabase / internet

| Feature | Offline? |
|---------|----------|
| Business card scan (ML Kit) | ✅ Works offline |
| Contact person photo | ✅ Local only, never uploaded |
| Quote/order photo OCR | ❌ Needs Supabase + Gemini |
| PDF import | ❌ Needs Supabase + Gemini |
| Trial / license | ❌ Needs Supabase (7-day offline grace after last check) |

---

## iOS-specific notes

| Item | Value / status |
|------|----------------|
| Bundle ID | `com.ideebusiness.cardscanner.ai` (`app.json`) |
| Camera permission | `infoPlist.NSCameraUsageDescription` ✅ |
| Apple Developer account | **KFIVE** — enrollment pending (~€99/year) |
| Goal | Release build + **TestFlight** |
| NDA | Signed ✅ |
| Test build | **Release build** required — not Expo Go (ML Kit native) |
| Env change | **Full rebuild** after updating `.env` or EAS secrets |

Also read (Italian handoff guide): **`docs/INVIO-SVILUPPATORE-IOS.md`**

---

## Test license (QA only)

| Field | Value |
|-------|--------|
| Key | `<PREMIUM_LICENSE_KEY>` (private channel only; never commit live keys) |
| Email | `<OWNER_EMAIL>` (must match `assigned_email` in Supabase) |

Free trial: 15 days on first install per device.

---

## Recent app features (already in code)

- GDPR consent screen on first launch (privacy v4, contact **info@kfive.it**)
- Business card camera: **Photo** / **Card** mode buttons (no post-capture dialog)
- Larger card scan frame, portrait default for better OCR
- Contact list: delete + round avatar

---

## Troubleshooting

If Supabase calls fail (401, 404, “not configured”):

1. Verify anon JWT matches topscanner project URL
2. Confirm edge functions are deployed on `hhomzzkocgkxzvaycfod`
3. Confirm **full rebuild** after env change
4. Do not use LabTracker ref

Questions: **info@kfive.it**
