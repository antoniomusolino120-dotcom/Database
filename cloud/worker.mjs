import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { MapsBrowserCollector } from '../main/services/browserCollector.js';
import { buildMunicipalityQuery } from '../main/services/municipalities.js';
import { mapsKey, parseCid } from '../main/utils/normalize.js';
import { isExplicitForeign } from '../main/utils/location.js';

app.disableHardwareAcceleration();

const ENDPOINT=String(process.env.SHEET_ENDPOINT||'').trim();
const WORKER_INDEX=Number(process.env.WORKER_INDEX||0);
const WORKER_COUNT=Number(process.env.WORKER_COUNT||3);
const MAX_MINUTES=Math.min(330,Math.max(5,Number(process.env.MAX_MINUTES||300)));
const BATCH_SIZE=Math.max(1,Math.min(25,Number(process.env.WORK_BATCH_SIZE||8)));
const OUTPUT_PATH=String(process.env.OUTPUT_PATH||path.join('cloud-output',`worker-${WORKER_INDEX}.json`));
const QUERIES=String(process.env.MAPS_QUERIES||'tattoo,tatuatore,tattoo studio,studio tatuaggi,tattoo artist').split(',').map(x=>x.trim()).filter(Boolean);
const SETTINGS={
  minDelayMs:Number(process.env.MIN_DELAY_MS||1100),
  maxDelayMs:Number(process.env.MAX_DELAY_MS||2600),
  minScrollDelayMs:Number(process.env.MIN_SCROLL_DELAY_MS||900),
  maxScrollDelayMs:Number(process.env.MAX_SCROLL_DELAY_MS||1900),
  maxResultsPerQuery:Number(process.env.MAX_RESULTS_PER_QUERY||300),
  maxScrollsPerQuery:Number(process.env.MAX_SCROLLS_PER_QUERY||60),
};

const state={version:2,workerIndex:WORKER_INDEX,workerCount:WORKER_COUNT,startedAt:new Date().toISOString(),finishedAt:null,municipalities:[],candidates:[],errors:[]};
const log=(event,meta={})=>console.log(JSON.stringify({ts:new Date().toISOString(),worker:WORKER_INDEX,event,...meta}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function persist(){await fs.mkdir(path.dirname(OUTPUT_PATH),{recursive:true});await fs.writeFile(OUTPUT_PATH,JSON.stringify(state,null,2));}

async function sheet(action,payload={},attempts=4){
  if(!ENDPOINT) throw new Error('SHEET_ENDPOINT non configurato nei GitHub Actions secrets');
  let last;
  for(let i=1;i<=attempts;i++){
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),45000);
    try{
      const res=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,...payload}),redirect:'follow',signal:controller.signal});
      if(!res.ok) throw new Error(`Sheet bridge HTTP ${res.status}`);
      const text=await res.text(); let data;
      try{data=JSON.parse(text);}catch{throw new Error(`Risposta Sheet non JSON: ${text.slice(0,160)}`);}
      if(!data.ok) throw new Error(data.error||`Azione ${action} fallita`);
      return data;
    }catch(err){last=err;if(i<attempts)await sleep(800*i);}
    finally{clearTimeout(timer);}
  }
  throw last;
}

function linkKey(url=''){try{return mapsKey(url,parseCid(url))||'';}catch{return '';}}
function normalizeMapsUrl(url=''){
  try{const u=new URL(url);u.search='';u.hash='';return `${u.origin}${u.pathname}`.replace(/\/$/,'');}
  catch{return String(url||'').split('?')[0].replace(/\/$/,'');}
}
function isTattoo(item){const hay=`${item?.name||''} ${item?.address||''} ${item?.website||''}`.toLowerCase();return /tattoo|tatu|tatou|ink/.test(hay);}

async function run(){
  if(!Number.isInteger(WORKER_INDEX)||WORKER_INDEX<0||!Number.isInteger(WORKER_COUNT)||WORKER_COUNT<1||WORKER_INDEX>=WORKER_COUNT) throw new Error(`Shard non valido: ${WORKER_INDEX}/${WORKER_COUNT}`);
  if(!QUERIES.length) throw new Error('Nessuna query Maps configurata');

  await app.whenReady();
  const browser=new MapsBrowserCollector(path.join(os.tmpdir(),`fmi-cloud-${WORKER_INDEX}`),e=>log(`browser:${e.type||'event'}`,e));
  const deadline=Date.now()+MAX_MINUTES*60_000;
  const knownKeys=new Set(),knownUrls=new Set();
  let cursor=1,halt=false;

  try{
    const index=await sheet('getCloudDedupIndex');
    for(const key of index.mapsKeys||[])if(key)knownKeys.add(String(key));
    for(const url of index.mapsUrls||[])if(url)knownUrls.add(normalizeMapsUrl(url));
    log('dedup-index-loaded',{keys:knownKeys.size,urls:knownUrls.size});
    await browser.open();

    while(Date.now()<deadline&&!halt){
      const work=await sheet('getCloudWork',{workerIndex:WORKER_INDEX,workerCount:WORKER_COUNT,limit:BATCH_SIZE,afterRow:cursor});
      const municipalities=work.rows||[];
      if(!municipalities.length){log('queue-empty');break;}

      for(const municipality of municipalities){
        cursor=Math.max(cursor,Number(municipality.sheetRow)||cursor);
        if(Date.now()>=deadline){halt=true;break;}
        let found=0,preDuplicates=0,foreign=0,candidateCount=0;
        const seenThisMunicipality=new Set();
        log('municipality-start',{queueCode:municipality.queueCode,municipalityId:municipality.municipalityId,name:municipality.name});
        try{
          for(const variant of QUERIES){
            if(Date.now()>=deadline)throw new Error('__TIME_LIMIT__');
            const query=buildMunicipalityQuery(variant,municipality);
            const search=await browser.collectLinks(query,SETTINGS);
            if(search.verification)throw new Error('GOOGLE_VERIFICATION_REQUIRED');
            const links=search.links||[];found+=links.length;
            log('query-links',{queueCode:municipality.queueCode,query,count:links.length});

            for(const link of links){
              if(Date.now()>=deadline)throw new Error('__TIME_LIMIT__');
              const key=linkKey(link),compactUrl=normalizeMapsUrl(link),localFingerprint=key||compactUrl;
              if((key&&knownKeys.has(key))||(compactUrl&&knownUrls.has(compactUrl))||(localFingerprint&&seenThisMunicipality.has(localFingerprint))){preDuplicates++;continue;}
              if(localFingerprint)seenThisMunicipality.add(localFingerprint);

              const candidate=await browser.extractPlace(link,SETTINGS);
              if(candidate.verification)throw new Error('GOOGLE_VERIFICATION_REQUIRED');
              if(!candidate.name||!isTattoo(candidate))continue;
              if(isExplicitForeign(candidate.address)){foreign++;continue;}
              candidate.mapsKey=candidate.mapsKey||key;
              candidate.mapsUrl=candidate.mapsUrl||link;
              state.candidates.push({workerIndex:WORKER_INDEX,municipalityId:String(municipality.municipalityId),queueCode:municipality.queueCode,sourceQuery:query,row:candidate});
              candidateCount++;
            }
          }

          state.municipalities.push({sheetRow:municipality.sheetRow,queueCode:municipality.queueCode,municipalityId:String(municipality.municipalityId),name:municipality.name,foundCount:found,preDuplicateCount:preDuplicates,foreignCount:foreign,candidateCount});
          log('municipality-collected',{queueCode:municipality.queueCode,found,preDuplicates,foreign,candidateCount});
          await persist();
        }catch(err){
          const message=err.message==='__TIME_LIMIT__'?'Interrotto per limite temporale GitHub Actions':err.message;
          state.errors.push({sheetRow:municipality.sheetRow,queueCode:municipality.queueCode,municipalityId:String(municipality.municipalityId),error:message});
          log('municipality-error',{queueCode:municipality.queueCode,error:message});
          await persist();
          if(err.message==='__TIME_LIMIT__'||err.message==='GOOGLE_VERIFICATION_REQUIRED'){halt=true;break;}
        }
      }
    }
  }finally{
    await browser.close().catch(()=>{});
    state.finishedAt=new Date().toISOString();
    await persist();
    log('worker-done',{municipalities:state.municipalities.length,candidates:state.candidates.length,errors:state.errors.length});
  }
}

run().then(()=>app.quit()).catch(async err=>{
  state.errors.push({municipalityId:'',error:err?.message||String(err)});
  state.finishedAt=new Date().toISOString();
  await persist().catch(()=>{});
  console.error(err?.stack||err);
  app.exit(1);
});
