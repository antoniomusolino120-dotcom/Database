# FindMyInk Cloud Collector

Cloud execution layer for the verified V3.2 collector.

## Authoritative queue

The Google Sheet tab `COMUNI` is authoritative:

- column G: `TODO` / `COMPLETED`
- column L: timestamp of the last fully completed scan
- no `PARTIAL` state is used in cloud mode

A failed/interrupted municipality remains `TODO`; column L is not changed. The next run restarts that municipality from the beginning.

## Parallelism

The GitHub Actions workflow supports 3 or 5 workers. Each Municipality ID is deterministically assigned to one shard, so workers from the same workflow do not process the same municipality.

A workflow-level concurrency group prevents two collector runs from running at the same time.

## Deduplication

Before opening a Google Maps place card the worker derives the same Maps key used by the V3 engine and checks it against the current `MASTER` index. Known links are skipped immediately. A second, locked server-side deduplication is performed before every MASTER insert/update for correctness across workers.

## Required configuration

Repository Actions secret:

`SHEET_ENDPOINT` = deployed Apps Script Web App `/exec` URL for `apps-script/Code.gs`.

After updating `Code.gs`, deploy a new Web App version before starting the cloud collector.
