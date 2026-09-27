# Business Card Scanner — Master Status

**Ultimo aggiornamento:** 29 agosto 2026, 21:05 (Europe/Rome)  
**Workspace operativo:** `D:\IDEE BUSINESS\BUSINESS_CARD\new_business-card-scanner_05_RC`

## Stato generale

**RC pronta per l'ultimo test reale documenti su dispositivo.**

- ✅ Test automatici documento: **PASS**
- ✅ Phase 6: **PASS / CLOSED**
- ✅ Phase 7A: **PASS / CLOSED**
- ✅ Phase 7B: **PASS / CLOSED**
- ✅ Phase 7C: **PASS / CLOSED**
- ✅ Build Android pulita: **PASS**
- ✅ Nuovo APK debug installato sul telefono: **PASS**
- ⏳ Accettazione finale documenti su dispositivo reale con il nuovo APK: **PENDING**
- ⏸️ Biglietti da visita: **NON ancora riaperti; si procede dopo DOCUMENTI FINAL PASS**

**Stato documenti attuale:** `AUTOMATED PASS / REAL-DEVICE FINAL ACCEPTANCE PENDING`

Non dichiarare `DOCUMENTI = FINAL PASS` finché il nuovo APK non supera l'ultimo test reale sul telefono.

---

## Baseline automatica già chiusa

- `test:document-capture`: **8/8 PASS**
- `test:document-assets`: **4/4 PASS**
- Phase 7A: **24/24 PASS**
- Phase 7B: **37/37 PASS**
- Phase 7C: **61/61 PASS**

**Phase 6 / 7A / 7B / 7C = CLOSED**  
Non inventare o avviare una Phase 7D.

---

## Chiusura automatica documenti — 29 agosto 2026

### Orientamento multipagina — FIX GENERICA
- Nessuna rotazione hardcoded.
- Nessun documento hardcoded.
- Nei casi geometricamente contraddittori viene usata la decisione/probe visuale prevista.
- `document-multipage-orientation.test.ts`: **6/6 PASS**
- `test:document-capture`: **8/8 PASS**

**ORIENTAMENTO MULTIPAGINA AUTOMATICO = PASS**

### Binding colonne commerciali — FIX GENERICA
Il modello distingue:
- quantità;
- prezzo base/listino;
- sconto;
- prezzo netto/effettivo;
- IVA;
- totale riga.

Regole:
- il listino è distinto dal prezzo netto;
- il listino non può rubare quantità, netto o totale;
- il totale riga non può rubare il prezzo unitario;
- lo sconto accetta solo evidenza compatibile;
- decisione basata su semantica intestazioni, geometria, confidence e coerenza aritmetica.

`document-row-field-binding.test.ts`: **22/22 PASS**

**BINDING COLONNE GENERICO = PASS / CLOSED**

### IVA / sconti / totali
`document-p0-vat-discount-totals.test.ts`: **30/30 PASS**

Verificati genericamente:
- IVA standard e aliquote multiple;
- IVA OCR corrotta;
- sconto e IVA adiacenti;
- assenza sconto / assenza IVA;
- subtotale / imponibile;
- spese / oneri;
- totale documento;
- persistenza;
- righe a costo zero;
- note/disclaimer non trasformati in righe commerciali.

**IVA / SCONTI / TOTALI = PASS / CLOSED**

### Coerenza monetaria
`document-monetary-consistency.test.ts`: **9/9 PASS**

Verificati:
- quantità × prezzo;
- sconto percentuale;
- conflitti matematici segnalati senza correzioni silenziose;
- somma righe vs imponibile;
- imponibile + IVA vs totale;
- aliquote multiple;
- missing preservato.

**COERENZA MONETARIA = PASS / CLOSED**

### Validazione deterministica
`document-deterministic-validation.test.ts`: **6/6 PASS**

Verificati:
- quadratura generale;
- righe incoerenti marcate per review;
- date / numero documento / IBAN con guardie formali;
- missing preservato;
- sconto, IVA inclusa, spese e acconto con formule dichiarate;
- sconto ambiguo non forzato arbitrariamente.

**VALIDAZIONE DETERMINISTICA = PASS / CLOSED**

### Completezza / partial / persistenza
`document-completeness-integration.test.ts`: **11/11 PASS**

Verificati:
- pagina completa → complete;
- acquisizione parziale → review/nuova acquisizione;
- pagina vuota/tagliata → nessun dato inventato;
- tabella senza righe supportate → partial;
- multipagina conserva pagine e righe;
- provenance e missing preservati;
- storage mantiene il payload;
- nuovo scan sostituisce falsi positivi legacy con evidenza layout.

**COMPLETEZZA / PERSISTENZA = PASS / CLOSED**

### Performance / deadline multipagina
`document-multipage-layout-deadline.test.ts`: **4/4 PASS**

- caso pesante: circa 267 righe OCR;
- structured processing circa 1,1 s;
- `deadline_exceeded: false`.

**PERFORMANCE / DEADLINE = PASS / CLOSED**

---

## Riepilogo test generici documenti

| Area | Risultato |
|---|---:|
| Document capture integrity | 8/8 PASS |
| Document asset routing | 4/4 PASS |
| Multipage orientation regression | 6/6 PASS |
| Generic row/field binding | 22/22 PASS |
| VAT / discount / totals | 30/30 PASS |
| Monetary consistency | 9/9 PASS |
| Deterministic validation | 6/6 PASS |
| Completeness integration | 11/11 PASS |
| Multipage layout/deadline | 4/4 PASS |
| Phase 7A | 24/24 PASS |
| Phase 7B | 37/37 PASS |
| Phase 7C | 61/61 PASS |

**FAIL noti nei blocchi sopra: 0**

---

## Build Android corrente

Il precedente `android\app\build` è stato cancellato prima della ricompilazione.

Procedura:

```cmd
cd D:\IDEE BUSINESS\BUSINESS_CARD\new_business-card-scanner_05_RC\android
rmdir /s /q app\build
.\gradlew assembleDebug
```

Esito:
- ✅ build pulita completata;
- ✅ APK nuovo generato;
- ✅ APK nuovo installato sul telefono.

APK:

`D:\IDEE BUSINESS\BUSINESS_CARD\new_business-card-scanner_05_RC\android\app\build\outputs\apk\debug\app-debug.apk`

---

## Regola assoluta per i fix documentali

Da questo punto sono accettati **solo fix generici di modello**.

### VIETATO
- hardcode per azienda;
- hardcode per documento;
- hardcode per numero documento;
- hardcode per valori monetari di fixture;
- eccezioni create solo per far passare un test;
- patch specifiche per un singolo esempio reale.

### CONSENTITO
- semantica delle intestazioni;
- geometria delle colonne;
- ownership delle righe;
- coerenza aritmetica;
- confidence;
- provenance;
- regole linguistiche/generalizzabili;
- guardie OCR/generalizzabili.

Se un nuovo caso reale fallisce, prima si dimostra la **causa generale**. Solo dopo si modifica il modello.

---

## Ultimo test documenti ancora obbligatorio

**PENDING — REAL-DEVICE FINAL ACCEPTANCE**

Da eseguire con il nuovo APK installato.

Controlli minimi:
1. documento multipagina → tutte le pagine orientate correttamente;
2. documento con quantità / prezzo / sconto / totale → binding corretto;
3. documento con IVA → valori coerenti;
4. salvataggio e riapertura → immagini e dati invariati;
5. nessun `structuredComplete:false` ingiustificato;
6. nessun campo palesemente errato quando il valore è leggibile nell'immagine.

Raccogliere:
- export QA;
- log Android della sessione;
- eventuali immagini necessarie per confronto.

Solo se passa:

`DOCUMENTI = FINAL PASS`

In caso contrario:
- non riaprire indiscriminatamente le fasi chiuse;
- isolare il difetto;
- correggere solo la causa generale;
- aggiungere/regolare test di regressione generici.

---

## Prossimo blocco dopo DOCUMENTI FINAL PASS

**BIGLIETTI DA VISITA**

Ordine:

```text
REAL-DEVICE DOCUMENT ACCEPTANCE
        ↓
DOCUMENTI = FINAL PASS
        ↓
BUSINESS CARDS / BIGLIETTI
```

Per i biglietti:
- OCR locale ML Kit;
- parser locale;
- review manuale;
- AI solo opzionale e su richiesta;
- nessun hardcode azienda-specifico;
- preservare le API pubbliche parser esistenti.

---

## Aree da non riaprire senza nuova evidenza

Non riaprire senza un FAIL nuovo e riproducibile:
- Phase 6;
- Phase 7A;
- Phase 7B;
- Phase 7C;
- document capture integrity;
- document asset routing;
- generic commercial column binding;
- VAT/discount/totals;
- monetary consistency;
- deterministic validation;
- completeness/persistence;
- multipage deadline.

Un PASS chiuso resta chiuso finché non compare una regressione concreta.

---

## Stato operativo per la prossima sessione

```text
DOCUMENTI
  Automated correctness ............. PASS
  Orientation automated ............. PASS
  Generic commercial binding ........ PASS
  VAT / discounts / totals .......... PASS
  Monetary reconciliation ........... PASS
  Deterministic validation .......... PASS
  Completeness / persistence ........ PASS
  Multipage performance/deadline .... PASS
  Clean Android build ............... PASS
  New APK installed on phone ........ PASS
  Real-device final acceptance ...... PENDING

DOCUMENTI FINAL PASS ................ NO — waiting only for final phone acceptance

NEXT AFTER FINAL PASS ............... BUSINESS CARDS
```

**Fine stato — 29 agosto 2026**


---

## PROJECT CLEANSING — ATTIVITÀ OBBLIGATORIA PRIMA DEL RELEASE

**Stato:** `PENDING / OBBLIGATORIO`

Questa attività NON va dimenticata e NON va sostituita da una semplice pulizia manuale occasionale.

### Quando eseguirla

Ordine obbligatorio:

```text
DOCUMENTI = FINAL PASS
        ↓
BIGLIETTI = FINAL PASS
        ↓
PROJECT CLEANSING COMPLETO
        ↓
RELEASE CHECK FINALE
```

Non eseguire il cleansing distruttivo prima della chiusura dei test real-device, perché file diagnostici o fixture possono ancora essere utili per investigare regressioni.

### Obiettivo

Ridurre il progetto RC allo stato realmente necessario e mantenibile, eliminando residui accumulati durante le numerose evoluzioni.

### Metodo obbligatorio

1. Inventario completo del progetto, escludendo inizialmente `node_modules`.
2. Classificazione di ogni elemento in:
   - `TENERE`
   - `ARCHIVIARE`
   - `ELIMINARE`
   - `DA VERIFICARE`
3. Verifica delle dipendenze/referenze prima di cancellare codice o script.
4. Backup/ZIP dell'eventuale materiale storico che vale la pena conservare.
5. Cancellazione automatizzata e ripetibile.
6. Riesecuzione dei test e build pulita dopo il cleansing.
7. Confronto finale della struttura del progetto.

### Aree da controllare

- file obsoleti;
- duplicati;
- copie `backup`, `old`, `copy`, `final`, `final-final`, versioni parallele;
- ZIP residui;
- APK/AAB e artifact vecchi;
- `dist`;
- `android\app\build`;
- cache e cartelle temporanee;
- vecchi export QA;
- fixture non più usate;
- test superati o duplicati;
- script non più utilizzati;
- codice morto/non referenziato;
- import inutilizzati;
- componenti non più raggiungibili;
- configurazioni duplicate o divergenti;
- `app.json` / `app.config.js`;
- dipendenze npm inutilizzate;
- log/debug/diagnostica rimasti attivi;
- file generati non necessari;
- documentazione superata;
- `.gitignore`;
- segreti, chiavi, token, dump, file `.env` impropriamente inclusi;
- dati reali o export contenenti informazioni personali;
- cartelle di backup accidentalmente dentro il working tree.

### Regola di sicurezza

Non cancellare mai un file di produzione solo perché sembra vecchio.

Prima di eliminarlo verificare:
- import;
- require;
- riferimenti negli script npm;
- riferimenti nei test;
- riferimenti nelle configurazioni;
- utilizzo Android/iOS;
- utilizzo Supabase/Edge;
- utilizzo runtime.

### Risultato richiesto

Alla fine produrre:

- `PROJECT_CLEANSING_REPORT.md`
- elenco file/cartelle eliminati;
- elenco elementi mantenuti e motivo;
- eventuali elementi dubbi rimasti;
- risultato test automatici dopo pulizia;
- risultato build Android pulita;
- conferma che nessun file necessario è stato perso.

**Il progetto non è considerato pronto al release finché questo cleansing non è stato completato e verificato.**
