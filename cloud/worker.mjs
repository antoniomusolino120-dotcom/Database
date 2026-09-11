import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { MapsBrowserCollector } from '../main/services/browserCollector.js';
import { buildMunicipalityQuery } from '../main/services/municipalities.js';
import { mapsKey, parseCid } from '../main/utils/normalize.js';
import { isExplicitForeign } from '../main/utils/location.js';
import { isClearlyOutsideItaly } from './italy-filter.mjs';

app.disableHardwareAcceleration();

const ENDPOINT=String(process.env.SHEET_ENDPOINT||'').trim();
const RUN_ID=String(process.env.RUN_ID||process.env.GITHUB_RUN_ID||Date.now());
const WORKER_INDEX=Number(process.env.WORKER_INDEX||0);
const WORKER_COUNT=Number(process.env.WORKER_COUNT||3);
const MAX_MINUTES=Math.min(330,Math.max(5,Number(process.env.MAX_MINUTES||300)));
const OUTPUT_PATH=String(process.env.OUTPUT_PATH||path.join('cloud-output',`worker-${WORKER_INDEX}.json`));
const PREVIEW_INTERVAL_MS=Math.max(30000,Number(process.env.PREVIEW_INTERVAL_MS||60000));
const HEARTBEAT_INTERVAL_MS=Math.max(15000,Number(process.env.HEARTBEAT_INTERVAL_MS||30000));
const LEASE_SECONDS=Math.max(300,Math.min(1800,Number(process.env.LEASE_SECONDS||900)));
const MAX_MUNICIPALITIES_PER_WORKER=Math.max(0,Math.min(10000,Number(process.env.MAX_MUNICIPALITIES_PER_WORKER||0)));
const QUERIES=String(process.env.MAPS_QUERIES||'tattoo,tatuatore,tattoo studio,studio tatuaggi,tattoo artist').split(',').map(x=>x.trim()).filter(Boolean);
const SETTINGS={
  minDelayMs:Number(process.env.MIN_DELAY_MS||1100),
  maxDelayMs:Number(process.env.MAX_DELAY_MS||2600),
  minScrollDelayMs:Number(process.env.MIN_SCROLL_DELAY_MS||900),
  maxScrollDelayMs:Number(process.env.MAX_SCROLL_DELAY_MS||1900),
  maxResultsPerQuery:Number(process.env.MAX_RESULTS_PER_QUERY||300),
  maxScrollsPerQuery:Number(process.env.MAX_SCROLLS_PER_QUERY||60),
};

const state={version:4,runId:RUN_ID,workerIndex:WORKER_INDEX,workerCount:WORKER_COUNT,startedAt:new Date().toISOString(),finishedAt:null,municipalities:[],errors:[]};
const log=(event,meta={})=>console.log(JSON.stringify({ts:new Date().toISOString(),runId:RUN_ID,worker:WORKER_INDEX,event,...meta}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let lastHeartbeat=0,lastPreview=0,stopRequested=false,completedByWorker=0,ambiguousClaimCount=0;

async function persist(){await fs.mkdir(path.dirname(OUTPUT_PATH),{recursive:true});await fs.writeFile(OUTPUT_PATH,JSON.stringify(state,null,2));}

async function sheet(action,payload={},attempts=6){
  if(!ENDPOINT)throw new Error('SHEET_ENDPOINT non configurato nei GitHub Actions secrets');
  let last;
  for(let i=1;i<=attempts;i++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),60000);
    try{
      const res=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,...payload}),redirect:'follow',signal:controller.signal});
      if(!res.ok)throw new Error(`Sheet bridge HTTP ${res.status}`);
      const text=await res.text();let data;
      try{data=JSON.parse(text);}catch{throw new Error(`Risposta Sheet non JSON: ${text.slice(0,160)}`);}
      if(!data.ok)throw new Error(data.error||`Azione ${action} fallita`);
      return data;
    }catch(err){
      last=err;
      if(i<attempts){
        const delay=Math.min(12000,900*(2**(i-1)))+Math.floor(Math.random()*500);
        log('sheet-retry',{action,attempt:i,error:err?.message||String(err),delayMs:delay});
        await sleep(delay);
      }
    }finally{clearTimeout(timer);}
  }
  throw last;
}

function linkKey(url=''){try{return mapsKey(url,parseCid(url))||'';}catch{return '';}}
function normalizeMapsUrl(url=''){
  try{const u=new URL(url);u.search='';u.hash='';return `${u.origin}${u.pathname}`.replace(/\/$/,'');}
  catch{return String(url||'').split('?')[0].replace(/\/$/,'');}
}
function isTattoo(item){const hay=`${item?.name||''} ${item?.address||''} ${item?.website||''}`.toLowerCase();return /tattoo|tatu|tatou|ink/.test(hay);}

async function heartbeat(extra={},force=false){
  const age=Date.now()-lastHeartbeat;
  if((!force&&age<HEARTBEAT_INTERVAL_MS)||(force&&age<5000))return !stopRequested;
  lastHeartbeat=Date.now();
  try{
    const r=await sheet('heartbeatCloudWorker',{runId:RUN_ID,workerIndex:WORKER_INDEX,leaseSeconds:LEASE_SECONDS,state:extra},3);
    stopRequested=Boolean(r.stopRequested);
  }catch(err){log('heartbeat-error',{error:err.message});}
  return !stopRequested;
}

async function preview(browser,force=false){
  if(!force&&Date.now()-lastPreview<PREVIEW_INTERVAL_MS)return;
  lastPreview=Date.now();
  try{
    const win=browser.window;
    if(!win||win.isDestroyed())return;
    const image=await win.webContents.capturePage();
    let jpeg=image.resize({width:360}).toJPEG(35);
    if(jpeg.length>65000)jpeg=image.resize({width:300}).toJPEG(25);
    const base64=jpeg.toString('base64');
    if(base64.length>90000){log('preview-skipped',{bytes:jpeg.length});return;}
    await sheet('updateCloudPreview',{runId:RUN_ID,workerIndex:WORKER_INDEX,capturedAt:new Date().toISOString(),base64},1);
  }catch(err){log('preview-error',{error:err.message});}
}

async function refreshKnownIndex(knownKeys,knownUrls){
  const index=await sheet('getCloudDedupIndex',{},6);
  knownKeys.clear();knownUrls.clear();
  for(const key of index.mapsKeys||[])if(key)knownKeys.add(String(key));
  for(const url of index.mapsUrls||[])if(url)knownUrls.add(normalizeMapsUrl(url));
  log('dedup-index-loaded',{keys:knownKeys.size,urls:knownUrls.size});
}

async function finishWorker(required=false){
  let lastError=null;
  try{
    const result=await sheet('finishCloudWorker',{runId:RUN_ID,workerIndex:WORKER_INDEX},6);
    if(result?.stale)throw new Error(`finishCloudWorker stale: ${result.status||'UNKNOWN'}`);
    return result;
  }catch(err){
    lastError=err;
    log('finish-worker-error',{error:err?.message||String(err)});
  }

  try{
    const dashboard=await sheet('getCloudDashboardState',{previewTimes:{}},3);
    const worker=(dashboard.workers||[]).find(w=>Number(w?.workerIndex)===WORKER_INDEX);
    if(worker&&String(worker.runId||'')===RUN_ID&&String(worker.status||'')==='DONE'){
      log('finish-worker-verified',{status:worker.status});
      return {verified:true,status:worker.status};
    }
  }catch(err){
    lastError=lastError||err;
    log('finish-worker-verify-error',{error:err?.message||String(err)});
  }

  if(required)throw lastError||new Error('Chiusura worker non confermata dal bridge');
  return null;
}

async function run(){
  if(!Number.isInteger(WORKER_INDEX)||WORKER_INDEX<0||!Number.isInteger(WORKER_COUNT)||![3,5].includes(WORKER_COUNT)||WORKER_INDEX>=WORKER_COUNT)throw new Error(`Worker non valido: ${WORKER_INDEX}/${WORKER_COUNT}`);
  if(!QUERIES.length)throw new Error('Nessuna query Maps configurata');

  await app.whenReady();
  const browser=new MapsBrowserCollector(path.join(os.tmpdir(),`fmi-cloud-${RUN_ID}-${WORKER_INDEX}`),e=>log(`browser:${e.type||'event'}`,e));
  const deadline=Date.now()+MAX_MINUTES*60_000;
  const knownKeys=new Set(),knownUrls=new Set();
  let municipalitiesSinceRefresh=999;

  try{
    await refreshKnownIndex(knownKeys,knownUrls);
    await browser.open();
    await heartbeat({status:'IDLE',phase:'PRONTO',found:0,newCount:0,duplicates:0,foreign:0},true);
    await preview(browser,true);

    while(Date.now()<deadline&&!stopRequested&&(MAX_MUNICIPALITIES_PER_WORKER===0||completedByWorker<MAX_MUNICIPALITIES_PER_WORKER)){
      const claim=await sheet('claimCloudMunicipality',{runId:RUN_ID,workerIndex:WORKER_INDEX,leaseSeconds:LEASE_SECONDS},6);
      if(claim.stopped){stopRequested=true;break;}
      if(claim.retry){
        ambiguousClaimCount=0;
        const wait=Math.max(1500,Math.min(15000,Number(claim.retryAfterMs)||5000));
        log('queue-busy',{retryAfterMs:wait,eligibleTodo:Number(claim.eligibleTodo)||0});
        await sleep(wait);
        continue;
      }
      const municipality=claim.row;
      if(!municipality){
        if(claim.queueExhausted===true){
          ambiguousClaimCount=0;
          log('queue-empty',{queueExhausted:true});
          break;
        }
        ambiguousClaimCount++;
        const wait=Math.min(15000,1500+ambiguousClaimCount*1000);
        log('queue-ambiguous',{queueExhausted:false,attempt:ambiguousClaimCount,retryAfterMs:wait});
        if(ambiguousClaimCount>=12)throw new Error('CLAIM_AMBIGUOUS_RETRY_EXHAUSTED');
        await sleep(wait);
        continue;
      }
      ambiguousClaimCount=0;

      if(municipalitiesSinceRefresh>=5){
        await refreshKnownIndex(knownKeys,knownUrls);
        municipalitiesSinceRefresh=0;
      }

      let found=0,preDuplicates=0,foreign=0;
      const candidates=[],seenThisMunicipality=new Set();
      log('municipality-start',{queueCode:municipality.queueCode,municipalityId:municipality.municipalityId,name:municipality.name,claimToken:municipality.claimToken});
      await heartbeat({status:'WORKING',municipalityId:String(municipality.municipalityId),municipalityName:municipality.name,queueCode:municipality.queueCode,phase:'AVVIO COMUNE',query:'',found:0,newCount:0,duplicates:0,foreign:0},true);

      try{
        for(const variant of QUERIES){
          if(Date.now()>=deadline)throw new Error('__TIME_LIMIT__');
          if(!(await heartbeat({status:'WORKING',phase:'RICERCA',query:variant,found,newCount:0,duplicates:preDuplicates,foreign},true)))throw new Error('__STOP__');

          const query=buildMunicipalityQuery(variant,municipality);
          await heartbeat({phase:'RICERCA MAPS',query},true);
          const search=await browser.collectLinks(query,SETTINGS);
          await preview(browser);
          if(search.verification)throw new Error('GOOGLE_VERIFICATION_REQUIRED');
          const links=search.links||[];found+=links.length;
          log('query-links',{queueCode:municipality.queueCode,query,count:links.length});

          for(let ri=0;ri<links.length;ri++){
            if(Date.now()>=deadline)throw new Error('__TIME_LIMIT__');
            if(stopRequested)throw new Error('__STOP__');
            const link=links[ri],key=linkKey(link),compactUrl=normalizeMapsUrl(link),fingerprint=key||compactUrl;

            if((key&&knownKeys.has(key))||(compactUrl&&knownUrls.has(compactUrl))||(fingerprint&&seenThisMunicipality.has(fingerprint))){
              preDuplicates++;continue;
            }
            if(fingerprint)seenThisMunicipality.add(fingerprint);

            if(ri%8===0){
              const alive=await heartbeat({status:'WORKING',phase:'APERTURA SCHEDE',query,found,newCount:candidates.length,duplicates:preDuplicates,foreign});
              if(!alive)throw new Error('__STOP__');
            }
            const candidate=await browser.extractPlace(link,SETTINGS);
            await preview(browser);
            if(candidate.verification)throw new Error('GOOGLE_VERIFICATION_REQUIRED');
            if(!candidate.name||!isTattoo(candidate))continue;
            if(isExplicitForeign(candidate.address)||isClearlyOutsideItaly(candidate)){foreign++;continue;}
            candidate.mapsKey=candidate.mapsKey||key;
            candidate.mapsUrl=candidate.mapsUrl||link;
            candidates.push(candidate);
          }
        }

        if(!(await heartbeat({status:'WORKING',phase:'DEDUPLICA FINALE',query:'',found,newCount:candidates.length,duplicates:preDuplicates,foreign},true)))throw new Error('__STOP__');
        const finalized=await sheet('finalizeCloudMunicipality',{
          runId:RUN_ID,
          workerIndex:WORKER_INDEX,
          municipalityId:String(municipality.municipalityId),
          claimToken:String(municipality.claimToken||''),
          claimSheetRow:Number(municipality.sheetRow)||0,
          foundCount:found,
          preDuplicateCount:preDuplicates,
          foreignCount:foreign,
          candidates,
          completedAt:new Date().toISOString()
        },6);
        municipalitiesSinceRefresh++;
        completedByWorker++;
        for(const item of finalized.items||[]){
          if(item.mapsKey)knownKeys.add(String(item.mapsKey));
          if(item.mapsUrl)knownUrls.add(normalizeMapsUrl(item.mapsUrl));
        }
        state.municipalities.push({
          queueCode:municipality.queueCode,municipalityId:String(municipality.municipalityId),name:municipality.name,
          foundCount:found,newCount:Number(finalized.inserted)||0,duplicateCount:Number(finalized.duplicates)||0,foreignCount:foreign,completedAt:finalized.completedAt,
          replayed:Boolean(finalized.alreadyFinalized)
        });
        await persist();
        log('municipality-complete',{queueCode:municipality.queueCode,found,newCount:finalized.inserted,duplicates:finalized.duplicates,foreign,replayed:Boolean(finalized.alreadyFinalized)});
        await heartbeat({status:'IDLE',phase:'COMUNE COMPLETATO',query:'',found,newCount:Number(finalized.inserted)||0,duplicates:Number(finalized.duplicates)||0,foreign},true);
      }catch(err){
        const code=err?.message||String(err);
        if(code==='__STOP__'||code==='__TIME_LIMIT__'){
          log(code==='__STOP__'?'stop-requested':'time-limit',{queueCode:municipality.queueCode});
          break;
        }
        try{
          await sheet('failCloudMunicipality',{
            runId:RUN_ID,
            workerIndex:WORKER_INDEX,
            municipalityId:String(municipality.municipalityId),
            claimToken:String(municipality.claimToken||''),
            claimSheetRow:Number(municipality.sheetRow)||0,
            error:code
          },4);
        }catch(failErr){log('fail-report-error',{queueCode:municipality.queueCode,error:failErr?.message||String(failErr)});}
        state.errors.push({queueCode:municipality.queueCode,municipalityId:String(municipality.municipalityId),error:code});
        await persist();
        log('municipality-error',{queueCode:municipality.queueCode,error:code});
        if(code==='GOOGLE_VERIFICATION_REQUIRED')break;
      }
    }
  }finally{
    await preview(browser,true).catch(()=>{});
    await browser.close().catch(()=>{});
    state.finishedAt=new Date().toISOString();await persist();
    await finishWorker(true);
    log('worker-done',{municipalities:state.municipalities.length,completedByWorker,limit:MAX_MUNICIPALITIES_PER_WORKER,errors:state.errors.length,stopped:stopRequested});
  }
}

run().then(()=>app.quit()).catch(async err=>{
  state.errors.push({municipalityId:'',error:err?.message||String(err)});state.finishedAt=new Date().toISOString();
  await persist().catch(()=>{});
  await finishWorker(false);
  console.error(err?.stack||err);app.exit(1);
});
