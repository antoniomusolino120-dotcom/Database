import fs from 'node:fs/promises';
import path from 'node:path';
import { deduplicateCandidates } from './dedup.mjs';

const ENDPOINT=String(process.env.SHEET_ENDPOINT||'').trim();
const ARTIFACT_ROOT=String(process.env.ARTIFACT_ROOT||'cloud-artifacts');
const APPLY_BATCH_SIZE=Math.max(1,Math.min(100,Number(process.env.FINAL_BATCH_SIZE||50)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(event,meta={})=>console.log(JSON.stringify({ts:new Date().toISOString(),role:'finalizer',event,...meta}));

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

async function jsonFiles(dir){
  const out=[];
  async function walk(p){
    for(const e of await fs.readdir(p,{withFileTypes:true})){
      const full=path.join(p,e.name);
      if(e.isDirectory())await walk(full);
      else if(e.isFile()&&e.name.endsWith('.json'))out.push(full);
    }
  }
  await walk(dir); return out.sort();
}
function statFor(stats,id){return stats[id]||{newCount:0,finalDuplicates:0};}

async function main(){
  const files=await jsonFiles(ARTIFACT_ROOT);
  if(!files.length)throw new Error(`Nessun artifact worker trovato in ${ARTIFACT_ROOT}`);
  const outputs=[];
  for(const file of files){
    const parsed=JSON.parse(await fs.readFile(file,'utf8'));
    if(parsed&&Array.isArray(parsed.municipalities)&&Array.isArray(parsed.candidates))outputs.push(parsed);
  }
  if(!outputs.length)throw new Error('Artifact worker non validi');

  const successful=new Map(),errors=new Map(),candidates=[];
  for(const output of outputs){
    for(const m of output.municipalities||[])successful.set(String(m.municipalityId),m);
    for(const e of output.errors||[])if(e.municipalityId)errors.set(String(e.municipalityId),e);
  }
  for(const output of outputs)for(const c of output.candidates||[])if(successful.has(String(c.municipalityId)))candidates.push(c);
  for(const id of successful.keys())errors.delete(id);
  log('artifacts-loaded',{workers:outputs.length,municipalities:successful.size,candidates:candidates.length,errors:errors.size});

  const snapshot=await sheet('getCloudMasterSnapshot');
  const dedup=deduplicateCandidates(snapshot.rows||[],candidates);
  log('dedup-complete',{masterRows:(snapshot.rows||[]).length,canonicalActions:dedup.actions.length});

  for(let i=0;i<dedup.actions.length;i+=APPLY_BATCH_SIZE){
    const chunk=dedup.actions.slice(i,i+APPLY_BATCH_SIZE);
    const applied=await sheet('upsertCloudMastersFinal',{rows:chunk.map(a=>a.row)});
    const items=applied.items||[];
    for(let j=0;j<chunk.length;j++){
      const action=chunk[j],actual=items[j]?.mode;
      if(!actual||actual===action.expectedMode)continue;
      const s=dedup.municipalityStats[action.originMunicipalityId]||={newCount:0,finalDuplicates:0};
      if(action.expectedMode==='inserted'&&actual==='updated'){s.newCount=Math.max(0,s.newCount-1);s.finalDuplicates++;}
      else if(action.expectedMode==='updated'&&actual==='inserted'){s.finalDuplicates=Math.max(0,s.finalDuplicates-1);s.newCount++;}
    }
    log('master-batch-applied',{from:i,count:chunk.length});
  }

  const ordered=[...successful.values()].sort((a,b)=>(Number(a.sheetRow)||0)-(Number(b.sheetRow)||0));
  for(const m of ordered){
    const d=statFor(dedup.municipalityStats,String(m.municipalityId));
    await sheet('completeCloudMunicipality',{municipalityId:String(m.municipalityId),foundCount:Number(m.foundCount)||0,newCount:Number(d.newCount)||0,duplicateCount:(Number(m.preDuplicateCount)||0)+(Number(d.finalDuplicates)||0),foreignCount:Number(m.foreignCount)||0,completedAt:new Date().toISOString()});
  }
  for(const e of errors.values())await sheet('failCloudMunicipality',{municipalityId:String(e.municipalityId),error:e.error}).catch(()=>{});
  log('finalized',{municipalities:ordered.length,errors:errors.size});
}

main().catch(err=>{console.error(err?.stack||err);process.exitCode=1;});
