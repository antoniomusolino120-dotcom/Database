export function normalizedMapsUrl(url='') {
  return String(url||'').trim().split('#')[0].split('?')[0].replace(/\/$/,'');
}
export function normalizedPhone(phone='') {
  return String(phone||'').replace(/\D/g,'').replace(/^0039/,'39').replace(/^39(?=\d{8,})/,'');
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
  const name=normalizedText(row.name), address=normalizedText(row.address), domain=normalizedDomain(row.website);
  return {
    mapsKey:String(row.mapsKey||'').trim(),
    mapsUrl:normalizedMapsUrl(row.mapsUrl),
    phone:normalizedPhone(row.phone),
    nameAddress:name&&address?`${name}\u0000${address}`:'',
    nameDomain:name&&domain?`${name}\u0000${domain}`:'',
  };
}
function emptyIndex(){ return {mapsKey:new Map(),mapsUrl:new Map(),phone:new Map(),nameAddress:new Map(),nameDomain:new Map()}; }
function addToIndex(index,row,target){
  const f=fp(row);
  for(const k of Object.keys(index)) if(f[k] && !index[k].has(f[k])) index[k].set(f[k],target);
}
function findInIndex(index,row){
  const f=fp(row);
  for(const k of ['mapsKey','mapsUrl','phone','nameAddress','nameDomain']) if(f[k] && index[k].has(f[k])) return {target:index[k].get(f[k]),reason:k};
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
      addToIndex(index,action.row,{kind:target.kind,key:target.key,row:action.row});
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
