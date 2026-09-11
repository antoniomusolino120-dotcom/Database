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
const WORKER_COUNT=Number(process.env.WORKER_COUNT||10);
const WORKER_GENERATION=Math.max(1,Number(process.env.WORKER_GENERATION||1));
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

const state={version:5,runId:RUN_ID,workerIndex:WORKER_INDEX,workerCount:WORKER_COUNT,generation:WORKER_GENERATION,startedAt:new Date().toISOString(),deadlineAt:null,finishedAt:null,municipalities:[],errors:[]};
const log=(event,meta={})=>console.log(JSON.stringify({ts:new Date().toISOString(),runId:RUN_ID,worker:WORKER_INDEX,generation:WORKER_GENERATION,event,...meta}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let lastHeartbeat=0,lastPreview=0,stopRequested=false,drainReason='',closeReason='COMPLETE',completedByWorker=0,ambiguousClaimCount=0;
let centralDeadlineMs=0,hardDeadlineMs=0,deadlineTimer=null,previewTimer=null,previewStartTimer=null,previewInFlight=false;

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
function closingStatus(){return drainReason==='PAUSE'?'PAUSING':drainReason==='TIME_LIMIT'?'CLOSING':'STOPPING';}
function closingPhase(base=''){const prefix=drainReason==='PAUSE'?'PAUSA RICHIESTA':drainReason==='TIME_LIMIT'?'CHIUSURA 5H':'ARRESTO RICHIESTO';return base?`${prefix} · ${base}`:prefix;}

function applyControl(response){
  if(response?.stale){stopRequested=true;closeReason='STALE';return;}
  const command=String(response?.command||'').toUpperCase();
  if(command==='STOP'||response?.stopRequested){stopRequested=true;closeReason='STOP';return;}
  if(command==='PAUSE'&&!drainReason){drainReason='PAUSE';closeReason='PAUSE';log('pause-requested');}
  if(command==='TIME_LIMIT'&&!drainReason){drainReason='TIME_LIMIT';closeReason='TIME_LIMIT';log('time-limit-requested');}
}

async function heartbeat(extra={},force=false,critical=false){
  const age=Date.now()-lastHeartbeat;
  if(!critical&&((!force&&age<HEARTBEAT_INTERVAL_MS)||(force&&age<5000)))return !stopRequested;
  lastHeartbeat=Date.now();
  const outgoing={...extra};
  if(drainReason&&!stopRequested){
    outgoing.status=closingStatus();
    outgoing.phase=closingPhase(outgoing.phase||'TERMINO COMUNE');
  }
  try{
    const r=await sheet('heartbeatCloudWorker',{runId:RUN_ID,workerIndex:WORKER_INDEX,generation:WORKER_GENERATION,leaseSeconds:LEASE_SECONDS,state:outgoing},3);
    applyControl(r);
  }catch(err){log('heartbeat-error',{error:err.message});}
  return !stopRequested;
}

async function preview(browser,force=false){
  if(!force&&Date.now()-lastPreview<PREVIEW_INTERVAL_MS)return;
  lastPreview=Date.now();
  try{
    const win=browser?.window;
    if(!win||win.isDestroyed())return;
    const image=await win.webContents.capturePage();
    let jpeg=image.resize({width:360}).toJPEG(35);
    if(jpeg.length>65000)jpeg=image.resize({width:300}).toJPEG(25);
    const base64=jpeg.toString('base64');
    if(base64.length>90000){log('preview-skipped',{bytes:jpeg.length});return;}
    await sheet('updateCloudPreview',{runId:RUN_ID,workerIndex:WORKER_INDEX,generation:WORKER_GENERATION,capturedAt:new Date().toISOString(),base64},1);
  }catch(err){log('preview-error',{error:err.message});}
}

function stopPreviewLoop(){
  if(previewStartTimer){clearTimeout(previewStartTimer);previewStartTimer=null;}
  if(previewTimer){clearInterval(previewTimer);previewTimer=null;}
}
function startPreviewLoop(browser){
  stopPreviewLoop();
  const offset=Math.min(PREVIEW_INTERVAL_MS-5000,5000+(WORKER_INDEX%10)*5000);
  const capture=()=>{
    if(previewInFlight)return;
    previewInFlight=true;
    preview(browser,true).catch(()=>{}).finally(()=>{previewInFlight=false;});
  };
  previewStartTimer=setTimeout(()=>{
    capture();
    previewTimer=setInterval(capture,PREVIEW_INTERVAL_MS);
  },Math.max(1000,offset));
}

function scheduleDeadline(){
  if(deadlineTimer)clearTimeout(deadlineTimer);
  const wait=Math.max(0,centralDeadlineMs-Date.now());
  deadlineTimer=setTimeout(()=>{
    if(stopRequested||drainReason)return;
    drainReason='TIME_LIMIT';closeReason='TIME_LIMIT';
    log('time-limit-reached',{deadlineAt:state.deadlineAt});
    void heartbeat({status:'CLOSING',phase:'LIMITE 5H · TERMINO COMUNE'},true,true);
  },wait);
}

async function refreshKnownIndex(knownKeys,knownUrls){
  const index=await sheet('getCloudDedupIndex',{},6);
  knownKeys.clear();knownUrls.clear();
  for(const key of index.mapsKeys||[])if(key)knownKeys.add(String(key));
  for(const url of index.mapsUrls||[])if(url)knownUrls.add(normalizeMapsUrl(url));
  log('dedup-index-loaded',{keys:knownKeys.size,urls:knownUrls.size});
}

async function finishWorker(required=false,reason=closeReason){
  let lastError=null;
  try{
    const result=await sheet('finishCloudWorker',{runId:RUN_ID,workerIndex:WORKER_INDEX,generation:WORKER_GENERATION,reason},6);
    if(result?.stale)throw new Error(`finishCloudWorker stale: ${result.status||'UNKNOWN'}`);
    return result;
  }catch(err){
    lastError=err;
    log('finish-worker-error',{error:err?.message||String(err)});
  }

  try{
    const dashboard=await sheet('getCloudDashboardState',{previewTimes:{}},3);
    const worker=(dashboard.workers||[]).find(w=>Number(w?.workerIndex)===WORKER_INDEX);
    if(worker&&String(worker.runId||'')===RUN_ID&&Number(worker.generation||1)===WORKER_GENERATION&&['DONE','READY'].includes(String(worker.status||''))){
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
  if(!Number.isInteger(WORKER_INDEX)||WORKER_INDEX<0||!Number.isInteger(WORKER_COUNT)||![5,10].includes(WORKER_COUNT)||WORKER_INDEX>=WORKER_COUNT)throw new Error(`Worker non valido: ${WORKER_INDEX}/${WORKER_COUNT}`);
  if(!QUERIES.length)throw new Error('Nessuna query Maps configurata');

  await app.whenReady();
  const dashboard=await sheet('getCloudDashboardState',{previewTimes:{}},6);
  const runState=dashboard.run||{};
  if(String(runState.runId||'')!==RUN_ID)throw new Error('Run cloud non più autorevole');
  const authoritativeWorker=(dashboard.workers||[]).find(w=>Number(w?.workerIndex)===WORKER_INDEX);
  if(authoritativeWorker&&Number(authoritativeWorker.generation||1)!==WORKER_GENERATION)throw new Error('Generazione worker non più autorevole');
  centralDeadlineMs=Date.parse(runState.deadlineAt||'')||Date.now()+MAX_MINUTES*60_000;
  hardDeadlineMs=centralDeadlineMs+30*60_000;
  state.deadlineAt=new Date(centralDeadlineMs).toISOString();
  if(Date.now()>=centralDeadlineMs){
    closeReason='TIME_LIMIT';drainReason='TIME_LIMIT';
    await persist();
    await finishWorker(true,'TIME_LIMIT');
    return;
  }
  scheduleDeadline();

  const browser=new MapsBrowserCollector(path.join(os.tmpdir(),`fmi-cloud-${RUN_ID}-${WORKER_INDEX}-g${WORKER_GENERATION}`),e=>log(`browser:${e.type||'event'}`,e));
  const knownKeys=new Set(),knownUrls=new Set();
  let municipalitiesSinceRefresh=999;

  try{
    await refreshKnownIndex(knownKeys,knownUrls);
    await browser.open();
    startPreviewLoop(browser);
    await heartbeat({status:'IDLE',phase:'PRONTO',found:0,newCount:0,duplicates:0,foreign:0},true,true);

    while(!stopRequested&&(MAX_MUNICIPALITIES_PER_WORKER===0||completedByWorker<MAX_MUNICIPALITIES_PER_WORKER)){
      if(drainReason)break;
      if(Date.now()>=centralDeadlineMs){drainReason='TIME_LIMIT';closeReason='TIME_LIMIT';break;}

      const claim=await sheet('claimCloudMunicipality',{runId:RUN_ID,workerIndex:WORKER_INDEX,generation:WORKER_GENERATION,leaseSeconds:LEASE_SECONDS},6);
      applyControl(claim);
      if(claim.stopped||stopRequested||drainReason)break;
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
          ambiguousClaimCount=0;closeReason='QUEUE_COMPLETE';
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
      await heartbeat({status:'WORKING',municipalityId:String(municipality.municipalityId),municipalityName:municipality.name,queueCode:municipality.queueCode,phase:'AVVIO COMUNE',query:'',found:0,newCount:0,duplicates:0,foreign:0},true,true);

      try{
        for(let qi=0;qi<QUERIES.length;qi++){
          if(Date.now()>=hardDeadlineMs)throw new Error('__HARD_LIMIT__');
          const variant=QUERIES[qi];
          if(!(await heartbeat({status:'WORKING',phase:`RICERCA ${qi+1}/${QUERIES.length}`,query:variant,found,newCount:candidates.length,duplicates:preDuplicates,foreign},true)))throw new Error('__STOP__');

          const query=buildMunicipalityQuery(variant,municipality);
          await heartbeat({status:'WORKING',phase:`RICERCA MAPS · ${qi+1}/${QUERIES.length}`,query,found,newCount:candidates.length,duplicates:preDuplicates,foreign},true);
          const search=await browser.collectLinks(query,SETTINGS);
          if(search.verification)throw new Error('GOOGLE_VERIFICATION_REQUIRED');
          const links=search.links||[];found+=links.length;
          log('query-links',{queueCode:municipality.queueCode,query,count:links.length});

          for(let ri=0;ri<links.length;ri++){
            if(Date.now()>=hardDeadlineMs)throw new Error('__HARD_LIMIT__');
            if(stopRequested)throw new Error('__STOP__');
            const link=links[ri],key=linkKey(link),compactUrl=normalizeMapsUrl(link),fingerprint=key||compactUrl;

            if((key&&knownKeys.has(key))||(compactUrl&&knownUrls.has(compactUrl))||(fingerprint&&seenThisMunicipality.has(fingerprint))){
              preDuplicates++;continue;
            }
            if(fingerprint)seenThisMunicipality.add(fingerprint);

            if(ri%8===0){
              const alive=await heartbeat({status:'WORKING',phase:`ANALISI SCHEDE · ${Math.min(ri+1,links.length)}/${links.length}`,query,found,newCount:candidates.length,duplicates:preDuplicates,foreign});
              if(!alive)throw new Error('__STOP__');
            }
            const candidate=await browser.extractPlace(link,SETTINGS);
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
          generation:WORKER_GENERATION,
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
        await heartbeat({status:'IDLE',phase:'COMUNE COMPLETATO',query:'',found,newCount:Number(finalized.inserted)||0,duplicates:Number(finalized.duplicates)||0,foreign},true,true);
      }catch(err){
        const code=err?.message||String(err);
        if(code==='__STOP__'||code==='__HARD_LIMIT__'){
          if(code==='__HARD_LIMIT__'){drainReason='TIME_LIMIT';closeReason='TIME_LIMIT';}
          log(code==='__STOP__'?'stop-requested':'hard-time-limit',{queueCode:municipality.queueCode});
          break;
        }
        try{
          await sheet('failCloudMunicipality',{
            runId:RUN_ID,
            workerIndex:WORKER_INDEX,
            generation:WORKER_GENERATION,
            municipalityId:String(municipality.municipalityId),
            claimToken:String(municipality.claimToken||''),
            claimSheetRow:Number(municipality.sheetRow)||0,
            error:code
          },4);
        }catch(failErr){log('fail-report-error',{queueCode:municipality.queueCode,error:failErr?.message||String(failErr)});}
        state.errors.push({queueCode:municipality.queueCode,municipalityId:String(municipality.municipalityId),error:code});
        await persist();
        log('municipality-error',{queueCode:municipality.queueCode,error:code});
        if(code==='GOOGLE_VERIFICATION_REQUIRED'){closeReason='ERROR';break;}
      }
    }
  }finally{
    if(deadlineTimer){clearTimeout(deadlineTimer);deadlineTimer=null;}
    stopPreviewLoop();
    const phase=closeReason==='PAUSE'?'PAUSA · CHIUSURA CHROMIUM':closeReason==='TIME_LIMIT'?'5H RAGGIUNTE · CHIUSURA CHROMIUM':closeReason==='STOP'?'ARRESTO · CHIUSURA CHROMIUM':'CHIUSURA CHROMIUM';
    await heartbeat({status:closeReason==='PAUSE'?'PAUSING':'STOPPING',phase,query:''},true,true).catch(()=>{});
    await browser.close().catch(()=>{});
    state.finishedAt=new Date().toISOString();await persist();
    await finishWorker(true,closeReason);
    log('worker-done',{municipalities:state.municipalities.length,completedByWorker,limit:MAX_MUNICIPALITIES_PER_WORKER,errors:state.errors.length,stopped:stopRequested,drainReason,closeReason});
  }
}

run().then(()=>app.quit()).catch(async err=>{
  state.errors.push({municipalityId:'',error:err?.message||String(err)});state.finishedAt=new Date().toISOString();
  await persist().catch(()=>{});
  await finishWorker(false,'ERROR');
  console.error(err?.stack||err);app.exit(1);
});
