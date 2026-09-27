# Business Scanner

App mobile (Expo / React Native) per scansionare **biglietti da visita**, **preventivi**, **ordini** e documenti liberi.

| | |
|--|--|
| **Nome app** | Business Scanner |
| **Package / Bundle ID** | `com.ideebusiness.cardscanner.ai` |
| **Società** | KFIVE di Chiozza Giovanni S.a.s. |
| **Contatto** | info@kfive.it |
| **Backend produzione** | Supabase **topscanner** (`hhomzzkocgkxzvaycfod`) |

---

## Stato progetto (luglio 2026)

| Area | Stato |
|------|--------|
| Android APK release | ✅ Testato |
| Supabase topscanner + licenze | ✅ |
| GDPR consenso (privacy v4) | ✅ |
| Biglietto: bottoni **Immagine** / **Biglietto** | ✅ |
| Foto persona contatto (solo locale) | ✅ |
| iOS build / TestFlight | ⏳ In attesa Apple Developer (€99/anno) + developer iOS |
| NDA developer iOS | ✅ Firmato |

---

## Avvio rapido (sviluppo locale)

```powershell
cd "d:\IDEE BUSINESS\BUSINESS_CARD\business-card-scanner"
npm install
```

Copia `.env.example` → **`.env`** e compila i valori (vedi sotto).

```powershell
npm run start          # Expo Go (funzioni limitate)
npm run build:android:release   # APK release Android
```

> **Expo Go non basta** per test completi: serve build nativa (ML Kit, licenze, OCR cloud).

---

## File `.env` — cos’è e perché non va nel repo

Il file **`.env`** è un file **solo sul tuo PC** con le “password di collegamento” al backend Supabase.

| Cosa | Spiegazione |
|------|-------------|
| **Perché esiste** | L’app legge URL e chiave Supabase **al momento della compilazione** (build), non da codice sorgente |
| **Perché non si invia nel repo** | È in `.gitignore`: se finisse su Git, chiunque potrebbe usare il tuo backend |
| **Cosa inviare allo sviluppatore iOS** | Il **codice sorgente** + i **valori** di `.env` in un messaggio **privato** (email/WhatsApp), oppure tramite **EAS Secrets** |

**Analogia:** il codice è l’app; `.env` è la “SIM” con i dati per connettersi al server. Mandi l’app, la SIM la mandi a parte.

### Variabili richieste

```env
EXPO_PUBLIC_SUPABASE_URL=https://hhomzzkocgkxzvaycfod.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...   # vedi sotto
```

La chiave e il modello Gemini non fanno parte della build mobile. Sono
configurati esclusivamente nei Secrets delle Edge Function:
`GEMINI_API_KEY` e `GEMINI_MODEL=gemini-3.5-flash-lite`. La chiave deve essere
una Gemini API **auth key** corrente; una Standard API key legacy va migrata
prima del deploy.

### Cos’è la **anon key**

È una **chiave pubblica JWT** (stringa lunga che inizia con `eyJ...`) che Supabase usa per sapere **a quale progetto** collegarsi.

- Si trova in: **Supabase Dashboard → topscanner → Project Settings → API → anon public**
- **Non** è la password del database
- **Non** è `sb_publishable_...` — serve il JWT `eyJ...`
- Va incollata in `.env` (locale) o in EAS Secrets (build iOS cloud)
- Dopo ogni modifica → **rebuild completo** dell’app

Modello senza valori reali: **`.env.example`**

---

## Documentazione

| File | Contenuto |
|------|-----------|
| **[RIPRESA.md](RIPRESA.md)** | Guida tecnica completa, build, architettura |
| **[LICENZE.md](LICENZE.md)** | Chiavi, trial, attivazione *(riservato)* |
| **[TEST-PLAN.md](TEST-PLAN.md)** | Checklist test post-build |
| **[COSTI-E-PUBBLICAZIONE.md](COSTI-E-PUBBLICAZIONE.md)** | Costi cloud, prezzo licenza, App Store |
| **[docs/SUPABASE-IOS-DEVELOPER.md](docs/SUPABASE-IOS-DEVELOPER.md)** | Brief tecnico iOS (inglese) |
| **[docs/INVIO-SVILUPPATORE-IOS.md](docs/INVIO-SVILUPPATORE-IOS.md)** | Cosa inviare al developer iOS *(italiano)* |
| **[supabase/SETUP-TOPSCANNER-STATO.md](supabase/SETUP-TOPSCANNER-STATO.md)** | Stato setup Supabase |
| **`legal/NDA-iOS-Developer.docx`** | NDA firmato |

Rigenerare i `.docx` dopo modifiche ai `.md`:

```powershell
python scripts/md-to-docx.py
```

---

## Invio a sviluppatore iOS — riepilogo

1. **NDA** firmato ✅  
2. **Codice** (Git o ZIP) — **senza** `.env`, **senza** `node_modules`  
3. **Anon key + URL** in messaggio privato (o EAS Secrets)  
4. **Apple Developer** (€99/anno) — account **KFIVE**, in attesa attivazione  
5. Obiettivo: build iOS release + **TestFlight**  
6. Doc: `docs/INVIO-SVILUPPATORE-IOS.md` + `docs/SUPABASE-IOS-DEVELOPER.md`

---

## Comandi utili

| Comando | Descrizione |
|---------|-------------|
| `npm run build:android:release` | APK Android release |
| `npm run supabase:deploy` | Deploy edge functions |
| `supabase link --project-ref hhomzzkocgkxzvaycfod` | Collega CLI a topscanner |
| `python scripts/md-to-docx.py` | Aggiorna documenti Word |

**APK:** `android\app\build\outputs\apk\release\app-release.apk`

---

## Link

- [Supabase topscanner](https://supabase.com/dashboard/project/hhomzzkocgkxzvaycfod)
- [Expo EAS Build](https://docs.expo.dev/build/introduction/)
