const SPREADSHEET_ID = '1pXRJuIKS9OgdGQI8o3273Y8fVyjm_IIjC0YyLPw4y6g';
const HEADERS = {
  MASTER: ['ID','Nome','Telefono','Sito','Indirizzo','Latitudine','Longitudine','Maps Key','Maps URL','First Seen','Last Seen'],
  COMUNI: ['Codice Coda','Municipality ID','Comune','Provincia','Sigla','Regione','Status','Trovati','Nuovi','Duplicati','Esteri scartati','Ultima scansione','Errore'],
  JOB_STATE: ['Key','Value','Updated At'],
  DA_VERIFICARE: ['ID','Nome','Telefono','Sito','Indirizzo','Latitudine','Longitudine','Motivo','Maps URL'],
  LOG: ['Timestamp','Level','Message']
};

const CLOUD_RUN_KEY = 'CLOUD_RUN';
const CLOUD_WORKER_PREFIX = 'CLOUD_WORKER_';
const CLOUD_PREVIEW_PREFIX = 'cloud-preview:';
const CLOUD_DASHBOARD_CACHE = 'cloud-dashboard-summary';
const CLOUD_DEFAULT_LEASE_SECONDS = 900;
const CLOUD_PENDING_START_KEY = 'CLOUD_PENDING_START';
const GITHUB_OWNER = 'antoniomusolino120-dotcom';
const GITHUB_REPO = 'Database';
const GITHUB_WORKFLOW = 'cloud-collector.yml';
const GITHUB_REF = 'main';

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function book_(){return SpreadsheetApp.openById(SPREADSHEET_ID);}
function ensureSheet_(name,headers){
  const ss=book_(); let sh=ss.getSheetByName(name); if(!sh)sh=ss.insertSheet(name);
  if(sh.getLastRow()===0)sh.getRange(1,1,1,headers.length).setValues([headers]);
  return sh;
}
function ensureAll_(){Object.keys(HEADERS).forEach(k=>ensureSheet_(k,HEADERS[k]));}
function findRow_(sh,col,value){
  if(!value||sh.getLastRow()<2)return -1;
  const finder=sh.getRange(2,col,sh.getLastRow()-1,1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  return finder?finder.getRow():-1;
}
function masterValues_(r){return [r.id||'',r.name||'',r.phone||'',r.website||'',r.address||'',r.lat??'',r.lng??'',r.mapsKey||'',r.mapsUrl||'',r.firstSeen||'',r.lastSeen||''];}
function municipalityValues_(r){return [r.queueCode||'',r.municipalityId||'',r.name||'',r.province||'',r.provinceCode||'',r.region||'',r.status||'',r.foundCount??0,r.newCount??0,r.duplicateCount??0,r.foreignCount??0,r.lastScanAt||'',r.errorText||''];}
function municipalityObject_(r,sheetRow,claimToken){return {sheetRow,queueCode:String(r[0]||''),municipalityId:String(r[1]||''),name:String(r[2]||''),province:String(r[3]||''),provinceCode:String(r[4]||''),region:String(r[5]||''),status:String(r[6]||''),lastScanAt:r[11]||'',claimToken:String(claimToken||'')};}

function upsertMaster_(r){return upsertMasters_([r])[0];}
function upsertMasters_(rows){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER);
  const last=sh.getLastRow(); const values=last>=2?sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues():[];
  const byId={}; const byKey={}; values.forEach((r,i)=>{if(r[0])byId[String(r[0])]=i+2;if(r[7])byKey[String(r[7])]=i+2;});
  const out=[]; const appends=[];
  rows.forEach(r=>{
    let row=(r.id&&byId[String(r.id)])||(r.mapsKey&&byKey[String(r.mapsKey)])||-1;
    if(row>0){sh.getRange(row,1,1,HEADERS.MASTER.length).setValues([masterValues_(r)]);out.push({mode:'updated',sheetRow:row});}
    else{
      appends.push(r);const newRow=last+appends.length;out.push({mode:'inserted',sheetRow:newRow});
      if(r.id)byId[String(r.id)]=newRow;if(r.mapsKey)byKey[String(r.mapsKey)]=newRow;
    }
  });
  if(appends.length)sh.getRange(last+1,1,appends.length,HEADERS.MASTER.length).setValues(appends.map(masterValues_));
  return out;
}

function upsertMunicipality_(r){return upsertMunicipalities_([r])[0];}
function upsertMunicipalities_(rows){
  const sh=ensureSheet_('COMUNI',HEADERS.COMUNI); const last=sh.getLastRow();
  const existing=last>=2?sh.getRange(2,2,last-1,1).getValues():[]; const byId={}; existing.forEach((r,i)=>{if(r[0])byId[String(r[0])]=i+2;});
  const result=[]; const appends=[];
  rows.forEach(r=>{
    const row=r.municipalityId&&byId[String(r.municipalityId)];
    if(row){sh.getRange(row,1,1,HEADERS.COMUNI.length).setValues([municipalityValues_(r)]);result.push({mode:'updated',sheetRow:row});}
    else{appends.push(r);const nr=last+appends.length;result.push({mode:'inserted',sheetRow:nr});if(r.municipalityId)byId[String(r.municipalityId)]=nr;}
  });
  if(appends.length)sh.getRange(last+1,1,appends.length,HEADERS.COMUNI.length).setValues(appends.map(municipalityValues_));
  return result;
}

function setJobState_(state){
  const sh=ensureSheet_('JOB_STATE',HEADERS.JOB_STATE); const now=new Date();
  Object.keys(state||{}).forEach(key=>{
    let row=findRow_(sh,1,key);if(row<0)row=sh.getLastRow()+1;
    const value=typeof state[key]==='object'?JSON.stringify(state[key]):String(state[key]??'');
    sh.getRange(row,1,1,3).setValues([[key,value,now]]);
  });
}
function getJobStateValue_(key){
  const sh=ensureSheet_('JOB_STATE',HEADERS.JOB_STATE);
  const row=findRow_(sh,1,key); if(row<0)return null;
  const raw=sh.getRange(row,2).getValue();
  if(raw===''||raw===null||raw===undefined)return null;
  try{return JSON.parse(String(raw));}catch{return raw;}
}
function clearDashboardCache_(){CacheService.getScriptCache().remove(CLOUD_DASHBOARD_CACHE);}
function workerKey_(idx){return CLOUD_WORKER_PREFIX+String(idx);}
function nowIso_(){return new Date().toISOString();}
function newClaimToken_(){return Utilities.getUuid();}

function normalizedMapsUrl_(url){return String(url||'').trim().split('#')[0].split('?')[0].replace(/\/$/,'');}
function normalizedPhone_(phone){
  const raw=String(phone??'').trim();
  let digits=raw.replace(/\D/g,'');
  if(/^\+\s*39/.test(raw))digits=digits.slice(2);
  else if(digits.indexOf('0039')===0)digits=digits.slice(4);
  return digits;
}
function normalizedText_(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function normalizedDomain_(website){
  let s=String(website||'').trim().toLowerCase();if(!s)return '';
  return s.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split('?')[0].split('#')[0];
}
function masterFingerprint_(r){
  const name=normalizedText_(r.name),address=normalizedText_(r.address),domain=normalizedDomain_(r.website);
  return {
    mapsKey:String(r.mapsKey||'').trim(),
    mapsUrl:normalizedMapsUrl_(r.mapsUrl),
    phone:normalizedPhone_(r.phone),
    nameAddress:name&&address?name+'\u0000'+address:'',
    nameDomain:name&&domain?name+'\u0000'+domain:''
  };
}
function masterObjectFromValues_(r,sheetRow){
  return {sheetRow,id:String(r[0]||''),name:String(r[1]||''),phone:String(r[2]||''),website:String(r[3]||''),address:String(r[4]||''),lat:r[5]??'',lng:r[6]??'',mapsKey:String(r[7]||''),mapsUrl:String(r[8]||''),firstSeen:String(r[9]||''),lastSeen:String(r[10]||'')};
}
function getCloudDedupIndex_(){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER),last=sh.getLastRow();if(last<2)return {mapsKeys:[],mapsUrls:[]};
  const values=sh.getRange(2,8,last-1,2).getValues(),keys=[],urls=[];
  values.forEach(r=>{if(r[0])keys.push(String(r[0]));if(r[1])urls.push(String(r[1]));});
  return {mapsKeys:keys,mapsUrls:urls};
}
function getCloudMasterSnapshot_(){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER),last=sh.getLastRow();if(last<2)return [];
  return sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues().map((r,i)=>masterObjectFromValues_(r,i+2));
}
function nextFmiNumber_(values){
  let max=0;values.forEach(r=>{const m=String(r[0]||'').match(/^FMI-(\d+)$/i);if(m)max=Math.max(max,Number(m[1])||0);});
  return max+1;
}
function mergeMaster_(current,candidate,now){
  return {
    id:String(current.id||candidate.id||''),
    name:String(current.name||candidate.name||''),
    phone:String(current.phone||candidate.phone||''),
    website:String(current.website||candidate.website||''),
    address:String(current.address||candidate.address||''),
    lat:current.lat!==''&&current.lat!==null&&current.lat!==undefined?current.lat:(candidate.lat??''),
    lng:current.lng!==''&&current.lng!==null&&current.lng!==undefined?current.lng:(candidate.lng??''),
    mapsKey:String(current.mapsKey||candidate.mapsKey||''),
    mapsUrl:String(current.mapsUrl||candidate.mapsUrl||''),
    firstSeen:String(current.firstSeen||candidate.firstSeen||now),
    lastSeen:now
  };
}

function mapsKeyConflict_(a,b){
  const ak=String((a&&a.mapsKey)||'').trim(),bk=String((b&&b.mapsKey)||'').trim();
  return Boolean(ak&&bk&&ak!==bk);
}
function findFinalDuplicate_(index,rows,candidate){
  const f=masterFingerprint_(candidate||{});
  if(f.mapsKey&&index.mapsKey[f.mapsKey]!==undefined)return {idx:index.mapsKey[f.mapsKey],reason:'mapsKey'};
  if(f.mapsUrl&&index.mapsUrl[f.mapsUrl]!==undefined)return {idx:index.mapsUrl[f.mapsUrl],reason:'mapsUrl'};
  if(f.nameAddress){
    const matches=index.nameAddress[f.nameAddress]||[];
    for(let i=0;i<matches.length;i++){
      const idx=matches[i];
      if(!mapsKeyConflict_(candidate,rows[idx]))return {idx,reason:'nameAddress'};
    }
  }
  return {idx:-1,reason:''};
}
function dedupAndWriteFinalUnlocked_(candidates){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER),last=sh.getLastRow();
  const values=last>=2?sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues():[];
  const rows=values.map((r,i)=>masterObjectFromValues_(r,i+2));
  const index={mapsKey:{},mapsUrl:{},nameAddress:{}};
  const put=(row,idx)=>{
    const f=masterFingerprint_(row);
    if(f.mapsKey&&index.mapsKey[f.mapsKey]===undefined)index.mapsKey[f.mapsKey]=idx;
    if(f.mapsUrl&&index.mapsUrl[f.mapsUrl]===undefined)index.mapsUrl[f.mapsUrl]=idx;
    if(f.nameAddress){
      const list=index.nameAddress[f.nameAddress]||(index.nameAddress[f.nameAddress]=[]);
      if(list.indexOf(idx)<0)list.push(idx);
    }
  };
  rows.forEach((r,i)=>put(r,i));
  let nextId=nextFmiNumber_(values),inserted=0,duplicates=0;
  const changedExisting={},newRows=[],items=[],now=nowIso_();

  (candidates||[]).forEach(candidate=>{
    const match=findFinalDuplicate_(index,rows,candidate||{});
    const idx=match.idx,reason=match.reason;
    if(idx>=0){
      rows[idx]=mergeMaster_(rows[idx],candidate,now);put(rows[idx],idx);
      if(idx<values.length)changedExisting[idx]=rows[idx];
      else newRows[idx-values.length]=rows[idx];
      duplicates++;
      items.push({mode:'updated',reason,sheetRow:idx+2,id:rows[idx].id,mapsKey:rows[idx].mapsKey,mapsUrl:rows[idx].mapsUrl});
    }else{
      const id=candidate.id||`FMI-${String(nextId++).padStart(7,'0')}`;
      const row=mergeMaster_({},Object.assign({},candidate,{id}),now);
      rows.push(row);const newIdx=rows.length-1;put(row,newIdx);
      newRows.push(row);inserted++;
      items.push({mode:'inserted',reason:'new',sheetRow:newIdx+2,id:row.id,mapsKey:row.mapsKey,mapsUrl:row.mapsUrl});
    }
  });

  Object.keys(changedExisting).forEach(k=>{
    const idx=Number(k);sh.getRange(idx+2,1,1,HEADERS.MASTER.length).setValues([masterValues_(changedExisting[idx])]);
  });
  if(newRows.length)sh.getRange(last+1,1,newRows.length,HEADERS.MASTER.length).setValues(newRows.map(masterValues_));
  return {items,inserted,duplicates};
}

function upsertCloudMastersFinal_(candidates){
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{return dedupAndWriteFinalUnlocked_(candidates||[]);}
  finally{lock.releaseLock();}
}

function computeCloudTotals_(){
  const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),last=sh.getLastRow();
  const byId={};
  if(last>=2){
    const vals=sh.getRange(2,2,last-1,12).getValues();
    vals.forEach(r=>{
      const municipalityId=String(r[0]||'').trim(),status=String(r[5]||'').trim().toUpperCase();
      if(!municipalityId||!status)return;
      const item={status,found:Number(r[6])||0,newCount:Number(r[7])||0,duplicates:Number(r[8])||0,foreign:Number(r[9])||0,lastScanAt:r[10]||'',error:String(r[11]||'')};
      const current=byId[municipalityId];
      if(!current||status==='COMPLETED'&&current.status!=='COMPLETED'||status==='COMPLETED'&&current.status==='COMPLETED'&&(Date.parse(item.lastScanAt)||0)>(Date.parse(current.lastScanAt)||0))byId[municipalityId]=item;
      else if(item.error&&!current.error)current.error=item.error;
    });
  }
  let total=0,completed=0,todo=0,found=0,newCount=0,duplicates=0,foreign=0,errors=0;
  Object.keys(byId).forEach(id=>{
    const r=byId[id];total++;
    if(r.status==='COMPLETED'){completed++;found+=r.found;newCount+=r.newCount;duplicates+=r.duplicates;foreign+=r.foreign;}
    else if(r.status==='TODO')todo++;
    if(r.error)errors++;
  });
  return {total,completed,todo,found,newCount,duplicates,foreign,errors};
}

function startCloudRun_(data){
  const runId=String(data.runId||'').trim(),workerCount=Number(data.workerCount||3);
  if(!runId)throw new Error('runId mancante');
  if(![3,5].includes(workerCount))throw new Error('workerCount deve essere 3 o 5');
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const now=nowIso_();
    const state={runId,workerCount,status:'RUNNING',startedAt:now,updatedAt:now,stopRequested:false,finishedAt:null,nextRow:2,totals:computeCloudTotals_()};
    const patch={};patch[CLOUD_RUN_KEY]=state;patch[CLOUD_PENDING_START_KEY]='';
    for(let i=0;i<5;i++){
      patch[workerKey_(i)]={runId,workerIndex:i,status:i<workerCount?'QUEUED':'OFFLINE',municipalityId:'',municipalityName:'',queueCode:'',phase:i<workerCount?'IN ATTESA':'OFFLINE',query:'',leaseUntil:null,lastSeen:now,claimToken:'',claimSheetRow:0,found:0,newCount:0,duplicates:0,foreign:0,completedMunicipalities:0};
      CacheService.getScriptCache().remove(CLOUD_PREVIEW_PREFIX+runId+':'+i);
    }
    setJobState_(patch);clearDashboardCache_();
    return state;
  }finally{lock.releaseLock();}
}

function claimCloudMunicipality_(data){
  const runId=String(data.runId||'').trim(),workerIndex=Number(data.workerIndex),leaseSeconds=Math.max(120,Math.min(1800,Number(data.leaseSeconds)||CLOUD_DEFAULT_LEASE_SECONDS));
  if(!runId||!Number.isInteger(workerIndex)||workerIndex<0||workerIndex>4)throw new Error('Claim cloud non valido');
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    if(!run||String(run.runId)!==runId)throw new Error('Run cloud non attivo');
    if(run.stopRequested)return {stopped:true,row:null};

    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),last=sh.getLastRow();
    if(last<2)return {stopped:false,row:null,queueExhausted:true};
    const previous=getJobStateValue_(workerKey_(workerIndex))||{};

    if(String(previous.runId)===runId&&previous.status==='WORKING'&&previous.municipalityId&&previous.claimToken&&Number(previous.claimSheetRow)>=2&&Number(previous.claimSheetRow)<=last){
      const sheetRow=Number(previous.claimSheetRow),r=sh.getRange(sheetRow,1,1,13).getValues()[0];
      if(String(r[1]||'')===String(previous.municipalityId)&&String(r[6]||'').trim().toUpperCase()==='TODO'){
        const renewed=Object.assign({},previous,{leaseUntil:new Date(Date.now()+leaseSeconds*1000).toISOString(),lastSeen:nowIso_()});
        const p={};p[workerKey_(workerIndex)]=renewed;setJobState_(p);clearDashboardCache_();
        return {stopped:false,replayed:true,row:municipalityObject_(r,sheetRow,previous.claimToken)};
      }
    }

    const values=sh.getRange(2,1,last-1,13).getValues(),completedIds={},active={};
    values.forEach(r=>{const id=String(r[1]||'').trim(),status=String(r[6]||'').trim().toUpperCase();if(id&&status==='COMPLETED')completedIds[id]=true;});
    const nowMs=Date.now();
    for(let i=0;i<Number(run.workerCount||0);i++){
      if(i===workerIndex)continue;
      const w=getJobStateValue_(workerKey_(i));
      if(!w||String(w.runId)!==runId||w.status!=='WORKING'||!w.municipalityId)continue;
      const until=Date.parse(w.leaseUntil||'')||0;
      if(until>nowMs)active[String(w.municipalityId)]=true;
    }

    const startRow=Math.max(2,Math.min(last,Number(run.nextRow)||2));
    const order=[];
    for(let row=startRow;row<=last;row++)order.push(row);
    for(let row=2;row<startRow;row++)order.push(row);
    let selected=null,blockedTodo=0;
    for(const sheetRow of order){
      const r=values[sheetRow-2],municipalityId=String(r[1]||'').trim(),status=String(r[6]||'').trim().toUpperCase(),error=String(r[12]||'');
      if(!municipalityId||status!=='TODO'||completedIds[municipalityId])continue;
      if(error.indexOf('[run:'+runId+']')===0)continue;
      if(active[municipalityId]){blockedTodo++;continue;}
      selected=municipalityObject_(r,sheetRow,newClaimToken_());
      sh.getRange(sheetRow,13).clearContent();
      run.nextRow=sheetRow>=last?2:sheetRow+1;run.updatedAt=nowIso_();
      const rp={};rp[CLOUD_RUN_KEY]=run;setJobState_(rp);
      break;
    }

    const now=nowIso_();
    if(!selected&&blockedTodo>0){
      const waiting=Object.assign({},previous,{runId,workerIndex,status:'IDLE',municipalityId:'',municipalityName:'',queueCode:'',phase:'ATTENDO LEASE',query:'',leaseUntil:null,lastSeen:now,claimToken:'',claimSheetRow:0});
      const p={};p[workerKey_(workerIndex)]=waiting;setJobState_(p);clearDashboardCache_();
      return {stopped:false,row:null,retry:true,retryAfterMs:5000,eligibleTodo:blockedTodo};
    }

    const worker=selected?Object.assign({},previous,{
      runId,workerIndex,status:'WORKING',municipalityId:selected.municipalityId,municipalityName:selected.name,queueCode:selected.queueCode,
      phase:'ASSEGNATO',query:'',leaseUntil:new Date(Date.now()+leaseSeconds*1000).toISOString(),lastSeen:now,
      claimToken:selected.claimToken,claimSheetRow:selected.sheetRow,found:0,newCount:0,duplicates:0,foreign:0,lastError:''
    }):Object.assign({},previous,{runId,workerIndex,status:'DONE',municipalityId:'',municipalityName:'',queueCode:'',phase:'CODA COMPLETATA',query:'',leaseUntil:null,lastSeen:now,claimToken:'',claimSheetRow:0});
    const p={};p[workerKey_(workerIndex)]=worker;setJobState_(p);clearDashboardCache_();
    return {stopped:false,row:selected,queueExhausted:!selected};
  }finally{lock.releaseLock();}
}

function heartbeatCloudWorker_(data){
  const runId=String(data.runId||'').trim(),workerIndex=Number(data.workerIndex),leaseSeconds=Math.max(120,Math.min(1800,Number(data.leaseSeconds)||CLOUD_DEFAULT_LEASE_SECONDS));
  if(!runId||!Number.isInteger(workerIndex))throw new Error('Heartbeat non valido');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    const current=getJobStateValue_(workerKey_(workerIndex))||{};
    if(!run||String(run.runId)!==runId||String(current.runId)!==runId)return {ok:false,stopRequested:true};
    const merged=Object.assign({},current,data.state||{}, {
      runId,workerIndex,lastSeen:nowIso_(),
      leaseUntil:current.municipalityId?new Date(Date.now()+leaseSeconds*1000).toISOString():null
    });
    if(run.stopRequested){merged.status='STOPPING';merged.phase='ARRESTO RICHIESTO';}
    delete merged.previewBase64;
    const p={};p[workerKey_(workerIndex)]=merged;setJobState_(p);clearDashboardCache_();
    return {ok:true,stopRequested:Boolean(run.stopRequested)};
  }finally{lock.releaseLock();}
}

function updateCloudPreview_(data){
  const runId=String(data.runId||'').trim(),workerIndex=Number(data.workerIndex),base64=String(data.base64||'');
  if(!runId||!Number.isInteger(workerIndex)||!base64)return {stored:false};
  if(base64.length>90000)return {stored:false,reason:'preview_too_large'};
  CacheService.getScriptCache().put(CLOUD_PREVIEW_PREFIX+runId+':'+workerIndex,JSON.stringify({at:data.capturedAt||nowIso_(),base64}),600);
  return {stored:true};
}

function finalizeCloudMunicipality_(data){
  const runId=String(data.runId||'').trim(),workerIndex=Number(data.workerIndex),municipalityId=String(data.municipalityId||'').trim(),claimToken=String(data.claimToken||'').trim(),claimSheetRow=Number(data.claimSheetRow)||0;
  if(!runId||!municipalityId||!claimToken||!Number.isInteger(workerIndex))throw new Error('Finalizzazione non valida');
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    const worker=getJobStateValue_(workerKey_(workerIndex))||{};
    if(!run||String(run.runId)!==runId)throw new Error('Run cloud non attivo');

    if(String(worker.lastFinalizedClaimToken||'')===claimToken&&String(worker.lastFinalizedMunicipalityId||'')===municipalityId){
      const receipt=worker.lastFinalizedResult||{};
      return {alreadyFinalized:true,sheetRow:Number(receipt.sheetRow)||claimSheetRow,completedAt:receipt.completedAt||'',inserted:Number(receipt.inserted)||0,duplicates:Number(receipt.duplicates)||0,finalDuplicates:Number(receipt.finalDuplicates)||0,items:[]};
    }
    if(String(worker.runId)!==runId||String(worker.municipalityId)!==municipalityId||String(worker.claimToken||'')!==claimToken||Number(worker.claimSheetRow)!==claimSheetRow)throw new Error('Lease non appartenente al worker');

    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),last=sh.getLastRow();
    if(claimSheetRow<2||claimSheetRow>last)throw new Error('Riga lease non valida');
    const current=sh.getRange(claimSheetRow,1,1,13).getValues()[0];
    if(String(current[1]||'')!==municipalityId)throw new Error('Municipality ID non corrisponde alla lease');

    const currentStatus=String(current[6]||'').trim().toUpperCase();
    if(currentStatus==='COMPLETED'){
      const receipt={sheetRow:claimSheetRow,completedAt:current[11]||'',inserted:Number(current[8])||0,duplicates:Number(current[9])||0,finalDuplicates:0};
      const updated=Object.assign({},worker,{status:'IDLE',municipalityId:'',municipalityName:'',queueCode:'',phase:'COMUNE COMPLETATO',query:'',leaseUntil:null,lastSeen:nowIso_(),claimToken:'',claimSheetRow:0,lastFinalizedClaimToken:claimToken,lastFinalizedMunicipalityId:municipalityId,lastFinalizedResult:receipt});
      const p={};p[workerKey_(workerIndex)]=updated;setJobState_(p);clearDashboardCache_();
      return {alreadyFinalized:true,...receipt,items:[]};
    }
    if(currentStatus!=='TODO')throw new Error('Comune non finalizzabile: '+currentStatus);

    const result=dedupAndWriteFinalUnlocked_(data.candidates||[]);
    const completedAt=data.completedAt||nowIso_();
    const preDup=Number(data.preDuplicateCount)||0,finalDup=Number(result.duplicates)||0,totalDup=preDup+finalDup;
    sh.getRange(claimSheetRow,7,1,7).setValues([[
      'COMPLETED',Number(data.foundCount)||0,Number(result.inserted)||0,totalDup,Number(data.foreignCount)||0,completedAt,''
    ]]);
    run.totals=computeCloudTotals_();run.updatedAt=nowIso_();
    const runPatch={};runPatch[CLOUD_RUN_KEY]=run;setJobState_(runPatch);

    const receipt={sheetRow:claimSheetRow,completedAt,inserted:Number(result.inserted)||0,duplicates:totalDup,finalDuplicates:finalDup};
    const updated=Object.assign({},worker,{
      status:'IDLE',municipalityId:'',municipalityName:'',queueCode:'',phase:'COMUNE COMPLETATO',query:'',leaseUntil:null,lastSeen:nowIso_(),claimToken:'',claimSheetRow:0,
      found:Number(data.foundCount)||0,newCount:Number(result.inserted)||0,duplicates:totalDup,foreign:Number(data.foreignCount)||0,
      foundTotal:Number(worker.foundTotal||0)+(Number(data.foundCount)||0),
      newTotal:Number(worker.newTotal||0)+Number(result.inserted||0),
      duplicateTotal:Number(worker.duplicateTotal||0)+totalDup,
      foreignTotal:Number(worker.foreignTotal||0)+(Number(data.foreignCount)||0),
      completedMunicipalities:Number(worker.completedMunicipalities||0)+1,
      lastFinalizedClaimToken:claimToken,lastFinalizedMunicipalityId:municipalityId,lastFinalizedResult:receipt
    });
    const p={};p[workerKey_(workerIndex)]=updated;setJobState_(p);clearDashboardCache_();
    return {...receipt,items:result.items};
  }finally{lock.releaseLock();}
}

function failCloudMunicipality_(data){
  const runId=String(data.runId||'').trim(),workerIndex=Number(data.workerIndex),municipalityId=String(data.municipalityId||'').trim(),claimToken=String(data.claimToken||'').trim(),claimSheetRow=Number(data.claimSheetRow)||0;
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    const worker=Number.isInteger(workerIndex)?getJobStateValue_(workerKey_(workerIndex))||{}:{};
    if(!run||String(run.runId)!==runId)return {ignored:true,reason:'stale-run'};
    if(String(worker.lastFailedClaimToken||'')===claimToken&&claimToken)return {alreadyFailed:true};
    if(!claimToken||String(worker.runId)!==runId||String(worker.municipalityId)!==municipalityId||String(worker.claimToken||'')!==claimToken||Number(worker.claimSheetRow)!==claimSheetRow)return {ignored:true,reason:'stale-lease'};

    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),last=sh.getLastRow();
    if(claimSheetRow<2||claimSheetRow>last)return {ignored:true,reason:'invalid-row'};
    const currentId=String(sh.getRange(claimSheetRow,2).getValue()||'');if(currentId!==municipalityId)return {ignored:true,reason:'row-mismatch'};
    const message='[run:'+runId+'] '+String(data.error||'Errore worker cloud').slice(0,430);
    sh.getRange(claimSheetRow,13).setValue(message);
    const p={};p[workerKey_(workerIndex)]=Object.assign({},worker,{status:'IDLE',municipalityId:'',municipalityName:'',queueCode:'',phase:'ERRORE - PASSO AL PROSSIMO',query:'',leaseUntil:null,lastSeen:nowIso_(),claimToken:'',claimSheetRow:0,lastError:message,lastFailedClaimToken:claimToken});
    setJobState_(p);
    run.totals=computeCloudTotals_();run.updatedAt=nowIso_();const rp={};rp[CLOUD_RUN_KEY]=run;setJobState_(rp);
    clearDashboardCache_();return {sheetRow:claimSheetRow};
  }finally{lock.releaseLock();}
}

function finishCloudWorker_(data){
  const runId=String(data.runId||'').trim(),workerIndex=Number(data.workerIndex);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY)||{};
    const worker=getJobStateValue_(workerKey_(workerIndex))||{};
    if(String(run.runId||'')!==runId||String(worker.runId||'')!==runId)return {stale:true,status:run.status||'IDLE'};
    const p={};p[workerKey_(workerIndex)]=Object.assign({},worker,{runId,workerIndex,status:'DONE',municipalityId:'',municipalityName:'',queueCode:'',phase:run.stopRequested?'ARRESTATO':'TERMINATO',query:'',leaseUntil:null,lastSeen:nowIso_(),claimToken:'',claimSheetRow:0});
    setJobState_(p);
    let allDone=true;
    for(let i=0;i<Number(run.workerCount||0);i++){
      const w=i===workerIndex?p[workerKey_(workerIndex)]:getJobStateValue_(workerKey_(i));
      if(!w||w.status!=='DONE')allDone=false;
    }
    if(allDone){
      run.status=run.stopRequested?'STOPPED':'WORKERS_DONE';
      run.finishedAt=nowIso_();run.updatedAt=run.finishedAt;run.totals=computeCloudTotals_();
      const r={};r[CLOUD_RUN_KEY]=run;setJobState_(r);
    }
    clearDashboardCache_();return {allDone,status:run.status||'RUNNING'};
  }finally{lock.releaseLock();}
}

function closeCloudRun_(data){
  const runId=String(data.runId||'').trim();
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    if(!run||String(run.runId)!==runId)return {status:'STALE'};
    const totals=computeCloudTotals_();run.totals=totals;run.finishedAt=nowIso_();run.updatedAt=run.finishedAt;
    const workflowResult=String(data.workflowResult||'').toLowerCase();
    if(run.stopRequested)run.status='STOPPED';
    else if(workflowResult&&workflowResult!=='success')run.status='INCOMPLETE';
    else if(totals.todo>0)run.status='INCOMPLETE';
    else run.status=totals.errors>0?'COMPLETED_WITH_ERRORS':'COMPLETED';
    const p={};p[CLOUD_RUN_KEY]=run;setJobState_(p);clearDashboardCache_();return {status:run.status,totals};
  }finally{lock.releaseLock();}
}

function requestCloudStop_(){
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    if(!run)return {ok:false,status:'IDLE'};
    const status=String(run.status||'');
    if(!['RUNNING','STOPPING','WORKERS_DONE'].includes(status))return {ok:true,alreadyStopped:true,status};
    if(status==='WORKERS_DONE'){
      run.stopRequested=true;run.status='STOPPED';run.finishedAt=nowIso_();run.updatedAt=run.finishedAt;
      const onlyRun={};onlyRun[CLOUD_RUN_KEY]=run;setJobState_(onlyRun);clearDashboardCache_();return {ok:true,status:'STOPPED'};
    }
    run.stopRequested=true;run.status='STOPPING';run.stopRequestedAt=run.stopRequestedAt||nowIso_();run.updatedAt=nowIso_();
    const patch={};patch[CLOUD_RUN_KEY]=run;
    for(let i=0;i<Number(run.workerCount||0);i++){
      const key=workerKey_(i),w=getJobStateValue_(key)||{};
      if(String(w.runId||'')!==String(run.runId)||['DONE','OFFLINE'].includes(String(w.status||'')))continue;
      patch[key]=Object.assign({},w,{status:'STOPPING',phase:'ARRESTO RICHIESTO'});
    }
    setJobState_(patch);clearDashboardCache_();return {ok:true,status:'STOPPING'};
  }finally{lock.releaseLock();}
}

function cloudSummary_(){
  const cached=CacheService.getScriptCache().get(CLOUD_DASHBOARD_CACHE);
  if(cached){try{return JSON.parse(cached);}catch{}}
  const run=getJobStateValue_(CLOUD_RUN_KEY)||{status:'IDLE',workerCount:0,runId:'',totals:computeCloudTotals_()};
  const workers=[],nowMs=Date.now();
  for(let i=0;i<5;i++){
    const raw=getJobStateValue_(workerKey_(i))||{workerIndex:i,status:'OFFLINE'};
    const w=Object.assign({},raw);
    if(run.stopRequested&&String(w.runId||'')===String(run.runId||'')&&!['DONE','OFFLINE'].includes(String(w.status||''))){w.status='STOPPING';w.phase='ARRESTO RICHIESTO';}
    else if(w.status==='WORKING'){
      const lease=Date.parse(w.leaseUntil||'')||0,lastSeen=Date.parse(w.lastSeen||'')||0;
      if(lease&&lease<nowMs||lastSeen&&nowMs-lastSeen>Math.max(120000,CLOUD_DEFAULT_LEASE_SECONDS*1000)){w.status='STALLED';w.phase='LEASE SCADUTA';}
    }
    workers.push(w);
  }
  const pendingStart=getJobStateValue_(CLOUD_PENDING_START_KEY);const summary={run,workers,totals:run.totals||computeCloudTotals_(),pendingStart,console:{githubConfigured:Boolean(githubToken_())},generatedAt:nowIso_()};
  CacheService.getScriptCache().put(CLOUD_DASHBOARD_CACHE,JSON.stringify(summary),8);
  return summary;
}

function getCloudDashboardState(clientPreviewTimes){
  const summary=cloudSummary_(),times=clientPreviewTimes||{},runId=String(summary.run.runId||'');
  summary.workers=summary.workers.map(w=>{
    const out=Object.assign({},w); const idx=Number(w.workerIndex);
    if(runId&&Number.isInteger(idx)){
      const raw=CacheService.getScriptCache().get(CLOUD_PREVIEW_PREFIX+runId+':'+idx);
      if(raw){
        try{
          const p=JSON.parse(raw);
          out.previewAt=p.at;
          if(String(times[idx]||'')!==String(p.at||''))out.previewBase64=p.base64;
        }catch{}
      }
    }
    return out;
  });
  return summary;
}
function requestCloudStop(){return requestCloudStop_();}

function completeCloudMunicipality_(data){
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),row=findRow_(sh,2,data.municipalityId);if(row<0)throw new Error('Municipality ID non trovato');
    const currentStatus=String(sh.getRange(row,7).getValue()||'').toUpperCase();
    if(currentStatus==='COMPLETED')return {alreadyCompleted:true,sheetRow:row};
    const completedAt=data.completedAt||nowIso_();
    sh.getRange(row,7,1,7).setValues([['COMPLETED',Number(data.foundCount)||0,Number(data.newCount)||0,Number(data.duplicateCount)||0,Number(data.foreignCount)||0,completedAt,'']]);
    return {alreadyCompleted:false,sheetRow:row,completedAt};
  }finally{lock.releaseLock();}
}

function githubToken_(){
  return String(PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN')||'').trim();
}

function githubDispatch_(workerCount,maxMunicipalitiesPerWorker,maxMinutes){
  const token=githubToken_();
  if(!token)throw new Error('GITHUB_TOKEN non configurato nelle Proprietà script');
  const url='https://api.github.com/repos/'+encodeURIComponent(GITHUB_OWNER)+'/'+encodeURIComponent(GITHUB_REPO)+'/actions/workflows/'+encodeURIComponent(GITHUB_WORKFLOW)+'/dispatches';
  const payload={ref:GITHUB_REF,inputs:{workers:String(workerCount),max_minutes:String(maxMinutes),max_municipalities_per_worker:String(maxMunicipalitiesPerWorker)}};
  const res=UrlFetchApp.fetch(url,{
    method:'post',contentType:'application/json',
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    payload:JSON.stringify(payload),muteHttpExceptions:true
  });
  const code=res.getResponseCode(),body=String(res.getContentText()||'');
  if(code<200||code>=300)throw new Error('GitHub workflow dispatch HTTP '+code+(body?' · '+body.slice(0,350):''));
  let parsed={};if(body){try{parsed=JSON.parse(body);}catch{parsed={};}}
  return {statusCode:code,workflowRunId:parsed.workflow_run_id||null,workflowRunUrl:parsed.html_url||null};
}

function startCloudCollector(workerCount,maxMunicipalitiesPerWorker,maxMinutes){
  workerCount=Number(workerCount);
  maxMunicipalitiesPerWorker=Math.max(0,Math.min(10000,Number(maxMunicipalitiesPerWorker)||0));
  maxMinutes=Math.max(5,Math.min(330,Number(maxMinutes)||300));
  if(![3,5].includes(workerCount))throw new Error('Scegli 3 o 5 Chromium');
  if(!githubToken_())throw new Error('GITHUB_TOKEN non configurato nelle Proprietà script');
  const lock=LockService.getScriptLock();lock.waitLock(10000);let pending;
  try{
    const run=getJobStateValue_(CLOUD_RUN_KEY);
    if(run&&['RUNNING','STOPPING','WORKERS_DONE'].includes(String(run.status||'')))throw new Error('Esiste già un run attivo: '+String(run.status||''));
    const currentPending=getJobStateValue_(CLOUD_PENDING_START_KEY);
    if(currentPending&&currentPending.requestedAt){const age=Date.now()-(Date.parse(currentPending.requestedAt)||0);if(age>=0&&age<90000)throw new Error('Avvio già richiesto, attendi che GitHub prepari i worker');}
    pending={requestedAt:nowIso_(),workerCount,maxMunicipalitiesPerWorker,maxMinutes};
    const patch={};patch[CLOUD_PENDING_START_KEY]=pending;setJobState_(patch);clearDashboardCache_();
  }finally{lock.releaseLock();}
  try{return {ok:true,pendingStart:pending,...githubDispatch_(workerCount,maxMunicipalitiesPerWorker,maxMinutes)};}
  catch(err){const patch={};patch[CLOUD_PENDING_START_KEY]='';setJobState_(patch);clearDashboardCache_();throw err;}
}

function doGet(e){
  ensureAll_();
  if(e&&e.parameter&&String(e.parameter.dashboard||'')==='1'){
    return HtmlService.createHtmlOutputFromFile('dashboard').setTitle('FindMyInk Cloud Console').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName(),dashboard:'?dashboard=1'});
}
function doPost(e){
  try{
    ensureAll_();const data=JSON.parse((e&&e.postData&&e.postData.contents)||'{}'),action=data.action||'';
    if(action==='ping'){const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}
    if(action==='startCloudRun')return json_({ok:true,...startCloudRun_(data)});
    if(action==='claimCloudMunicipality')return json_({ok:true,...claimCloudMunicipality_(data)});
    if(action==='heartbeatCloudWorker')return json_({ok:true,...heartbeatCloudWorker_(data)});
    if(action==='updateCloudPreview')return json_({ok:true,...updateCloudPreview_(data)});
    if(action==='finalizeCloudMunicipality')return json_({ok:true,...finalizeCloudMunicipality_(data)});
    if(action==='finishCloudWorker')return json_({ok:true,...finishCloudWorker_(data)});
    if(action==='closeCloudRun')return json_({ok:true,...closeCloudRun_(data)});
    if(action==='requestCloudStop')return json_({ok:true,...requestCloudStop_()});
    if(action==='getCloudDashboardState')return json_({ok:true,...getCloudDashboardState(data.previewTimes||{})});
    if(action==='getCloudDedupIndex')return json_({ok:true,...getCloudDedupIndex_()});
    if(action==='getCloudMasterSnapshot')return json_({ok:true,rows:getCloudMasterSnapshot_()});
    if(action==='upsertCloudMastersFinal')return json_({ok:true,...upsertCloudMastersFinal_(data.rows||[])});
    if(action==='completeCloudMunicipality')return json_({ok:true,...completeCloudMunicipality_(data)});
    if(action==='failCloudMunicipality')return json_({ok:true,...failCloudMunicipality_(data)});
    if(action==='upsertMaster')return json_({ok:true,...upsertMaster_(data.row||{})});
    if(action==='upsertMasters'){const items=upsertMasters_(data.rows||[]);return json_({ok:true,items});}
    if(action==='upsertMunicipality')return json_({ok:true,...upsertMunicipality_(data.row||{})});
    if(action==='upsertMunicipalities'){const rows=data.rows||[];upsertMunicipalities_(rows);return json_({ok:true,count:rows.length});}
    if(action==='setJobState'){setJobState_(data.state||{});return json_({ok:true});}
    if(action==='appendLog'){const sh=ensureSheet_('LOG',HEADERS.LOG),r=data.row||{};sh.appendRow([r.timestamp||new Date(),r.level||'',r.message||'']);return json_({ok:true});}
    return json_({ok:false,error:'Azione non supportata: '+action});
  }catch(err){return json_({ok:false,error:String(err&&err.message||err)});}
}
