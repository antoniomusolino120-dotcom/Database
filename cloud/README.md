# FindMyInk Cloud Collector

Il collector cloud usa il Google Sheet come fonte autorevole della coda.

## Regole della coda

- `COMUNI!G` usa solo `TODO` o `COMPLETED`.
- `COMUNI!L` viene valorizzata solo dopo una scansione completa e finalizzata.
- Un comune interrotto resta `TODO`.
- Il `Municipality ID` è la chiave logica.

## Parallelismo

Il workflow può avviare 3 o 5 Chromium in parallelo. Ogni worker riceve uno shard deterministico dei comuni `TODO`.

I worker **non scrivono in MASTER** e non marcano i comuni come `COMPLETED`. Raccolgono soltanto candidati in artifact separati.

## Deduplica

La deduplica è divisa in due livelli:

1. **Pre-click** nei worker: usa Maps Key / Maps URL già presenti in `MASTER` per evitare di aprire schede note.
2. **Finale unica**: un solo job `finalize`, dopo tutti i worker, scarica tutti gli artifact, confronta insieme i candidati dei 3/5 motori con `MASTER`, deduplica per Maps Key, Maps URL, telefono, nome+indirizzo e nome+dominio, quindi applica il risultato.

Apps Script usa un lock soltanto come protezione atomica durante la scrittura finale. La decisione finale di deduplica è indipendente dal numero di browser.

## Secret richiesto

`SHEET_ENDPOINT` = URL completo del deployment Apps Script (`.../macros/s/.../exec`).
