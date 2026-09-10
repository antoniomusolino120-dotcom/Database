# FindMyInk Cloud Collector

Il collector cloud usa il Google Sheet come fonte autorevole della coda e GitHub Actions come runtime dei browser.

## Coda dinamica

`COMUNI!G` usa solo `TODO` / `COMPLETED`; `COMUNI!L` viene valorizzata soltanto dopo una scansione completata e finalizzata.

Con 3 o 5 worker non esistono shard fissi. Ogni Chromium chiede al bridge Apps Script il prossimo comune `TODO` libero. Il claim è protetto da lock e ha un lease temporaneo: quindi i worker lavorano contemporaneamente su comuni diversi. Se un worker scompare, il lease scade e il comune, ancora `TODO`, può essere ripreso.

## Deduplica

1. **Pre-click**: ogni worker usa Maps Key / Maps URL già presenti in `MASTER` per evitare aperture inutili.
2. **Finale unica e centrale**: quando un comune è terminato, il worker invia tutti i candidati alla funzione `finalizeCloudMunicipality` del bridge. La funzione è serializzata con `LockService`, deduplica globalmente contro il `MASTER` corrente (Maps Key, Maps URL, telefono, nome+indirizzo, nome+dominio), scrive i dati e solo dopo imposta il comune `COMPLETED`.

Il numero di Chromium modifica soltanto la velocità di raccolta, non la logica finale di deduplica.

## Cloud Console

Il deployment Apps Script espone una console web all'URL:

`<SHEET_ENDPOINT>?dashboard=1`

La dashboard mostra:
- stato del run e dei 3/5 worker;
- comune e query correnti;
- contatori completati/TODO/trovati/nuovi/duplicati/scartati/errori;
- heartbeat di ogni worker;
- preview reale del Chromium aggiornata circa ogni 25 secondi;
- comando STOP sicuro.

Le preview sono JPEG ridotte e temporanee in `CacheService`: non vengono scritte nel Google Sheet.

## Configurazione richiesta

Secret GitHub Actions:

`SHEET_ENDPOINT` = URL completo del deployment Apps Script (`.../macros/s/.../exec`).

Dopo ogni modifica a `apps-script/Code.gs` o `apps-script/dashboard.html`, aggiornare il progetto Apps Script e creare una nuova versione del deployment.
