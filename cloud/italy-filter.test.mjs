import test from 'node:test';
import assert from 'node:assert/strict';
import { isClearlyOutsideItaly } from './italy-filter.mjs';

test('rejects San Jose by coordinates and US address format',()=>{
  assert.equal(isClearlyOutsideItaly({lat:37.3327524,lng:-121.9,address:'1143 Story Rd #200, San Jose, CA 95122'}),true);
});

test('rejects US address even when coordinates are missing',()=>{
  assert.equal(isClearlyOutsideItaly({address:'1143 Story Rd #200, San Jose, CA 95122'}),true);
});

test('rejects clearly foreign coordinates',()=>{
  assert.equal(isClearlyOutsideItaly({lat:48.8566,lng:2.3522,address:'Paris'}),true);
});

test('keeps normal Italian coordinates and addresses',()=>{
  assert.equal(isClearlyOutsideItaly({lat:45.6282353,lng:9.241645,address:'Viale Martiri della Libertà, 255, 20851 Lissone MB'}),false);
});

test('keeps southern Italian islands inside conservative bounds',()=>{
  assert.equal(isClearlyOutsideItaly({lat:35.5,lng:12.6,address:'Lampedusa e Linosa AG'}),false);
});

test('handles Italian decimal comma strings',()=>{
  assert.equal(isClearlyOutsideItaly({lat:'45,6282353',lng:'9,241645',address:'20851 Lissone MB'}),false);
});
