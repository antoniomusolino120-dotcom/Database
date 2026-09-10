const SPREADSHEET_ID = '1pXRJuIKS9OgdGQI8o3273Y8fVyjm_IIjC0YyLPw4y6g';
const HEADERS = {
  MASTER: ['ID','Nome','Telefono','Sito','Indirizzo','Latitudine','Longitudine','Maps Key','Maps URL','First Seen','Last Seen'],
  COMUNI: ['Codice Coda','Municipality ID','Comune','Provincia','Sigla','Regione','Status','Trovati','Nuovi','Duplicati','Esteri scartati','Ultima scansione','Errore'],
  JOB_STATE: ['Key','Value','Updated At'],
  DA_VERIFICARE: ['ID','Nome','Telefono','Sito','Indirizzo','Latitudine','Longitudine','Motivo','Maps URL'],
  LOG: ['Timestamp','Level','Message']
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function book_(){ return SpreadsheetApp.openById(SPREADSHEET_ID); }

function ensureSheet_(name, headers) {
  const ss=book_(); let sh=ss.getSheetByName(name); if(!sh) sh=ss.insertSheet(name);
  if (sh.getLastRow()===0) sh.getRange(1,1,1,headers.length).setValues([headers]);
  return sh;
}

function ensureAll_(){ Object.keys(HEADERS).forEach(k=>ensureSheet_(k,HEADERS[k])); }

function findRow_(sh,col,value){
  if(!value||sh.getLastRow()<2)return -1;
  const finder=sh.getRange(2,col,sh.getLastRow()-1,1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  return finder?finder.getRow():-1;
}

function withScriptLock_(fn,waitMs){
  const lock=LockService.getScriptLock(); lock.waitLock(waitMs||30000);
  try{return fn();}finally{lock.releaseLock();}
}

function masterValues_(r){return [r.id||'',r.name||'',r.phone||'',r.website||'',r.address||'',r.lat??'',r.lng??'',r.mapsKey||'',r.mapsUrl||'',r.firstSeen||'',r.lastSeen||''];}
function municipalityValues_(r){return [r.queueCode||'',r.municipalityId||'',r.name||'',r.province||'',r.provinceCode||'',r.region||'',r.status||'',r.foundCount??0,r.newCount??0,r.duplicateCount??0,r.foreignCount??0,r.lastScanAt||'',r.errorText||''];}

function upsertMaster_(r){return upsertMasters_([r])[0];}

function upsertMasters_(rows){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER);
  const last=sh.getLastRow(); const values=last>=2?sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues():[];
  const byId={}; const byKey={}; values.forEach((r,i)=>{if(r[0])byId[String(r[0])]=i+2;if(r[7])byKey[String(r[7])]=i+2;});
  const out=[]; const appends=[];
  rows.forEach(r=>{let row=(r.id&&byId[String(r.id)])||(r.mapsKey&&byKey[String(r.mapsKey)])||-1;if(row>0){sh.getRange(row,1,1,HEADERS.MASTER.length).setValues([masterValues_(r)]);out.push({mode:'updated',sheetRow:row});}else{appends.push({r,index:out.length});const newRow=last+appends.length;out.push({mode:'inserted',sheetRow:newRow});if(r.id)byId[String(r.id)]=newRow;if(r.mapsKey)byKey[String(r.mapsKey)]=newRow;}});
  if(appends.length)sh.getRange(last+1,1,appends.length,HEADERS.MASTER.length).setValues(appends.map(x=>masterValues_(x.r)));
  return out;
}

function upsertMunicipality_(r){return upsertMunicipalities_([r])[0];}

function upsertMunicipalities_(rows){
  const sh=ensureSheet_('COMUNI',HEADERS.COMUNI); const last=sh.getLastRow();
  const existing=last>=2?sh.getRange(2,2,last-1,1).getValues():[]; const byId={}; existing.forEach((r,i)=>{if(r[0])byId[String(r[0])]=i+2;});
  const result=[]; const appends=[];
  rows.forEach(r=>{const row=r.municipalityId&&byId[String(r.municipalityId)];if(row){sh.getRange(row,1,1,HEADERS.COMUNI.length).setValues([municipalityValues_(r)]);result.push({mode:'updated',sheetRow:row});}else{appends.push(r);const nr=last+appends.length;result.push({mode:'inserted',sheetRow:nr});if(r.municipalityId)byId[String(r.municipalityId)]=nr;}});
  if(appends.length)sh.getRange(last+1,1,appends.length,HEADERS.COMUNI.length).setValues(appends.map(municipalityValues_));
  return result;
}

function setJobState_(state){
  const sh=ensureSheet_('JOB_STATE',HEADERS.JOB_STATE); const now=new Date();
  Object.keys(state||{}).forEach(key=>{
    let row=findRow_(sh,1,key); if(row<0)row=sh.getLastRow()+1;
    const value=typeof state[key]==='object'?JSON.stringify(state[key]):String(state[key]??'');
    sh.getRange(row,1,1,3).setValues([[key,value,now]]);
  });
}

function shardFor_(value, workerCount){
  const s=String(value||''); let h=0;
  for(let i=0;i<s.length;i++) h=((h*31)+s.charCodeAt(i))>>>0;
  return h%workerCount;
}

function getCloudWork_(data){
  const workerIndex=Number(data.workerIndex); const workerCount=Number(data.workerCount); const limit=Math.max(1,Math.min(50,Number(data.limit)||8));
  if(!Number.isInteger(workerIndex)||!Number.isInteger(workerCount)||workerCount<1||workerIndex<0||workerIndex>=workerCount) throw new Error('Shard cloud non valido');
  const sh=ensureSheet_('COMUNI',HEADERS.COMUNI); const last=sh.getLastRow(); if(last<2)return [];
  const values=sh.getRange(2,1,last-1,13).getValues(); const out=[];
  for(let i=0;i<values.length&&out.length<limit;i++){
    const r=values[i]; const municipalityId=String(r[1]||'').trim(); const status=String(r[6]||'').trim().toUpperCase();
    if(!municipalityId||status!=='TODO'||shardFor_(municipalityId,workerCount)!==workerIndex)continue;
    out.push({sheetRow:i+2,queueCode:String(r[0]||''),municipalityId,name:String(r[2]||''),province:String(r[3]||''),provinceCode:String(r[4]||''),region:String(r[5]||''),status:'TODO',lastScanAt:r[11]||''});
  }
  return out;
}

function normalizedMapsUrl_(url){return String(url||'').trim().split('#')[0].split('?')[0].replace(/\/$/,'');}
function normalizedPhone_(phone){return String(phone||'').replace(/\D/g,'').replace(/^0039/,'39').replace(/^39(?=\d{8,})/,'');}
function normalizedText_(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function normalizedDomain_(website){
  let s=String(website||'').trim().toLowerCase();
  if(!s)return '';
  s=s.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split('?')[0].split('#')[0];
  return s;
}

function getCloudDedupIndex_(){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER); const last=sh.getLastRow(); if(last<2)return {mapsKeys:[],mapsUrls:[]};
  const values=sh.getRange(2,8,last-1,2).getValues(); const keys=[]; const urls=[];
  values.forEach(r=>{if(r[0])keys.push(String(r[0]));if(r[1])urls.push(String(r[1]));});
  return {mapsKeys:keys,mapsUrls:urls};
}

function cloudCacheKey_(key){return `fmi:${String(key||'').slice(0,235)}`;}

function reserveCloudCandidates_(data){
  const workerId=String(data.workerId||'').trim();
  if(!workerId)throw new Error('workerId obbligatorio');
  const keys=[...new Set((data.keys||[]).map(v=>String(v||'').trim()).filter(Boolean))];
  if(!keys.length)return {claimed:[],known:[],busy:[]};
  return withScriptLock_(()=>{
    // Rilettura live di MASTER!H dentro il lock: elimina la race fra snapshot dei worker.
    const sh=ensureSheet_('MASTER',HEADERS.MASTER); const last=sh.getLastRow();
    const persisted=new Set(last>=2?sh.getRange(2,8,last-1,1).getValues().flat().map(v=>String(v||'').trim()).filter(Boolean):[]);
    const cache=CacheService.getScriptCache();
    const cacheKeys=keys.map(cloudCacheKey_); const current=cache.getAll(cacheKeys);
    const claimed=[]; const known=[]; const busy=[]; const puts={};
    keys.forEach((key,i)=>{
      if(persisted.has(key)){known.push(key);return;}
      const ck=cacheKeys[i]; const owner=current[ck];
      if(owner&&owner!==workerId){busy.push(key);return;}
      claimed.push(key); puts[ck]=workerId;
    });
    if(Object.keys(puts).length)cache.putAll(puts,21600);
    return {claimed,known,busy};
  },45000);
}

function releaseCloudCandidates_(data){
  const workerId=String(data.workerId||'').trim();
  const keys=[...new Set((data.keys||[]).map(v=>String(v||'').trim()).filter(Boolean))];
  if(!workerId||!keys.length)return {released:0};
  return withScriptLock_(()=>{
    const cache=CacheService.getScriptCache(); let released=0;
    keys.forEach(key=>{const ck=cloudCacheKey_(key);if(cache.get(ck)===workerId){cache.remove(ck);released++;}});
    return {released};
  },30000);
}

function nextFmiId_(values){
  let max=0;
  values.forEach(r=>{const m=String(r[0]||'').match(/^FMI-(\d+)$/i);if(m)max=Math.max(max,Number(m[1])||0);});
  return `FMI-${String(max+1).padStart(7,'0')}`;
}

function upsertCloudMaster_(candidate){
  const lock=LockService.getScriptLock(); lock.waitLock(30000);
  try{
    const sh=ensureSheet_('MASTER',HEADERS.MASTER); const last=sh.getLastRow();
    const values=last>=2?sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues():[];
    const key=String(candidate.mapsKey||'').trim(); const url=normalizedMapsUrl_(candidate.mapsUrl); const phone=normalizedPhone_(candidate.phone); const domain=normalizedDomain_(candidate.website);
    const nName=normalizedText_(candidate.name); const nAddress=normalizedText_(candidate.address);
    let idx=-1; let reason='';
    for(let i=0;i<values.length;i++){
      const r=values[i];
      if(key&&String(r[7]||'')===key){idx=i;reason='maps_key';break;}
      if(url&&normalizedMapsUrl_(r[8])===url){idx=i;reason='maps_url';break;}
    }
    if(idx<0&&phone){for(let i=0;i<values.length;i++)if(normalizedPhone_(values[i][2])===phone){idx=i;reason='phone';break;}}
    if(idx<0&&nName&&nAddress){for(let i=0;i<values.length;i++)if(normalizedText_(values[i][1])===nName&&normalizedText_(values[i][4])===nAddress){idx=i;reason='name_address';break;}}
    if(idx<0&&domain&&nName){for(let i=0;i<values.length;i++)if(normalizedDomain_(values[i][3])===domain&&normalizedText_(values[i][1])===nName){idx=i;reason='name_domain';break;}}
    const now=new Date().toISOString();
    if(idx>=0){
      const current=values[idx];
      const merged={id:String(current[0]||''),name:String(current[1]||candidate.name||''),phone:String(current[2]||candidate.phone||''),website:String(current[3]||candidate.website||''),address:String(current[4]||candidate.address||''),lat:current[5]!==''?current[5]:(candidate.lat??''),lng:current[6]!==''?current[6]:(candidate.lng??''),mapsKey:String(current[7]||candidate.mapsKey||''),mapsUrl:String(current[8]||candidate.mapsUrl||''),firstSeen:String(current[9]||now),lastSeen:now};
      sh.getRange(idx+2,1,1,HEADERS.MASTER.length).setValues([masterValues_(merged)]);
      return {mode:'updated',reason,sheetRow:idx+2,id:merged.id,mapsKey:merged.mapsKey,mapsUrl:merged.mapsUrl};
    }
    const row={...candidate,id:candidate.id||nextFmiId_(values),firstSeen:candidate.firstSeen||now,lastSeen:now};
    const sheetRow=last+1; sh.getRange(sheetRow,1,1,HEADERS.MASTER.length).setValues([masterValues_(row)]);
    return {mode:'inserted',reason:'new',sheetRow,id:row.id,mapsKey:row.mapsKey||'',mapsUrl:row.mapsUrl||''};
  }finally{lock.releaseLock();}
}

function completeCloudMunicipality_(data){
  const lock=LockService.getScriptLock(); lock.waitLock(30000);
  try{
    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI); const row=findRow_(sh,2,data.municipalityId); if(row<0)throw new Error('Municipality ID non trovato');
    const currentStatus=String(sh.getRange(row,7).getValue()||'').toUpperCase();
    if(currentStatus==='COMPLETED')return {alreadyCompleted:true,sheetRow:row};
    const completedAt=data.completedAt||new Date().toISOString();
    sh.getRange(row,7,1,7).setValues([['COMPLETED',Number(data.foundCount)||0,Number(data.newCount)||0,Number(data.duplicateCount)||0,Number(data.foreignCount)||0,completedAt,'']]);
    return {alreadyCompleted:false,sheetRow:row,completedAt};
  }finally{lock.releaseLock();}
}

function failCloudMunicipality_(data){
  const lock=LockService.getScriptLock(); lock.waitLock(30000);
  try{
    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI); const row=findRow_(sh,2,data.municipalityId); if(row<0)throw new Error('Municipality ID non trovato');
    // G resta TODO e L non viene toccata. Aggiorniamo soltanto l'errore in M.
    sh.getRange(row,13).setValue(String(data.error||'Errore worker cloud').slice(0,500));
    return {sheetRow:row};
  }finally{lock.releaseLock();}
}

function doGet(){ensureAll_();const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}

function doPost(e){
  try{
    ensureAll_(); const data=JSON.parse((e&&e.postData&&e.postData.contents)||'{}'); const action=data.action||'';
    if(action==='ping'){const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}
    if(action==='getCloudWork')return json_({ok:true,rows:getCloudWork_(data)});
    if(action==='getCloudDedupIndex')return json_({ok:true,...getCloudDedupIndex_()});
    if(action==='reserveCloudCandidates')return json_({ok:true,...reserveCloudCandidates_(data)});
    if(action==='releaseCloudCandidates')return json_({ok:true,...releaseCloudCandidates_(data)});
    if(action==='upsertCloudMaster')return json_({ok:true,...upsertCloudMaster_(data.row||{})});
    if(action==='completeCloudMunicipality')return json_({ok:true,...completeCloudMunicipality_(data)});
    if(action==='failCloudMunicipality')return json_({ok:true,...failCloudMunicipality_(data)});
    if(action==='upsertMaster')return json_({ok:true,...upsertMaster_(data.row||{})});
    if(action==='upsertMasters'){const items=upsertMasters_(data.rows||[]);return json_({ok:true,items:items});}
    if(action==='upsertMunicipality')return json_({ok:true,...upsertMunicipality_(data.row||{})});
    if(action==='upsertMunicipalities'){const rows=data.rows||[];upsertMunicipalities_(rows);return json_({ok:true,count:rows.length});}
    if(action==='setJobState'){setJobState_(data.state||{});return json_({ok:true});}
    if(action==='appendLog'){
      const sh=ensureSheet_('LOG',HEADERS.LOG); const r=data.row||{}; sh.appendRow([r.timestamp||new Date(),r.level||'',r.message||'']); return json_({ok:true});
    }
    return json_({ok:false,error:'Azione non supportata: '+action});
  }catch(err){return json_({ok:false,error:String(err&&err.message||err)});}
}