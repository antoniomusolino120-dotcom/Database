from pathlib import Path

p = Path('apps-script/Code.gs')
s = p.read_text()

old_phone = "function normalizedPhone_(phone){return String(phone||'').replace(/\\D/g,'').replace(/^0039/,'39').replace(/^39(?=\\d{8,})/,'');}"
new_phone = """function normalizedPhone_(phone){
  const raw=String(phone??'').trim();
  let digits=raw.replace(/\\D/g,'');
  if(/^\\+\\s*39/.test(raw))digits=digits.slice(2);
  else if(digits.indexOf('0039')===0)digits=digits.slice(4);
  return digits;
}"""
if old_phone not in s:
    raise SystemExit('normalizedPhone_ block not found')
s = s.replace(old_phone, new_phone, 1)

old_func = """function dedupAndWriteFinalUnlocked_(candidates){
  const sh=ensureSheet_('MASTER',HEADERS.MASTER),last=sh.getLastRow();
  const values=last>=2?sh.getRange(2,1,last-1,HEADERS.MASTER.length).getValues():[];
  const rows=values.map((r,i)=>masterObjectFromValues_(r,i+2));
  const index={mapsKey:{},mapsUrl:{},phone:{},nameAddress:{},nameDomain:{}};
  const put=(row,idx)=>{
    const f=masterFingerprint_(row);
    Object.keys(index).forEach(k=>{if(f[k]&&index[k][f[k]]===undefined)index[k][f[k]]=idx;});
  };
  rows.forEach((r,i)=>put(r,i));
  let nextId=nextFmiNumber_(values),inserted=0,duplicates=0;
  const changedExisting={},newRows=[],items=[],now=nowIso_();

  (candidates||[]).forEach(candidate=>{
    const f=masterFingerprint_(candidate||{});
    let idx=-1,reason='';
    for(const k of ['mapsKey','mapsUrl','phone','nameAddress','nameDomain']){
      if(f[k]&&index[k][f[k]]!==undefined){idx=index[k][f[k]];reason=k;break;}
    }
    if(idx>=0){
      rows[idx]=mergeMaster_(rows[idx],candidate,now);put(rows[idx],idx);
      if(idx<values.length)changedExisting[idx]=rows[idx];
      else newRows[idx-values.length]=rows[idx];
      duplicates++;
      items.push({mode:'updated',reason,sheetRow:idx+2,id:rows[idx].id,mapsKey:rows[idx].mapsKey,mapsUrl:rows[idx].mapsUrl});
    }else{
      const id=candidate.id||`FMI-${String(nextId++).padStart(7,'0')}`;
      const row=mergeMaster_({},Object.assign({},candidate,{id}),now);
      rows.push(row);idx=rows.length-1;put(row,idx);
      newRows.push(row);inserted++;
      items.push({mode:'inserted',reason:'new',sheetRow:idx+2,id:row.id,mapsKey:row.mapsKey,mapsUrl:row.mapsUrl});
    }
  });

  Object.keys(changedExisting).forEach(k=>{
    const idx=Number(k);sh.getRange(idx+2,1,1,HEADERS.MASTER.length).setValues([masterValues_(changedExisting[idx])]);
  });
  if(newRows.length)sh.getRange(last+1,1,newRows.length,HEADERS.MASTER.length).setValues(newRows.map(masterValues_));
  return {items,inserted,duplicates};
}"""

new_func = """function mapsKeyConflict_(a,b){
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
}"""

if old_func not in s:
    raise SystemExit('dedupAndWriteFinalUnlocked_ block not found')
s = s.replace(old_func, new_func, 1)
p.write_text(s)
print('Apps Script dedup safety patch applied')
