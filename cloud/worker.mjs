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
const MAX_MUNICIPALITIES = Math.max(0, Number(process.env.MAX_MUNICIPALITIES || 0));
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

const WORKER_ID = `run-${process.env.GITHUB_RUN_ID || Date.now()}-w${WORKER_INDEX}`;
const log = (event, meta={}) => console.log(JSON.stringify({ts:new Date().toISOString(),worker:WORKER_INDEX,workerId:WORKER_ID,event,...meta}));
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
  let attempted = 0;

  outer:
  while (Date.now() < deadline) {
    if (MAX_MUNICIPALITIES && attempted >= MAX_MUNICIPALITIES) break;
    const remaining = MAX_MUNICIPALITIES ? Math.max(1, Math.min(BATCH_SIZE, MAX_MUNICIPALITIES - attempted)) : BATCH_SIZE;
    const work = await sheet('getCloudWork', {workerIndex:WORKER_INDEX, workerCount:WORKER_COUNT, limit:remaining});
    const municipalities = work.rows || [];
    if (!municipalities.length) {
      log('queue-empty');
      break;
    }

    for (const municipality of municipalities) {
      if (Date.now() >= deadline) break outer;
      if (MAX_MUNICIPALITIES && attempted >= MAX_MUNICIPALITIES) break outer;
      attempted++;
      let found = 0, newCount = 0, duplicates = 0, foreign = 0;
      const seenThisMunicipality = new Set();
      const claimedThisMunicipality = new Set();
      log('municipality-start', {queueCode:municipality.queueCode, municipalityId:municipality.municipalityId, name:municipality.name, attempted});

      try {
        for (const variant of QUERIES) {
          if (Date.now() >= deadline) throw new Error('__TIME_LIMIT__');
          const query = buildMunicipalityQuery(variant, municipality);
          const search = await browser.collectLinks(query, SETTINGS);
          if (search.verification) throw new Error('GOOGLE_VERIFICATION_REQUIRED');
          const links = search.links || [];
          found += links.length;
          log('query-links', {queueCode:municipality.queueCode, query, count:links.length});

          const pending = [];
          for (const link of links) {
            const key = linkKey(link);
            const compactUrl = normalizeMapsUrl(link);
            const localFingerprint = key || compactUrl;

            // Fast path locale: MASTER iniziale + risultati già gestiti da questo worker/comune.
            if ((key && knownKeys.has(key)) || knownUrls.has(compactUrl) || seenThisMunicipality.has(localFingerprint)) {
              duplicates++;
              continue;
            }
            if (localFingerprint) seenThisMunicipality.add(localFingerprint);
            pending.push({link,key,compactUrl});
          }

          // Fast path condivisa: prima di aprire le schede, un solo worker può prenotare ciascun Maps Key/CID.
          const reservable = pending.filter(item => item.key);
          const reservation = reservable.length
            ? await sheet('reserveCloudCandidates', {keys:reservable.map(item => item.key), workerId:WORKER_ID})
            : {claimed:[],known:[],busy:[]};
          const claimed = new Set(reservation.claimed || []);
          for (const key of reservation.known || []) knownKeys.add(String(key));
          duplicates += (reservation.known || []).length + (reservation.busy || []).length;
          for (const key of claimed) claimedThisMunicipality.add(String(key));
          log('preclick-dedup', {
            queueCode:municipality.queueCode,
            candidates:pending.length,
            claimed:claimed.size,
            known:(reservation.known||[]).length,
            busy:(reservation.busy||[]).length
          });

          for (const item of pending) {
            if (Date.now() >= deadline) throw new Error('__TIME_LIMIT__');
            if (item.key && !claimed.has(item.key)) continue;

            const candidate = await browser.extractPlace(item.link, SETTINGS);
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
        // Il comune resta TODO e L resta invariata: al prossimo run ricomincia dall'inizio.
        if (claimedThisMunicipality.size) {
          await sheet('releaseCloudCandidates', {keys:[...claimedThisMunicipality], workerId:WORKER_ID}).catch(()=>{});
        }
        if (err.message === '__TIME_LIMIT__') {
          log('time-limit', {queueCode:municipality.queueCode});
          await sheet('failCloudMunicipality', {municipalityId:municipality.municipalityId, error:'Interrotto per limite temporale GitHub Actions'}).catch(()=>{});
          break outer;
        }
        await sheet('failCloudMunicipality', {municipalityId:municipality.municipalityId, error:err.message}).catch(()=>{});
        log('municipality-error', {queueCode:municipality.queueCode, error:err.message});
        if (err.message === 'GOOGLE_VERIFICATION_REQUIRED') break outer;
      }
    }
  }

  await browser.close().catch(()=>{});
  log('worker-done', {completed, attempted});
}

run().then(() => app.quit()).catch(err => {
  console.error(err?.stack || err);
  app.exit(1);
});
