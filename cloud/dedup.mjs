export function normalizedMapsUrl(url='') {
  return String(url||'').trim().split('#')[0].split('?')[0].replace(/\/$/,'');
}
export function normalizedPhone(phone='') {
  const raw=String(phone??'').trim();
  let digits=raw.replace(/\D/g,'');
  if(/^\+\s*39/.test(raw)) digits=digits.slice(2);
  else if(digits.startsWith('0039')) digits=digits.slice(4);
  return digits;
}
export function normalizedText(s='') {
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}
export function normalizedDomain(website='') {
  let s=String(website||'').trim().toLowerCase();
  if(!s) return '';
  return s.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split('?')[0].split('#')[0];
}
function has(v){ return v !== undefined && v !== null && String(v).trim() !== ''; }
function mergeSparse(base={}, incoming={}) {
  const out={...base};
  for(const [k,v] of Object.entries(incoming||{})) if(!has(out[k]) && has(v)) out[k]=v;
  return out;
}
function fp(row={}) {
  const name=normalizedText(row.name), address=normalizedText(row.address);
  return {
    mapsKey:String(row.mapsKey||'').trim(),
    mapsUrl:normalizedMapsUrl(row.mapsUrl),
    nameAddress:name&&address?`${name}\u0000${address}`:'',
  };
}
function emptyIndex(){ return {mapsKey:new Map(),mapsUrl:new Map(),nameAddress:new Map()}; }
function addWeak(map,key,target){
  if(!key) return;
  const list=map.get(key)||[];
  if(!list.some(x=>x.key===target.key)) list.push(target);
  map.set(key,list);
}
function addToIndex(index,row,target){
  const f=fp(row);
  if(f.mapsKey&&!index.mapsKey.has(f.mapsKey)) index.mapsKey.set(f.mapsKey,target);
  if(f.mapsUrl&&!index.mapsUrl.has(f.mapsUrl)) index.mapsUrl.set(f.mapsUrl,target);
  addWeak(index.nameAddress,f.nameAddress,target);
}
function mapsKeyConflict(a,b){
  const ak=String(a?.mapsKey||'').trim(),bk=String(b?.mapsKey||'').trim();
  return Boolean(ak&&bk&&ak!==bk);
}
function findInIndex(index,row){
  const f=fp(row);
  if(f.mapsKey&&index.mapsKey.has(f.mapsKey)) return {target:index.mapsKey.get(f.mapsKey),reason:'mapsKey'};
  if(f.mapsUrl&&index.mapsUrl.has(f.mapsUrl)) return {target:index.mapsUrl.get(f.mapsUrl),reason:'mapsUrl'};
  if(f.nameAddress){
    for(const target of index.nameAddress.get(f.nameAddress)||[]){
      if(!mapsKeyConflict(row,target.row)) return {target,reason:'nameAddress'};
    }
  }
  return null;
}
export function deduplicateCandidates(masterRows=[], candidates=[]) {
  const index=emptyIndex();
  const actions=[];
  const actionByKey=new Map();
  const municipalityStats={};
  const statsFor=id => municipalityStats[id] ||= {newCount:0, finalDuplicates:0};

  for(let i=0;i<masterRows.length;i++){
    const row=masterRows[i]||{};
    const key=`existing:${row.id||row.sheetRow||i}`;
    const target={kind:'existing',key,row};
    addToIndex(index,row,target);
  }

  for(let i=0;i<candidates.length;i++){
    const item=candidates[i]||{};
    const row={...(item.row||item.candidate||item)};
    const municipalityId=String(item.municipalityId||'');
    if(!municipalityId) continue;
    const stat=statsFor(municipalityId);
    const match=findInIndex(index,row);

    if(match){
      stat.finalDuplicates++;
      const target=match.target;
      let action=actionByKey.get(target.key);
      if(!action){
        action={key:target.key,expectedMode:'updated',originMunicipalityId:municipalityId,reason:match.reason,row:mergeSparse(target.row,row)};
        actions.push(action); actionByKey.set(target.key,action);
      }else action.row=mergeSparse(action.row,row);
      const indexedTarget={kind:target.kind,key:target.key,row:action.row};
      addToIndex(index,action.row,indexedTarget);
      continue;
    }

    const key=`new:${actions.length}`;
    const action={key,expectedMode:'inserted',originMunicipalityId:municipalityId,reason:'new',row};
    actions.push(action); actionByKey.set(key,action);
    stat.newCount++;
    addToIndex(index,row,{kind:'new',key,row});
  }

  return {actions, municipalityStats};
}
