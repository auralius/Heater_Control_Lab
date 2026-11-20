'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../physics.js');
const near = (a, b, tol=1e-9) => assert.ok(Math.abs(a-b) < tol, `${a} != ${b}`);

test('configuration default and sampling periods', () => {
  assert.deepEqual(H.SAMPLE_PERIODS, [0.1,0.2,0.5,1]);
  assert.equal(H.sanitizeConfig({delay:-1,tau:500,dt:0.35}).delay, 0);
  assert.equal(H.sanitizeConfig({delay:-1,tau:500,dt:0.35}).dt, 0.2);
  assert.equal(H.sanitizeConfig({delay:-1,tau:500,dt:0.35}).tau, 120);
});
test('zero heater stays at ambient regardless of delay', () => {
  const p = H.createPlant(H.DEFAULTS, 'setpoint');
  for(let i=0;i<200;i++) H.step(p,0);
  near(p.state.temperature,25);
});
test('temperature cannot change before six-second dead time', () => {
  const p = H.createPlant(H.DEFAULTS,'setpoint');
  for(let i=0;i<30;i++) near(H.step(p,50).temperature,25);
  assert.ok(H.step(p,50).temperature > 25);
});
test('analytic step response after the dead time', () => {
  const p=H.createPlant(H.DEFAULTS,'setpoint');
  for(let i=0;i<200;i++) H.step(p,50);
  const expected = 25 + 0.65*50*(1-Math.exp(-(40-6)/25));
  near(p.state.temperature, expected, 1e-8);
});
test('transport delay smaller than one sample is not rounded away', () => {
  const cfg={...H.DEFAULTS,delay:0.3,dt:0.2};
  const p=H.createPlant(cfg,'setpoint');
  near(H.step(p,100).temperature,25);
  const v=H.step(p,100);
  const expected=H.exponentialStep(25,100,0,cfg,0.1);
  near(v.temperature,expected);
  near(v.delayedPower,50);
});
test('zero delay applies the current command on its first step', () => {
  const p=H.createPlant({...H.DEFAULTS,delay:0}, 'setpoint');
  const r=H.step(p,100);
  near(r.temperature,25+0.65*100*(1-Math.exp(-0.2/25)));
  near(r.delayedPower,100);
});
test('heater input is saturated to [0,uMax]', () => {
  const p=H.createPlant({...H.DEFAULTS,delay:0,uMax:40}, 'setpoint');
  near(H.step(p,-20).power,0);
  near(H.step(p,90).power,40);
});
test('first-order passive cooling after heater is switched off', () => {
  const p=H.createPlant({...H.DEFAULTS,delay:0},'setpoint');
  for(let k=0;k<300;k++) H.step(p,100);
  const first=p.state.temperature;
  for(let k=0;k<100;k++) H.step(p,0);
  assert.ok(first>30);
  assert.ok(p.state.temperature<first);
  assert.ok(p.state.temperature>25);
});
test('scenarios and disturbance switching', () => {
  near(H.targetAt(99,'switch'),50);
  near(H.targetAt(100,'switch'),65);
  near(H.targetAt(20,'ramp'),40);
  near(H.targetAt(140,'ramp'),65);
  near(H.disturbanceAt(99.9,'load'),0);
  near(H.disturbanceAt(100,'load'),-8);
});
test('time derived from sample count avoids cumulative drift', () => {
  const p=H.createPlant({...H.DEFAULTS,dt:0.1,delay:0},'setpoint');
  for(let i=0;i<2400;i++) H.step(p,0);
  assert.equal(p.state.t,240);
});
