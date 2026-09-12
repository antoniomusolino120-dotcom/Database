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
const source=fs.readFileSync(codePath,'utf8')+`\n;globalThis.__orchestrationTestApi={workersReadyForStart_,blockingWorkers_,workerIsStalled_,isTerminalWorkerStatus_,stalledWorkersClosePatch_};`;
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

test('la chiusura recupera un worker morto dopo la deadline senza saltare il comune',()=>{
  const now=Date.parse('2026-09-12T06:00:00.000Z');
  const currentRun={runId:'run-1',status:'RUNNING',workerCount:10,deadlineAt:'2026-09-12T05:39:00.000Z'};
  const map=state(Array(10).fill('DONE'));
  map.CLOUD_WORKER_7={
    runId:'run-1',workerIndex:7,status:'WORKING',
    municipalityId:'60017',municipalityName:'Casalattico',queueCode:'COMUNE-01425',
    claimToken:'claim-casalattico',claimSheetRow:1426,
    leaseUntil:'2026-09-12T03:23:13.967Z',lastSeen:'2026-09-12T03:08:13.967Z',events:[]
  };
  const recovery=api.stalledWorkersClosePatch_(currentRun,map,now);
  assert.deepEqual(Array.from(recovery.recovered),[7]);
  assert.equal(map.CLOUD_WORKER_7.status,'DONE');
  assert.equal(map.CLOUD_WORKER_7.phase,'LEASE SCADUTA · RECUPERATO');
  assert.equal(map.CLOUD_WORKER_7.claimToken,'');
  assert.equal(map.CLOUD_WORKER_7.claimSheetRow,0);
  assert.equal(map.CLOUD_WORKER_7.municipalityId,'');
  assert.equal(api.blockingWorkers_({...currentRun,status:'INCOMPLETE'},map).length,0);
  assert.equal(api.workersReadyForStart_({...currentRun,status:'INCOMPLETE'},map),true);
});

test('prima della deadline una lease scaduta non viene chiusa automaticamente',()=>{
  const now=Date.parse('2026-09-12T05:00:00.000Z');
  const currentRun={runId:'run-1',status:'RUNNING',workerCount:1,deadlineAt:'2026-09-12T05:39:00.000Z'};
  const map=state(['WORKING']);
  map.CLOUD_WORKER_0.leaseUntil='2026-09-12T04:45:00.000Z';
  const recovery=api.stalledWorkersClosePatch_(currentRun,map,now);
  assert.deepEqual(Array.from(recovery.recovered),[]);
  assert.equal(map.CLOUD_WORKER_0.status,'WORKING');
});
