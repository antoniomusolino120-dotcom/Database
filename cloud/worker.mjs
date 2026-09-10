import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { MapsBrowserCollector } from '../main/services/browserCollector.js';
import { buildMunicipalityQuery } from '../main/services/municipalities.js';
import { mapsKey, parseCid } from '../main/utils/normalize.js';
import { isExplicitForeign } from '../main/utils/location.js';

app.disableHardwareAcceleration();

const ENDPOINT = String(process.env.SHEET_ENDPOINT || '').trim();
const WORKER_INDEX = Number(process.env.WORKER_INDEX || 0);
const WORKER_COUNT = Number(process.env.WORKER_COUNT || 3);
const MAX_MINUTES = Math.min(330, Math.max(5, Number(process.env.MAX_MINUTES || 300)));
const BATCH_SIZE = Math.max(1, Math.min(25, Number(process.env.WORK_BATCH_SIZE || 8)));
const QUERIES = String(process.env.MAPS_QUERIES || 'tattoo,tatuatore,tattoo studio,studio tatuaggi,tattoo artist')
  .split(',').map(x => x.trim()).filter(Boolean);
const SETTINGS = {
  minDelayMs: Number(process.env.MIN_DELAY_MS || 1100),
  maxDelayMs: Number(process.env.MAX_DELAY_MS || 2600),
  minScrollDelayMs: Number(process.env.MIN_SCROLL_DELAY_MS || 900),
  maxScrollDelayMs: Number(process.env.MAX_SCROLL_DELAY_MS || 1900),
  maxResultsPerQuery: Number(process.env.MAX_RESULTS_PER_QUERY || 300),
  maxScrollsPerQuery: Number(process.env.MAX_SCROLLS_PER_QUERY || 60),
};

const log = (event, meta={}) => console.log(JSON.stringify({ts:new Date().toISOString(),worker:WORKER_INDEX,event,...meta}));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sheet(action, payload={}, attempts=4) {
  if (!ENDPOINT) throw new Error('SHEET_ENDPOINT non configurato nei GitHub Actions secrets');
  let last;
  for (let i=1; i<=attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(ENDPOINT, {
        method:'POST',
        headers:{'Content-Type':'text/plain;charset=utf-8'},
        body:JSON.stringify({action,...payload}),
        redirect:'follow',
        signal:controller.signal,
      });
      if (!res.ok) throw new Error(`Sheet bridge HTTP ${res.status}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Risposta Sheet non JSON: ${text.slice(0,160)}`); }
      if (!data.ok) throw new Error(data.error || `Azione ${action} fallita`);
      return data;
    } catch (err) {
      last = err;
      if (i < attempts) await sleep(800 * i);
    } finally { clearTimeout(timer); }
  }
  throw last;
}

function linkKey(url='') {
  try { return mapsKey(url, parseCid(url)) || ''; } catch { return ''; }
}

function normalizeMapsUrl(url='') {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch { return String(url || '').split('?')[0].replace(/\/$/, ''); }
}

function isTattoo(item) {
  const hay = `${item?.name||''} ${item?.address||''} ${item?.website||''}`.toLowerCase();
  return /tattoo|tatu|tatou|ink/.test(hay);
}

async function run() {
  if (!Number.isInteger(WORKER_INDEX) || WORKER_INDEX < 0 || !Number.isInteger(WORKER_COUNT) || WORKER_COUNT < 1 || WORKER_INDEX >= WORKER_COUNT) {
    throw new Error(`Shard non valido: ${WORKER_INDEX}/${WORKER_COUNT}`);
  }
  if (!QUERIES.length) throw new Error('Nessuna query Maps configurata');

  await app.whenReady();
  const browser = new MapsBrowserCollector(path.join(os.tmpdir(), `fmi-cloud-${WORKER_INDEX}`), e => log(`browser:${e.type||'event'}`, e));
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  const knownKeys = new Set();
  const knownUrls = new Set();

  const index = await sheet('getCloudDedupIndex');
  for (const key of index.mapsKeys || []) if (key) knownKeys.add(String(key));
  for (const url of index.mapsUrls || []) if (url) knownUrls.add(normalizeMapsUrl(url));
  log('dedup-index-loaded', {keys:knownKeys.size, urls:knownUrls.size});

  await browser.open();
  let completed = 0;

  while (Date.now() < deadline) {
    const work = await sheet('getCloudWork', {workerIndex:WORKER_INDEX, workerCount:WORKER_COUNT, limit:BATCH_SIZE});
    const municipalities = work.rows || [];
    if (!municipalities.length) {
      log('queue-empty');
      break;
    }

    for (const municipality of municipalities) {
      if (Date.now() >= deadline) break;
      let found = 0, newCount = 0, duplicates = 0, foreign = 0;
      const seenThisMunicipality = new Set();
      log('municipality-start', {queueCode:municipality.queueCode, municipalityId:municipality.municipalityId, name:municipality.name});

      try {
        for (const variant of QUERIES) {
          if (Date.now() >= deadline) throw new Error('__TIME_LIMIT__');
          const query = buildMunicipalityQuery(variant, municipality);
          const search = await browser.collectLinks(query, SETTINGS);
          if (search.verification) throw new Error('GOOGLE_VERIFICATION_REQUIRED');
          const links = search.links || [];
          found += links.length;
          log('query-links', {queueCode:municipality.queueCode, query, count:links.length});

          for (const link of links) {
            if (Date.now() >= deadline) throw new Error('__TIME_LIMIT__');
            const key = linkKey(link);
            const compactUrl = normalizeMapsUrl(link);
            const localFingerprint = key || compactUrl;

            // Fast path: skip before opening the place card when MASTER (or this worker) already knows it.
            if ((key && knownKeys.has(key)) || knownUrls.has(compactUrl) || seenThisMunicipality.has(localFingerprint)) {
              duplicates++;
              continue;
            }
            if (localFingerprint) seenThisMunicipality.add(localFingerprint);

            const candidate = await browser.extractPlace(link, SETTINGS);
            if (candidate.verification) throw new Error('GOOGLE_VERIFICATION_REQUIRED');
            if (!candidate.name || !isTattoo(candidate)) continue;
            if (isExplicitForeign(candidate.address)) { foreign++; continue; }

            const upsert = await sheet('upsertCloudMaster', {row:candidate, municipalityId:municipality.municipalityId, queueCode:municipality.queueCode, sourceQuery:query});
            if (upsert.mode === 'inserted') newCount++; else duplicates++;
            if (upsert.mapsKey) knownKeys.add(String(upsert.mapsKey));
            if (upsert.mapsUrl) knownUrls.add(normalizeMapsUrl(upsert.mapsUrl));
          }
        }

        const completedAt = new Date().toISOString();
        await sheet('completeCloudMunicipality', {
          municipalityId:municipality.municipalityId,
          foundCount:found,
          newCount,
          duplicateCount:duplicates,
          foreignCount:foreign,
          completedAt,
          workerIndex:WORKER_INDEX,
          workerCount:WORKER_COUNT,
        });
        completed++;
        log('municipality-complete', {queueCode:municipality.queueCode, found, newCount, duplicates, foreign, completed});
      } catch (err) {
        if (err.message === '__TIME_LIMIT__') {
          log('time-limit', {queueCode:municipality.queueCode});
          await sheet('failCloudMunicipality', {municipalityId:municipality.municipalityId, error:'Interrotto per limite temporale GitHub Actions'}).catch(()=>{});
          await browser.close().catch(()=>{});
          return;
        }
        await sheet('failCloudMunicipality', {municipalityId:municipality.municipalityId, error:err.message}).catch(()=>{});
        log('municipality-error', {queueCode:municipality.queueCode, error:err.message});
        if (err.message === 'GOOGLE_VERIFICATION_REQUIRED') {
          await browser.close().catch(()=>{});
          return;
        }
      }
    }
  }

  await browser.close().catch(()=>{});
  log('worker-done', {completed});
}

run().then(() => app.quit()).catch(err => {
  console.error(err?.stack || err);
  app.exit(1);
});
