# Invio progetto a sviluppatore iOS — guida KFIVE

> **Canonical handoff:** `docs/IOS_DEVELOPER_HANDOFF.md`  
> Ultimo aggiornamento identità: **agosto 2026** — Bundle ID `com.ideebusiness.cardscanner.ai`  
> Contatto: **info@kfive.it**

---

## Stato attuale

| Voce | Stato |
|------|--------|
| NDA (`legal/NDA-iOS-Developer.docx`) | ✅ Firmato |
| Build Android release testata | ✅ |
| Backend Supabase **topscanner** | ✅ Attivo |
| Account Apple Developer (€99/anno) | ⏳ KFIVE in attesa attivazione Apple |
| Build iOS / TestFlight | ⏳ Da fare dallo sviluppatore |

---

## Domande frequenti (in italiano)

### Il file `.env` — devo inviarlo?

**No, non come file nel repository o nello ZIP del codice.**

Il `.env` contiene le credenziali di collegamento al backend. È **solo sul tuo computer** ed è **escluso da Git** (`.gitignore`).

**Cosa fare:**

1. Invii il **codice sorgente** (repo o archivio) **senza** `.env`
2. Invii i **due valori** dentro `.env` in un **canale privato** (email cifrata, password manager, messaggio diretto):

```
EXPO_PUBLIC_SUPABASE_URL=https://hhomzzkocgkxzvaycfod.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<incolla qui la chiave eyJ...>
```

Lo sviluppatore crea **il suo** file `.env` sul Mac (o configura **EAS Secrets** per build cloud) con quei valori.

### Cos’è la **anon key**?

È la **chiave pubblica** del progetto Supabase. Permette all’app di chiamare le funzioni cloud (OCR, licenze).

| | |
|--|--|
| **Dove si trova** | Supabase → progetto **topscanner** → Settings → API → **anon public** (JWT che inizia con `eyJ`) |
| **Cosa NON è** | Password database, chiave segreta service_role, chiave Gemini |
| **Sicurezza** | È “pubblica” per design Supabase, ma va comunque inviata solo a persone autorizzate (NDA) |
| **Dopo modifica** | Serve **rebuild completo** iOS/Android |

### Come fa iOS a funzionare senza il mio `.env`?

Al momento del **build** (EAS o Xcode), i valori di `.env` vengono **incorporati nell’app**. L’app compilata sa già a quale server collegarsi.

Flusso:

```
Tu invii URL + anon key (privato)
    → Developer crea .env locale OPPURE EAS Secrets
    → eas build --platform ios
    → L’IPA contiene già URL e chiave
    → L’app su iPhone chiama topscanner.supabase.co
```

**Non serve** che tu mandi il file `.env` fisico: bastano i **valori**.

---

## Cosa inviare — checklist

### Nel pacchetto codice (Git / ZIP)

- [x] Intero progetto **eccetto** `.env`, `node_modules`, cartelle build
- [x] `docs/SUPABASE-IOS-DEVELOPER.md` (brief tecnico inglese)
- [x] `docs/INVIO-SVILUPPATORE-IOS.md` (questo file)
- [x] `RIPRESA.md`, `TEST-PLAN.md`, `.env.example`
- [x] NDA firmato (PDF o docx firmato)

### Separato, in privato

- [ ] `EXPO_PUBLIC_SUPABASE_URL`
- [ ] `EXPO_PUBLIC_SUPABASE_ANON_KEY` (JWT `eyJ...`)
- [ ] Chiave test licenza: `<PREMIUM_LICENSE_KEY>` + `<OWNER_EMAIL>` (canale privato; non in repo)
- [ ] Quando pronto: invito **Apple Developer** (team KFIVE) per certificati

### Non inviare

- ❌ Chiave o modello Gemini — non esistono variabili Gemini nella build mobile; sono Secrets Supabase server-side
- ❌ Service role key Supabase
- ❌ Password account Supabase / Google

---

## Apple Developer — chi paga, chi fa cosa

| Ruolo | Azione |
|-------|--------|
| **KFIVE (tu)** | Iscrizione Apple Developer Program (~€99/anno) — *in attesa* |
| **KFIVE** | Crea App ID `com.ideebusiness.cardscanner.ai` nel portal Apple |
| **Developer iOS** | Build con EAS, upload TestFlight, fix eventuali issue iOS |
| **Da concordare** | Submit App Store (KFIVE o developer) |

Fino all’attivazione account Apple, lo sviluppatore può preparare il progetto e configurare EAS; la build firmata per dispositivi reali / TestFlight richiede l’account attivo.

---

## Obiettivo consegna

1. Build **iOS release** (non Expo Go — serve ML Kit nativo)
2. Distribuzione **TestFlight** per test KFIVE
3. Eventuale submit **App Store** (fase successiva)

---

## Test licenza (solo QA)

| Campo | Valore |
|-------|--------|
| Chiave | `<PREMIUM_LICENSE_KEY>` (canale privato) |
| Email | `<OWNER_EMAIL>` in `assigned_email` su Supabase (vedi `LICENZE.md`) |

Prova gratuita: 15 giorni automatici alla prima installazione.

---

## Funzionalità recenti (già nel codice)

- Schermata **GDPR** al primo avvio (privacy v4, contatto **info@kfive.it**)
- Biglietto: bottoni **Immagine** (foto persona) e **Biglietto** (OCR)
- Riquadro scansione biglietto **più grande**, default ↕ verticale
- Foto persona: solo locale, non inviata al cloud
- Eliminazione contatti dalla lista

---

## Messaggio tipo (inglese) per il developer

```
Hi,

Attached/linked: Business Scanner source (Expo SDK 54).
NDA signed and returned.

Goal: iOS release build + TestFlight.
Apple Developer account (KFIVE, €99/year) is pending activation — I will invite you to the team when ready.

Please read:
- docs/SUPABASE-IOS-DEVELOPER.md
- docs/INVIO-SVILUPPATORE-IOS.md

I will send EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY separately.
Do not add a Gemini API key or model to the mobile build; both are configured server-side in Supabase.

Production backend: topscanner (ref hhomzzkocgkxzvaycfod).
Do NOT use LabTracker (hcklnxcpjqhfskidffgk).

Bundle ID: com.ideebusiness.cardscanner.ai
Native build required (ML Kit) — Expo Go is not enough.

Test license key: <PREMIUM_LICENSE_KEY> (email separately via private channel).

Questions: info@kfive.it

Thanks,
KFIVE
```

---

## Documenti correlati

- [SUPABASE-IOS-DEVELOPER.md](./SUPABASE-IOS-DEVELOPER.md)
- [../RIPRESA.md](../RIPRESA.md)
- [../TEST-PLAN.md](../TEST-PLAN.md)
