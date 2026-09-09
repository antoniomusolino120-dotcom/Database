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

function doGet(){ensureAll_();const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}

function doPost(e){
  try{
    ensureAll_(); const data=JSON.parse((e&&e.postData&&e.postData.contents)||'{}'); const action=data.action||'';
    if(action==='ping'){const ss=book_();return json_({ok:true,spreadsheetId:SPREADSHEET_ID,title:ss.getName()});}
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
