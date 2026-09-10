import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateCandidates, normalizedPhone } from './dedup.mjs';

test('dedup finale unifica candidati di worker diversi con stessa Maps Key',()=>{
  const candidates=[
    {workerIndex:0,municipalityId:'A',row:{name:'Black Ink',address:'Via Roma 1',phone:'+39 333 111 2222',mapsKey:'k1',mapsUrl:'https://maps.google.com/place/x?foo=1'}},
    {workerIndex:4,municipalityId:'B',row:{name:'Black Ink',address:'Via Roma 1',phone:'3331112222',website:'https://blackink.it',mapsKey:'k1'}},
  ];
  const r=deduplicateCandidates([],candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
  assert.equal(r.municipalityStats.A.newCount,1);
  assert.equal(r.municipalityStats.B.finalDuplicates,1);
  assert.equal(r.actions[0].row.website,'https://blackink.it');
});

test('candidato già in MASTER con stessa Maps Key viene classificato come duplicato',()=>{
  const master=[{id:'FMI-0000001',name:'Studio Uno',address:'Corso Italia 2',phone:'021234567',mapsKey:'abc'}];
  const candidates=[{municipalityId:'X',row:{name:'Studio Uno',address:'Corso Italia 2',phone:'02 1234567',mapsKey:'abc'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'updated');
  assert.equal(r.municipalityStats.X.newCount,0);
  assert.equal(r.municipalityStats.X.finalDuplicates,1);
});

test('stesso nome ma indirizzo e telefono diversi resta distinto',()=>{
  const master=[{id:'FMI-0000001',name:'Ink Lab',address:'Via A 1',phone:'1111111111'}];
  const candidates=[{municipalityId:'X',row:{name:'Ink Lab',address:'Via B 2',phone:'2222222222'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
  assert.equal(r.municipalityStats.X.newCount,1);
});

test('stesso telefono con Maps Key diverse resta distinto',()=>{
  const master=[{id:'FMI-0000001',name:'Catena Ink Milano',address:'Via A 1 Milano',phone:'+39 333 111 2222',mapsKey:'milano'}];
  const candidates=[{municipalityId:'X',row:{name:'Catena Ink Monza',address:'Via B 2 Monza',phone:'+39 333 111 2222',mapsKey:'monza'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
  assert.equal(r.municipalityStats.X.newCount,1);
});

test('stesso dominio con Maps Key diverse resta distinto',()=>{
  const master=[{id:'FMI-0000001',name:'Catena Ink Milano',address:'Via A 1 Milano',website:'https://catena.example/',mapsKey:'milano'}];
  const candidates=[{municipalityId:'X',row:{name:'Catena Ink Monza',address:'Via B 2 Monza',website:'https://catena.example/sedi/monza',mapsKey:'monza'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
});

test('stesso nome e indirizzo ma Maps Key diverse resta distinto',()=>{
  const master=[{id:'FMI-0000001',name:'Ink House',address:'Via Roma 1',mapsKey:'old-place'}];
  const candidates=[{municipalityId:'X',row:{name:'Ink House',address:'Via Roma 1',mapsKey:'new-place'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
});

test('senza Maps Key, stesso nome e indirizzo viene unificato',()=>{
  const master=[{id:'FMI-0000001',name:'Ink House',address:'Via Roma, 1',phone:'3331112222'}];
  const candidates=[{municipalityId:'X',row:{name:'INK HOUSE',address:'Via Roma 1',phone:'+39 333 111 2222'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'updated');
  assert.equal(r.municipalityStats.X.finalDuplicates,1);
});

test('telefono da solo non elimina un lead',()=>{
  const master=[{id:'FMI-0000001',name:'Studio A',address:'Via A 1',phone:'+39 333 111 2222'}];
  const candidates=[{municipalityId:'X',row:{name:'Studio B',address:'Via B 2',phone:'+39 333 111 2222'}}];
  const r=deduplicateCandidates(master,candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
});

test('numero italiano che inizia per 39 non perde le prime cifre senza prefisso esplicito',()=>{
  assert.equal(normalizedPhone('3924272477'),'3924272477');
  assert.equal(normalizedPhone('+39 392 427 2477'),'3924272477');
  assert.equal(normalizedPhone('0039 392 427 2477'),'3924272477');
});
