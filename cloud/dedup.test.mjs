import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateCandidates } from './dedup.mjs';

test('dedup finale unifica candidati di worker diversi',()=>{
  const candidates=[
    {workerIndex:0,municipalityId:'A',row:{name:'Black Ink',address:'Via Roma 1',phone:'+39 333 111 2222',mapsKey:'k1',mapsUrl:'https://maps.google.com/place/x?foo=1'}},
    {workerIndex:4,municipalityId:'B',row:{name:'Black Ink',address:'Via Roma 1',phone:'3331112222',website:'https://blackink.it'}},
  ];
  const r=deduplicateCandidates([],candidates);
  assert.equal(r.actions.length,1);
  assert.equal(r.actions[0].expectedMode,'inserted');
  assert.equal(r.municipalityStats.A.newCount,1);
  assert.equal(r.municipalityStats.B.finalDuplicates,1);
  assert.equal(r.actions[0].row.website,'https://blackink.it');
});

test('candidato già in MASTER viene classificato come duplicato',()=>{
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
