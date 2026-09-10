const SPREADSHEET_ID = '1pXRJuIKS9OgdGQI8o3273Y8fVyjm_IIjC0YyLPw4y6g';
const HEADERS = {
  MASTER: ['ID','Nome','Telefono','Sito','Indirizzo','Latitudine','Longitudine','Maps Key','Maps URL','First Seen','Last Seen'],
  COMUNI: ['Codice Coda','Municipality ID','Comune','Provincia','Sigla','Regione','Status','Trovati','Nuovi','Duplicati','Esteri scartati','Ultima scansione','Errore'],
  JOB_STATE: ['Key','Value','Updated At'],
  DA_VERIFICARE: ['ID','Nome','Telefono','Sito','Indirizzo','Latitudine','Longitudine','Motivo','Maps URL'],
  LOG: ['Timestamp','Level','Message']
};

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

function shardFor_(value,workerCount){
  const s=String(value||'');let h=0;
  for(let i=0;i<s.length;i++)h=((h*31)+s.charCodeAt(i))>>>0;
  return h%workerCount;
}

function getCloudWork_(data){
  const workerIndex=Number(data.workerIndex),workerCount=Number(data.workerCount),limit=Math.max(1,Math.min(50,Number(data.limit)||8));
  const afterRow=Math.max(1,Number(data.afterRow)||1);
  if(!Number.isInteger(workerIndex)||!Number.isInteger(workerCount)||workerCount<1||workerIndex<0||workerIndex>=workerCount)throw new Error('Shard cloud non valido');
  const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),last=sh.getLastRow();if(last<2)return [];
  const values=sh.getRange(2,1,last-1,13).getValues(),out=[];
  for(let i=0;i<values.length&&out.length<limit;i++){
    const sheetRow=i+2;if(sheetRow<=afterRow)continue;
    const r=values[i],municipalityId=String(r[1]||'').trim(),status=String(r[6]||'').trim().toUpperCase();
    if(!municipalityId||status!=='TODO'||shardFor_(municipalityId,workerCount)!==workerIndex)continue;
    out.push({sheetRow,queueCode:String(r[0]||''),municipalityId,name:String(r[2]||''),province:String(r[3]||''),provinceCode:String(r[4]||''),region:String(r[5]||''),status:'TODO',lastScanAt:r[11]||''});
  }
  return out;
}

function normalizedMapsUrl_(url){return String(url||'').trim().split('#')[0].split('?')[0].replace(/\/$/,'');}
function normalizedPhone_(phone){return String(phone||'').replace(/\D/g,'').replace(/^0039/,'39').replace(/^39(?=\d{8,})/,'');}
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

function upsertCloudMastersFinal_(candidates){
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const sh=ensureSheet_('MASTER',HEADERS.MASTER),last=sh.getLastRow();
    const values=last>=2?sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues():[];
    const rows=values.map((r,i)=>masterObjectFromValues_(r,i+2));
    const index={mapsKey:{},mapsUrl:{},phone:{},nameAddress:{},nameDomain:{}};
    const put=(row,idx)=>{
      const f=masterFingerprint_(row);
      Object.keys(index).forEach(k=>{if(f[k]&&index[k][f[k]]===undefined)index[k][f[k]]=idx;});
    };
    rows.forEach((r,i)=>put(r,i));
    let nextId=nextFmiNumber_(values);
    const items=[]; const now=new Date().toISOString();

    (candidates||[]).forEach(candidate=>{
      const f=masterFingerprint_(candidate||{});
      let idx=-1,reason='';
      for(const k of ['mapsKey','mapsUrl','phone','nameAddress','nameDomain']){
        if(f[k]&&index[k][f[k]]!==undefined){idx=index[k][f[k]];reason=k;break;}
      }
      if(idx>=0){
        rows[idx]=mergeMaster_(rows[idx],candidate,now);put(rows[idx],idx);
        items.push({mode:'updated',reason,sheetRow:idx+2,id:rows[idx].id,mapsKey:rows[idx].mapsKey,mapsUrl:rows[idx].mapsUrl});
      }else{
        const id=candidate.id||`FMI-${String(nextId++).padStart(7,'0')}`;
        const row=mergeMaster_({},Object.assign({},candidate,{id}),now);
        rows.push(row);idx=rows.length-1;put(row,idx);
        items.push({mode:'inserted',reason:'new',sheetRow:idx+2,id:row.id,mapsKey:row.mapsKey,mapsUrl:row.mapsUrl});
      }
    });

    if(rows.length)sh.getRange(2,1,rows.length,HEADERS.MASTER.length).setValues(rows.map(masterValues_));
    return items;
  }finally{lock.releaseLock();}
}

function completeCloudMunicipality_(data){
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),row=findRow_(sh,2,data.municipalityId);if(row<0)throw new Error('Municipality ID non trovato');
    const currentStatus=String(sh.getRange(row,7).getValue()||'').toUpperCase();
    if(currentStatus==='COMPLETED')return {alreadyCompleted:true,sheetRow:row};
    const completedAt=data.completedAt||new Date().toISOString();
    sh.getRange(row,7,1,7).setValues([['COMPLETED',Number(data.foundCount)||0,Number(data.newCount)||0,Number(data.duplicateCount)||0,Number(data.foreignCount)||0,completedAt,'']]);
    return {alreadyCompleted:false,sheetRow:row,completedAt};
  }finally{lock.releaseLock();}
}
function failCloudMunicipality_(data){
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const sh=ensureSheet_('COMUNI',HEADERS.COMUNI),row=findRow_(sh,2,data.municipalityId);if(row<0)throw new Error('Municipality ID non trovato');
    sh.getRange(row,13).setValue(String(data.error||'Errore worker cloud').slice(0,500));return {sheetRow:row};
  }finally{lock.releaseLock();}
}

function doGet(){ensureAll_();const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}
function doPost(e){
  try{
    ensureAll_();const data=JSON.parse((e&&e.postData&&e.postData.contents)||'{}'),action=data.action||'';
    if(action==='ping'){const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}
    if(action==='getCloudWork')return json_({ok:true,rows:getCloudWork_(data)});
    if(action==='getCloudDedupIndex')return json_({ok:true,...getCloudDedupIndex_()});
    if(action==='getCloudMasterSnapshot')return json_({ok:true,rows:getCloudMasterSnapshot_()});
    if(action==='upsertCloudMastersFinal')return json_({ok:true,items:upsertCloudMastersFinal_(data.rows||[])});
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
