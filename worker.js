'use strict';
importScripts('./physics.js');
const H = self.HeaterPhysics;
let params = H.sanitizeConfig(H.DEFAULTS);
let scenario = 'setpoint';
let manualTarget = null;
let plant = H.createPlant(params, scenario, manualTarget);
let userSource = '';
let runtime = null;
let memory = {};
let timer = null;
let speed = 8;
let budget = 0;

function stop() { if (timer !== null) clearInterval(timer); timer = null; }
function safeError(err) { stop(); self.postMessage({ kind: 'error', message: String(err && err.message || err) }); }
function readonlyContext(p) {
  const row = H.sample(p);
  const state = {
    t: row.t,
    temperature: row.temperature,
    ambient: row.ambient,
    target: Object.freeze({ temperature: row.target }),
    power: row.power,
    delayedPower: row.delayedPower,
    disturbance: row.disturbance,
    error: row.error
  };
  return Object.freeze(state);
}
function compile(source) {
  // The bindings are script-local in the student's JS scope, not page globals.
  // This Worker isolates UI responsiveness; arbitrary student code is NOT sandboxed.
  const factory = new Function('"use strict";\n'
    + 'let state, params, memory;\n'
    + source + '\n'
    + 'if (typeof controller !== "function") return null;\n'
    + 'const studentInit = typeof init === "function" ? init : null;\n'
    + 'function bind(s,p,m) {state=s;params=p;memory=m;}\n'
    + 'return {\n'
    + '  initialize(s,p,m) {bind(s,p,m); if(studentInit) studentInit(s,p,m);},\n'
    + '  invoke(s,p,m) {bind(s,p,m); return controller(s,p,m);}\n'
    + '};');
  const value = factory();
  if (!value) throw new Error('Please define function controller().');
  return value;
}
function heaterCommand(result) {
  const u = (result && typeof result === 'object') ? result.power : result;
  if (typeof u !== 'number' || !Number.isFinite(u))
    throw new Error('controller() must return a finite number (heater %, e.g. return 0), or { power: number }.');
  return u; // Physics handles saturation; negative heater power becomes 0.
}
function initializeRuntime(p) {
  const r = compile(userSource);
  const m = {};
  r.initialize(readonlyContext(p), Object.freeze({ ...p.params }), m);
  return { runtime: r, memory: m };
}
function reset() {
  stop(); budget = 0;
  plant = H.createPlant(params, scenario, manualTarget);
  runtime = null;
  memory = {};
  const fresh = initializeRuntime(plant);
  runtime = fresh.runtime;
  memory = fresh.memory;
  self.postMessage({ kind: 'frames', rows: [H.sample(plant)], reason: 'reset' });
}
function oneStep(p, r, m) {
  const requested = heaterCommand(r.invoke(readonlyContext(p), Object.freeze({ ...p.params }), m));
  return H.step(p, requested);
}
function runSteps(count) {
  const rows = [];
  for (let i = 0; i < count && plant.state.t < H.DURATION - 1e-8; i++) {
    rows.push(oneStep(plant, runtime, memory));
  }
  if (rows.length) self.postMessage({ kind: 'frames', rows });
  if (plant.state.t >= H.DURATION - 1e-8) {
    stop(); self.postMessage({ kind: 'done' });
  }
}
function tick() {
  try {
    budget += 0.04 * speed;
    let count = 0;
    while (timer !== null && budget + 1e-9 >= params.dt && count < 160) {
      budget -= params.dt;
      if (budget < 0) budget = 0;
      count++;
    }
    if (count) runSteps(count);
  } catch (err) { safeError(err); }
}
function testCase(mode) {
  const p = H.createPlant(params, mode, null);
  const fresh = initializeRuntime(p);
  const total = Math.round(H.DURATION / params.dt);
  let sum = 0, n = 0, finalSum = 0, lastCount = 0;
  let finalErr = 0, maxOvershoot = 0;
  for (let i = 0; i < total; i++) {
    const row = oneStep(p, fresh.runtime, fresh.memory);
    finalErr = Math.abs(row.error);
    if (row.t >= 80 - 1e-9) { sum += row.error * row.error; n++; }
    if (row.t >= H.DURATION - 20 - 1e-9) { finalSum += Math.abs(row.error); lastCount++; }
    if (row.t >= 50) maxOvershoot = Math.max(maxOvershoot, row.temperature - row.target);
  }
  const rms = Math.sqrt(sum / Math.max(n, 1));
  const finalMean = finalSum / Math.max(lastCount, 1);
  const rule = mode === 'ramp' ? { metric: 'RMS tracking error (80–240 s)', value: rms, threshold: 5 }
    : { metric: 'Mean absolute error (last 20 s)', value: finalMean,
        threshold: mode === 'load' ? 1.5 : mode === 'switch' ? 1.5 : 1 };
  return { mode, passed: rule.value < rule.threshold, ...rule, rms, finalError: finalErr,
    finalMean, maxOvershoot: Math.max(0, maxOvershoot) };
}
self.onmessage = function (event) {
  const msg = event.data || {};
  try {
    switch (msg.kind) {
      case 'load':
        userSource = String(msg.source || '');
        scenario = H.MODES.includes(msg.scenario) ? msg.scenario : 'setpoint';
        params = H.sanitizeConfig(msg.params);
        manualTarget = Number.isFinite(Number(msg.setpoint)) ? H.clamp(Number(msg.setpoint), 20, 100) : null;
        speed = H.clamp(Number(msg.speed) || 8, 1, 40);
        reset();
        self.postMessage({ kind: 'ready' });
        break;
      case 'reset': reset(); self.postMessage({ kind: 'ready' }); break;
      case 'start':
        if (!runtime) throw new Error('Apply your controller first.');
        if (plant.state.t >= H.DURATION - 1e-8) reset();
        stop();
        timer = setInterval(tick, 40);
        self.postMessage({ kind: 'running' });
        break;
      case 'pause': stop(); self.postMessage({ kind: 'paused' }); break;
      case 'step':
        if (!runtime) throw new Error('Apply your controller first.');
        stop(); budget = 0; runSteps(1);
        break;
      case 'speed': speed = H.clamp(Number(msg.speed) || 8, 1, 40); break;
      case 'target':
        if (scenario !== 'setpoint') break;
        manualTarget = H.clamp(Number(msg.target) || 55, 20, 100);
        plant.manualTarget = manualTarget;
        self.postMessage({ kind: 'frames', rows: [H.sample(plant)], reason: 'target' });
        break;
      case 'test':
        stop();
        self.postMessage({ kind: 'test-start' });
        self.postMessage({ kind: 'test-results', results: H.MODES.map(testCase) });
        break;
      default: throw new Error('Unknown command: ' + msg.kind);
    }
  } catch (err) { safeError(err); }
};
