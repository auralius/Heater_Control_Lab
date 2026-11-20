'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
function createWorkerHarness(){
  const messages=[];
  const timers=new Map();let tNext=1;
  const ctx={console,Math,Number,Object,String,Boolean,Array,Error,TypeError,Set,Date};
  ctx.self={postMessage(x){messages.push(x);}};
  ctx.importScripts=function(rel){vm.runInContext(fs.readFileSync(path.join(root,rel),'utf8'), sandbox,{filename:rel});};
  ctx.setInterval=(f, ms)=>{let id=tNext++;timers.set(id,f);return id;};
  ctx.clearInterval=(id)=>timers.delete(id);
  const sandbox=vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'worker.js'),'utf8'),sandbox,{filename:'worker.js'});
  const send=(kind,payload={})=>sandbox.self.onmessage({data:{kind,...payload}});
  const last=(kind)=>messages.filter(x=>x.kind===kind).at(-1);
  return {send,messages,last,timers};
}
const base=`function init(){ memory.calls=0; memory.x=1; }\nfunction controller(){ memory.calls++; return 35; }`;
test('worker loads and runs init before initial frame',()=>{
  const w=createWorkerHarness();w.send('load',{source:base});
  assert.ok(w.last('ready'));
  assert.equal(w.last('frames').rows[0].temperature,25);
  w.send('step');
  const f=w.last('frames').rows[0];
  assert.equal(f.power,35);assert.equal(f.t,0.2);
});
test('global objects accessible from helper functions',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:`function helper(){return state.target.temperature > state.temperature ? params.uMax : 0;}\nfunction controller(){ return helper(); }`});
  w.send('step');
  assert.equal(w.last('frames').rows[0].power,100);
});
test('memory explicitly updated by code and carried across steps',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:`function init(){memory.counter=0;} function controller(){ memory.counter++;return memory.counter*3; }`});
  w.send('step');assert.equal(w.last('frames').rows[0].power,3);
  w.send('step');assert.equal(w.last('frames').rows[0].power,6);
  w.send('reset');w.send('step');assert.equal(w.last('frames').rows[0].power,3);
});
test('optional init and legacy controller argument signature supported',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:'function controller(state,params,memory){ return {power: params.uMax/2}; }'});
  w.send('step');assert.equal(w.last('frames').rows[0].power,50);
});
test('student cannot modify read-only state or params',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:'function controller(){state.temperature=500;return 20;}'});
  w.send('step');assert.match(w.last('error').message,/read only|Cannot assign/);
});
test('invalid output is rejected and leaves worker stopped',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:'function controller(){return undefined;}'});
  w.send('step');assert.match(w.last('error').message,/finite number/);
});
test('load test uses independent memory and init for every scenario',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:`function init(){memory.calls=0;} function controller(){memory.calls++;return memory.calls<2?99:0;}`});
  w.send('step');
  w.send('test');
  const result=w.last('test-results');
  assert.equal(result.results.length,4);
  assert.equal(JSON.stringify(result.results.map(x=>x.mode)),JSON.stringify(['setpoint','switch','ramp','load']));
  assert.equal(w.last('error'),undefined);
});
test('pause and resume do not reset controller memory',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:`function init(){memory.count=0;} function controller(){memory.count++;return memory.count;}`});
  w.send('step');
  w.send('pause');
  w.send('start');
  assert.equal(w.timers.size,1);
  w.send('pause');
  w.send('step');
  assert.equal(w.last('frames').rows[0].power,2);
});
test('manual target reflects in global state and changes without reset',()=>{
  const w=createWorkerHarness();
  w.send('load',{source:'function controller(){return state.target.temperature;} ',setpoint:70});
  w.send('step');assert.equal(w.last('frames').rows[0].power,70);
  w.send('target',{target:80});w.send('step');assert.equal(w.last('frames').rows[0].power,80);
});
