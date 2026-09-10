import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// In CI i test girano dentro findmyink-collector: il Code.gs autorevole è quello
// del repository, non l'eventuale copia storica contenuta nello zip ricostruito.
const candidates=[
  path.resolve('..','apps-script','Code.gs'),
  path.resolve('apps-script','Code.gs'),
];
const codePath=candidates.find(p=>fs.existsSync(p));
if(!codePath) throw new Error('apps-script/Code.gs non trovato');
const source=fs.readFileSync(codePath,'utf8')+`\n;globalThis.__dedupTestApi={normalizedPhone_,masterFingerprint_,mapsKeyConflict_,findFinalDuplicate_};`;
const context={console};
vm.createContext(context);
vm.runInContext(source,context,{filename:'Code.gs'});
const api=context.__dedupTestApi;

function buildIndex(rows){
  const index={mapsKey:{},mapsUrl:{},nameAddress:{}};
  rows.forEach((row,idx)=>{
    const f=api.masterFingerprint_(row);
    if(f.mapsKey&&index.mapsKey[f.mapsKey]===undefined)index.mapsKey[f.mapsKey]=idx;
    if(f.mapsUrl&&index.mapsUrl[f.mapsUrl]===undefined)index.mapsUrl[f.mapsUrl]=idx;
    if(f.nameAddress){
      const list=index.nameAddress[f.nameAddress]||(index.nameAddress[f.nameAddress]=[]);
      if(!list.includes(idx))list.push(idx);
    }
  });
  return index;
}
function match(rows,candidate){return api.findFinalDuplicate_(buildIndex(rows),rows,candidate);}

test('Apps Script: stessa Maps Key è duplicato certo',()=>{
  const rows=[{name:'Studio A',address:'Via A 1',mapsKey:'same'}];
  assert.equal(match(rows,{name:'Altro nome',address:'Altro',mapsKey:'same'}).reason,'mapsKey');
});

test('Apps Script: stessa Maps URL è duplicato certo',()=>{
  const rows=[{name:'Studio A',address:'Via A 1',mapsUrl:'https://maps.google.com/place/a?hl=it'}];
  assert.equal(match(rows,{name:'Studio A',address:'Via A 1',mapsUrl:'https://maps.google.com/place/a?hl=en'}).reason,'mapsUrl');
});

test('Apps Script: Maps Key diverse impediscono merge anche con stesso nome e indirizzo',()=>{
  const rows=[{name:'Ink House',address:'Via Roma 1',mapsKey:'key-a',phone:'3331112222',website:'https://chain.example'}];
  const result=match(rows,{name:'Ink House',address:'Via Roma 1',mapsKey:'key-b',phone:'3331112222',website:'https://chain.example'});
  assert.equal(result.idx,-1);
});

test('Apps Script: telefono uguale da solo non elimina un lead',()=>{
  const rows=[{name:'Studio A',address:'Via A 1',phone:'+39 333 111 2222'}];
  const result=match(rows,{name:'Studio B',address:'Via B 2',phone:'+39 333 111 2222'});
  assert.equal(result.idx,-1);
});

test('Apps Script: dominio uguale da solo non elimina un lead',()=>{
  const rows=[{name:'Catena Milano',address:'Via A 1',website:'https://chain.example',mapsKey:'a'}];
  const result=match(rows,{name:'Catena Monza',address:'Via B 2',website:'https://chain.example/sede',mapsKey:'b'});
  assert.equal(result.idx,-1);
});

test('Apps Script: senza Maps Key stesso nome+indirizzo è fallback duplicato',()=>{
  const rows=[{name:'Ink House',address:'Via Roma, 1'}];
  const result=match(rows,{name:'INK HOUSE',address:'Via Roma 1'});
  assert.equal(result.reason,'nameAddress');
});

test('Apps Script: numero che inizia con 39 non viene troncato senza prefisso esplicito',()=>{
  assert.equal(api.normalizedPhone_('3924272477'),'3924272477');
  assert.equal(api.normalizedPhone_('+39 392 427 2477'),'3924272477');
  assert.equal(api.normalizedPhone_('0039 392 427 2477'),'3924272477');
});
