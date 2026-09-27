# Setup Supabase topscanner — stato

> Progetto: **topscanner** · Ref: `hhomzzkocgkxzvaycfod`  
> URL: `https://hhomzzkocgkxzvaycfod.supabase.co`  
> Regione: West EU (Paris)  
> Ultimo aggiornamento: **luglio 2026**

## Checklist

| Step | Azione | Stato |
|------|--------|--------|
| 1 | Progetto topscanner in dashboard | ✅ |
| 2 | CLI collegato (`supabase link`) | ✅ |
| 3 | SQL tabelle licenze (`SETUP-PROGETTO-DEDICATO.sql`) | ✅ |
| 4 | Secrets Gemini su Edge Functions | ✅ |
| 5 | Deploy functions (`npm run supabase:deploy`) | ✅ |
| 6 | Chiave premium in DB (`SETUP-chiave-iniziale.sql`) | ✅ |
| 7 | `.env` locale (topscanner) — **non in Git** | ✅ |
| 8 | GDPR v4 + UX biglietto + foto persona | ✅ |
| 9 | Build Android release + test | ✅ |
| 10 | Handoff iOS + TestFlight | ⏳ Apple Developer in attesa |

> ⚠️ **Non usare** LabTracker (`hcklnxcpjqhfskidffgk`).

## Comandi utili

```powershell
cd "d:\IDEE BUSINESS\BUSINESS_CARD\business-card-scanner"
supabase link --project-ref hhomzzkocgkxzvaycfod
npm run supabase:deploy
npm run build:android:release
```

## Per developer iOS

**Non inviare il file `.env` nel repository.**

Inviare in privato (NDA):

```
EXPO_PUBLIC_SUPABASE_URL=https://hhomzzkocgkxzvaycfod.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon JWT da Project Settings → API>
```

Spiegazione completa: **`docs/INVIO-SVILUPPATORE-IOS.md`**, **`README.md`**
