const DEFAULT_SPREADSHEET_ID = '1pXRJuIKS9OgdGQI8o3273Y8fVyjm_IIjC0YyLPw4y6g';

function normalizeEndpoint(url='') {
  const v=String(url||'').trim();
  if (!v) return '';
  if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(v)) throw new Error('Endpoint Apps Script non valido');
  return v;
}

export class SheetsService {
  constructor(userDataPath, db, spreadsheetId=DEFAULT_SPREADSHEET_ID) {
    this.userDataPath=userDataPath;
    this.db=db;
    this.spreadsheetId=db.getSetting('spreadsheetId',spreadsheetId||DEFAULT_SPREADSHEET_ID);
    this.endpoint=db.getSetting('sheetEndpoint','');
    this.connected=false;
  }

  setSpreadsheetId(id){this.spreadsheetId=id||DEFAULT_SPREADSHEET_ID;this.db.setSetting('spreadsheetId',this.spreadsheetId);}
  getEndpoint(){return this.endpoint||'';}
  isConnected(){return Boolean(this.endpoint&&this.connected);}
  hasEndpoint(){return Boolean(this.endpoint);}

  async request(action,payload={},timeoutMs=25000) {
    if (!this.endpoint) throw new Error('Configura prima l’endpoint Apps Script del foglio');
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const res=await fetch(this.endpoint,{
        method:'POST',
        headers:{'Content-Type':'text/plain;charset=utf-8'},
        body:JSON.stringify({action,spreadsheetId:this.spreadsheetId,...payload}),
        signal:controller.signal,
        redirect:'follow'
      });
      if (!res.ok) throw new Error(`Sheet bridge HTTP ${res.status}`);
      const text=await res.text();
      let data; try{data=JSON.parse(text);}catch{throw new Error(`Risposta Apps Script non valida: ${text.slice(0,140)}`);}
      if (!data.ok) throw new Error(data.error||'Errore Apps Script');
      return data;
    } finally {clearTimeout(timer);}
  }

  async configureEndpoint(url) {
    const endpoint=normalizeEndpoint(url);
    this.endpoint=endpoint;
    this.db.setSetting('sheetEndpoint',endpoint);
    this.connected=false;
    if (!endpoint) return {connected:false};
    return this.testConnection();
  }

  async testConnection(){
    const data=await this.request('ping',{expectedSpreadsheetId:this.spreadsheetId});
    if (data.spreadsheetId && data.spreadsheetId!==this.spreadsheetId) throw new Error('L’endpoint Apps Script punta a un altro Google Sheet');
    this.connected=true;
    return {connected:true,spreadsheetId:data.spreadsheetId||this.spreadsheetId,title:data.title||''};
  }

  entityRow(entity){
    return {
      id:entity.public_id||'',name:entity.name||'',phone:entity.phone||'',website:entity.website||'',address:entity.address||'',
      lat:entity.lat??'',lng:entity.lng??'',mapsKey:entity.maps_key||'',mapsUrl:entity.maps_url||'',firstSeen:entity.first_seen||'',lastSeen:entity.last_seen||''
    };
  }

  async syncEntity(entity){
    const r=await this.syncEntities([entity]);
    return r.items?.[0]||{mode:'updated'};
  }

  async syncEntities(entities){
    if(!entities.length)return {items:[],inserted:0,updated:0};
    const data=await this.request('upsertMasters',{rows:entities.map(e=>this.entityRow(e))});
    const items=data.items||[];
    let inserted=0,updated=0;
    entities.forEach((entity,i)=>{const item=items[i]||{};this.db.markEntitySynced(entity.entity_no,item.sheetRow||null);if(item.mode==='inserted')inserted++;else updated++;});
    return {items,inserted,updated};
  }

  async syncDirtyEntities(limit=250){
    if(!this.endpoint)return {inserted:0,updated:0,failed:0};
    const entities=this.db.unsyncedEntities(limit);
    if(!entities.length)return {inserted:0,updated:0,failed:0};
    try{
      const r=await this.syncEntities(entities);this.connected=true;return {inserted:r.inserted,updated:r.updated,failed:0};
    }catch(err){
      this.connected=false;this.db.log('warn','Sync Sheet fallita',{error:err.message});return {inserted:0,updated:0,failed:entities.length,error:err.message};
    }
  }

  async syncMunicipality(m){
    if (!this.endpoint) return null;
    return this.request('upsertMunicipality',{row:{
      queueCode:m.queueCode||m.queue_code,municipalityId:m.municipalityId||m.municipality_id,name:m.name,province:m.province||'',provinceCode:m.provinceCode||m.province_code||'',region:m.region||'',status:m.status,
      foundCount:m.found_count??m.foundCount??0,newCount:m.new_count??m.newCount??0,duplicateCount:m.duplicate_count??m.duplicateCount??0,foreignCount:m.foreign_count??m.foreignCount??0,lastScanAt:m.last_scan_at||m.lastScanAt||'',errorText:m.error_text||m.errorText||''
    }});
  }

  async syncJobState(state){if(!this.endpoint)return null;return this.request('setJobState',{state});}

  async syncAll(batch=250,onProgress=()=>{}){
    if (!this.endpoint) throw new Error('Configura prima l’endpoint Apps Script');
    await this.testConnection();
    let totalInserted=0,totalUpdated=0,totalFailed=0;
    while (true) {
      const before=this.db.unsyncedEntities(batch).length;
      if (!before) break;
      const r=await this.syncDirtyEntities(batch);
      totalInserted+=r.inserted;totalUpdated+=r.updated;totalFailed+=r.failed;
      onProgress({inserted:totalInserted,updated:totalUpdated,failed:totalFailed});
      if (r.failed || (r.inserted+r.updated)===0) break;
    }
    const municipalities=this.db.listMunicipalities({limit:10000,offset:0});
    for (let i=0;i<municipalities.length;i+=300) {
      await this.request('upsertMunicipalities',{rows:municipalities.slice(i,i+300)});
      onProgress({municipalities:Math.min(i+300,municipalities.length),municipalitiesTotal:municipalities.length});
    }
    await this.syncJobState(this.db.getCollectorState());
    return {inserted:totalInserted,updated:totalUpdated,failed:totalFailed,municipalities:municipalities.length};
  }
}

export { DEFAULT_SPREADSHEET_ID };
