import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const candidates=[
  path.resolve('..','apps-script','Code.gs'),
  path.resolve('apps-script','Code.gs'),
];
const codePath=candidates.find(p=>fs.existsSync(p));
if(!codePath)throw new Error('apps-script/Code.gs non trovato');
const source=fs.readFileSync(codePath,'utf8')+`\n;globalThis.__orchestrationTestApi={workersReadyForStart_,blockingWorkers_,workerIsStalled_,isTerminalWorkerStatus_};`;
const context={console};
vm.createContext(context);
vm.runInContext(source,context,{filename:'Code.gs'});
const api=context.__orchestrationTestApi;

function run(status='INCOMPLETE',count=10){return {runId:'run-1',status,workerCount:count};}
function state(statuses){
  const out={};
  statuses.forEach((status,i)=>{out['CLOUD_WORKER_'+i]={runId:'run-1',workerIndex:i,status,lastSeen:new Date().toISOString(),leaseUntil:null};});
  return out;
}

test('AVVIA resta bloccato durante un run attivo anche se tutte le card risultano terminali',()=>{
  const map=state(Array(10).fill('DONE'));
  assert.equal(api.workersReadyForStart_(run('RUNNING'),map),false);
});

test('AVVIA si abilita solo quando tutte le 10 card sono terminali',()=>{
  const statuses=['DONE','READY','DONE','DONE','READY','DONE','DONE','DONE','DONE','DONE'];
  assert.equal(api.workersReadyForStart_(run('INCOMPLETE'),state(statuses)),true);
});

test('un solo worker ancora in chiusura blocca il nuovo run',()=>{
  const statuses=Array(10).fill('DONE');statuses[6]='STOPPING';
  const map=state(statuses);
  assert.equal(api.workersReadyForStart_(run('INCOMPLETE'),map),false);
  assert.deepEqual(Array.from(api.blockingWorkers_(run('INCOMPLETE'),map)),[6]);
});

test('un worker mancante blocca il nuovo run',()=>{
  const map=state(Array(9).fill('DONE'));
  assert.equal(api.workersReadyForStart_(run('STOPPED'),map),false);
  assert.deepEqual(Array.from(api.blockingWorkers_(run('STOPPED'),map)),[9]);
});

test('READY, DONE e OFFLINE sono gli unici stati terminali ammessi',()=>{
  for(const status of ['READY','DONE','OFFLINE'])assert.equal(api.isTerminalWorkerStatus_(status),true);
  for(const status of ['WORKING','IDLE','QUEUED','PAUSING','STOPPING','CLOSING','STALLED'])assert.equal(api.isTerminalWorkerStatus_(status),false);
});

test('lease scaduta rende non terminale il worker stalled, DONE resta terminale',()=>{
  const now=Date.now();
  assert.equal(api.workerIsStalled_({status:'WORKING',leaseUntil:new Date(now-1000).toISOString(),lastSeen:new Date(now-1000).toISOString()},now),true);
  assert.equal(api.workerIsStalled_({status:'DONE',leaseUntil:new Date(now-1000).toISOString(),lastSeen:new Date(now-9999999).toISOString()},now),false);
});
