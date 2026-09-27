# Business Scanner AI — Crediti, licensing e Store plan

**Data:** 2026-08-12  
**Tipo:** piano economico + architettura (nessun billing Store implementato in questo task)  
**Modello Gemini verificato (secret digest Edge):** `gemini-3.5-flash-lite`  
**Baseline economica:** **Paid API** (non Free Tier Google)

---

## 0. Lettura rapida per il titolare

| Domanda | Risposta |
|--------|----------|
| Quanto costa tecnicamente 1 biglietto AI? | ~**$0.0006** |
| Quanto costa 1 pagina documento fotografata? | ~**$0.0044** |
| Quanto costa 1 pagina PDF semplice? | ~**$0.0046** |
| Quanto costa il PDF complesso 2 pagine (certificato)? | ~**$0.016** totali ≈ **$0.008 / credito** |
| Trial attuale | **5 crediti** — troppo basso per valutare bene PDF |
| Trial consigliato | **20 crediti** |
| Play / Apple billing oggi | **NON implementati** |
| Licenze/trial backend oggi | **Già esistenti** — vanno riusati come source of truth |

**Importante:** i crediti Business Scanner **non** sono dollari Gemini.  
Sono un’unità commerciale interna (oggi: 1 credito ≈ 1 pagina / 1 operazione card).

**Importante:** il modello commerciale **non** deve basarsi sul Free Tier Gemini. Solo Paid API.

---

## 1. Architettura AI attuale

| Funzione utente | Edge | Gemini calls | Crediti |
|-----------------|------|--------------|---------|
| Business Card AI | `structure-business-card` | 1 | 1 flat |
| Documento pagina | `parse-document` | 1 | 1 × pagine |
| PDF | `parse-pdf` | **2** (PASS A summary + PASS B items) | 1 × pagine |

Metering token: **implementato** (passivo) in `gemini-provider.ts` + aggregazione PDF + campo risposta `providerTokenUsage` (solo numeri).

---

## 2. Architettura crediti attuale

- Ledger durable Postgres (migration 006) — **CLOSED**
- Policy: tutti i tipi = **1** (`lib/ai-credit/cost-policy.ts`)
- Trial grant default **5** (`AI_TRIAL_GRANT_CREDITS` verificato = 5)
- Premium monthly grant env **20** (se attivo)
- Idempotency trial: `trial-grant:<installationId>`
- PDF addebita per **pagine**, anche se Gemini è chiamato **2 volte**

---

## 3. Token usage misurato (live Edge, 2026-08-12)

Modello: **`gemini-3.5-flash-lite`**.  
Campioni con **nuovi installationId** (non consumano il device QA dell’utente).

### Business Card AI (n=2 ok)

| Sample | prompt | output | total | crediti |
|-------:|-------:|-------:|------:|--------:|
| 1 | 535 | 173 | 708 | 1 |
| 2 | 525 | 155 | 680 | 1 |
| **Media** | **530** | **164** | **694** | **1** |

### Documento 1 pagina AI (n=2 ok; JPEG sintetici validi)

| Sample | prompt | output | total | crediti |
|-------:|-------:|-------:|------:|--------:|
| 1 | 2339 | 1684 | 4023 | 1 |
| 2 | 2339 | 1286 | 3625 | 1 |
| **Media** | **2339** | **1485** | **3824** | **1** |

### PDF semplice 1 pagina (n=1 in ultimo run; coerente con run precedente)

| | PASS A | PASS B | Combinato | crediti |
|--|-------:|-------:|----------:|--------:|
| prompt | 2705 | 847 | **3552** | |
| output | 1324 | 92 | **1416** | |
| total | 4029 | 939 | **4968** | **1** |

### PDF complesso 2 pagine (`preventivo_test_pdf_complesso_2026.pdf`)

| | PASS A | PASS B | Combinato | crediti |
|--|-------:|-------:|----------:|--------:|
| prompt | 3237 | 1379 | **4616** | |
| output | 4827 | 985 | **5812** | |
| total | 8064 | 2364 | **10428** | **2** |

Nota: output PASS A alto (thinking / JSON ricco). I crediti restano **2**, non 2 chiamate.

---

## 4. Costi Gemini misurati (Paid tier)

Fonte listino ufficiale: [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) (2026-08-12)

`gemini-3.5-flash-lite` Paid:

- Input: **$0.30 / 1M tokens**
- Output (incl. thinking): **$2.50 / 1M tokens**

| Caso | Input USD | Output USD | Totale USD | Crediti | USD / credito |
|------|----------:|-----------:|-----------:|--------:|--------------:|
| Card media | 0.00016 | 0.00041 | **0.00057** | 1 | **0.00057** |
| Documento 1p media | 0.00070 | 0.00371 | **0.00442** | 1 | **0.00442** |
| PDF 1p | 0.00107 | 0.00354 | **0.00461** | 1 | **0.00461** |
| PDF 2p complesso | 0.00139 | 0.01453 | **0.01592** | 2 | **0.00796** |

### Stime low / avg / high per credito Business Scanner

| | USD / credito | Uso |
|--|---------------:|-----|
| **Low** | ~0.0006 | solo card |
| **Avg (mix realistico)** | ~0.005 | documenti + PDF semplici |
| **High (PDF complesso)** | ~0.008–0.012 | PDF multipagina / output lungo |
| **Planning buffer KFIVE** | **0.015** | margine su documenti più pesanti futuri |

EUR: non c’è cambio ufficiale nel repo → tenere **USD** per decisioni; convertire con commercialista/banca quando si fissano listini IT.

---

## 5. Trial credits — configurazione commerciale APPLICATA

| Voce | Valore |
|------|--------|
| Decisione commerciale | **20 crediti** per nuovi trial |
| Primary source | DB `app_commercial_settings.trial_ai_credits` |
| Migration | `supabase/migrations/007_commercial_settings.sql` |
| Emergency override | solo se `AI_TRIAL_GRANT_EMERGENCY_OVERRIDE=true` + `AI_TRIAL_GRANT_CREDITS` |
| Code fallback | `DEFAULT_TRIAL_AI_CREDITS = 20` (non è la source of truth di produzione) |
| Utenti già grantati | **NON** top-up automatico (idempotency `trial-grant:<installationId>`) |

### Come cambiare 20 → 30 senza codice/APK

```sql
UPDATE public.app_commercial_settings
SET setting_value = '30',
    updated_at = now()
WHERE setting_key = 'trial_ai_credits';
```

Verifica:

```sql
SELECT public.get_commercial_setting_int('trial_ai_credits', 0, 10000);
```

Impatto: solo **nuovi** first-time grant. Installazioni già grantate restano al saldo storico.

| Trial | Costo tecnico max stimato @ $0.015/credito | Utilità |
|------:|------------------------------------------:|---------|
| **20** (attuale DB) | ~$0.30 | Buono per valutazione mix card+doc+PDF |
| 50 | ~$0.75 | Generoso |
| 100 | ~$1.50 | Alto per trial gratuito tipico |

~~Raccomandazione precedente “solo env AI_TRIAL_GRANT_CREDITS=20”~~ → **OBSOLETA**: ora la source of truth è il DB.

---

## 6. Modello commerciale semplice consigliato (starting point)

Prezzi retail **indicativi** (IVA / commissioni Store da confermare).  
Costo Gemini calcolato sul buffer **$0.015 / credito**.

### Trial
- **20 crediti** una tantum — **APPLICATO** via DB `trial_ai_credits`
- Costo KFIVE ≈ **$0.30**
- Retail: **€0**

### Piano mensile (licenza + crediti)
- Prezzo retail proposto: **€9,99 / mese**
- Include: **100 crediti AI / mese**
- Costo Gemini max ≈ **$1.50** (~€1,4)
- Commissione Store tipica ~15–30% → lordo netto da verificare
- Margine lordo prima commissione/tasse: alto sul solo Gemini; il prezzo paga anche app, backend, supporto

### Piano annuale
- Prezzo retail proposto: **€79,99 / anno** (~€6,7/mese)
- Include: **100 crediti / mese** (ricarica mensile idempotente), entitlement annuale
- Stesso costo Gemini mensile del piano mensile
- Incentivo: sconto vs 12× mensile

### Pacchetti consumabili extra

| Pack | Crediti | Costo Gemini max @ $0.015 | Retail proposto | Razionale |
|------|--------:|--------------------------:|----------------:|-----------|
| Small | 100 | ~$1.50 | **€4,99** | top-up leggero |
| Medium | 500 | ~$7.50 | **€19,99** | power user |
| Large | 1000 | ~$15.00 | **€34,99** | volume / studi |

**No over-tiering:** 1 trial + 1 mensile + 1 annuale + 3 pack.

---

## 7–11. Chi fa cosa

### Google Play / Apple Store
- Pagamento cliente, UI checkout, ricevuta/transaction
- Payout allo sviluppatore, commissione Store
- Eventi rinnovo / rimborso / cancel (via API/webhook)

### KFIVE / Business Scanner backend
- Entitlement (trial / chiave / store-verified)
- Saldo crediti durable + grant idempotenti
- Verifica server-side purchase token
- Anti-frode / replay / audit / correzioni admin
- **Mai** grant crediti dal solo client

### Gemini / Google AI
- Elaborazione AI
- Fatturazione API a KFIVE (Paid)

---

## 12. Purchase → entitlement (architettura target)

```
Store purchase confirmation
  → backend verification (Play / Apple)
  → durable purchase record (unique transaction id)
  → activate / extend entitlement in Supabase
  → app refresh via check-license / validate-license
```

**Il backend entitlement esistente resta la source of truth.**  
Store non sostituisce le tabelle license: le **alimenta** dopo verifica.

---

## 13. Purchase → credit grant (architettura target)

```
1. User buys pack in Store
2. Store returns purchase token / transaction
3. Backend verifies with Store APIs
4. Backend inserts purchase row (unique)
5. Backend grant_ai_credits idempotent
6. Balance increases
7. App refreshes aiCreditsRemaining
8. Same purchase never grants twice
```

**Idempotency key consigliata:**

`store-purchase:<platform>:<transactionId>`

---

## 14. Subscription credit refill

| Regola | Raccomandazione |
|--------|-----------------|
| Ricarica | Mensile, se entitlement active |
| Idempotency | `premium-monthly:<licenseId>:<YYYY-MM>` (già simile a grant premium) |
| Unused rollover | **NO** (semplice; evita stock infinito) |
| Cancel | Stop refill al periodo successivo; saldo residuo usabile fino a expiry entitlement |
| Renewal | Nuovo grant periodo |
| Grace | Allineare a grace license esistente; niente nuovi grant in grace lunga senza verifica Store |
| Expired | Entitlement inactive; saldo crediti: **conservare ma non ricaricare** (o azzerare solo con policy esplicita — default: conservare) |

---

## 15. Google Play Billing — audit (NON implementato)

| Voce | Stato | Ownership |
|------|-------|-----------|
| Abbonamento / licenza non-consumabile | NOT IMPLEMENTED | Store product + Backend entitlement |
| Pacchetti crediti consumabili | NOT IMPLEMENTED | Store product + Backend grant |
| Purchase acknowledgement | NOT IMPLEMENTED | App + Backend |
| Purchase token verification | NOT IMPLEMENTED | BACKEND-HANDLED |
| Restore purchases | NOT IMPLEMENTED | App + Backend |
| Refund / cancel handling | NOT IMPLEMENTED | STORE events + BACKEND |
| Subscription renewal | NOT IMPLEMENTED | STORE-HANDLED + BACKEND mirror |
| Commissione Store | STORE-HANDLED | Contabilità KFIVE |

---

## 16. Apple IAP — audit (NON implementato)

| Voce | Stato | Ownership |
|------|-------|-----------|
| StoreKit product types | NOT IMPLEMENTED | |
| Subscription | NOT IMPLEMENTED | Store + Backend |
| Consumable credit packs | NOT IMPLEMENTED | Store + Backend |
| Transaction verification | NOT IMPLEMENTED | BACKEND-HANDLED (App Store Server API) |
| Restore purchases | NOT IMPLEMENTED | App + Backend |
| Renewal / cancel / refund | NOT IMPLEMENTED | STORE notifications + BACKEND |

---

## 17. No credit loss / double grant — release requirements

Obbligatori prima dello Store:

1. Verifica purchase **solo server-side**
2. Transaction id unico
3. Tabella purchase durable
4. Grant crediti idempotente
5. Retry-safe
6. Traccia refund/cancel
7. Nessun self-grant client

---

## 18. DA CHIEDERE AL COMMERCIALISTA

> Non sono conclusioni legali/fiscali.

- Come trattare ricavi Play/Apple (IVA, reverse charge, marketplace)
- Quali report Store conservare e per quanto
- Fatturazione B2B chiavi manuali vs IAP consumer
- Trattamento pacchetti crediti (servizio digitale / buono)
- Rimborsi Store e note di credito
- Paese di residenza utente vs KFIVE
- Obblighi privacy/contabili su transaction id (senza loggare contenuti documenti)

Dati che KFIVE dovrebbe trattenere: transaction id, platform, product id, timestamp, installation/license id, grant amount, verification status — **non** contenuti AI.

---

## 19. Task implementativi rimanenti (ordine)

1. ~~Decisione commerciale: trial **20**, listini pack/sub~~ — trial **20 APPLICATO in DB**; listini pack/sub ancora da decidere  
2. ~~Set env `AI_TRIAL_GRANT_CREDITS=20`~~ — **OBSOLETO** (DB primary via `007_commercial_settings.sql`)  
3. Document corpus certification  
4. Logging cleanup / security-release audit  
5. Android release signing  
6. Implement Play Billing + server verify + grant  
7. Implement Apple IAP (dopo o in parallelo controllato)  
8. Privacy/store legal review  
9. Flip RC flags produzione  
10. Store listing

---

## 20. Ordine di sviluppo consigliato (finale)

```
[DONE] Durable ledger + PDF credits + UI balance
[DONE] Token metering passivo + primi costi misurati
[NEXT] Corpus documenti + hardening release (signing/logging/security)
[NEXT] Decisione prezzi trial/pack/sub (questo documento)
[THEN] Play Billing + purchase→grant
[THEN] Apple IAP
[THEN] Store submission
```

---

## 21. Verdetto design

**Sì:** crediti / licensing / economics sono ora **sufficientemente definiti** per procedere all’implementazione Store **dopo** le decisioni commerciali esplicite su trial=20 e prezzi retail.

**No:** non è ancora release-ready (mancano billing, signing, corpus, audit).
