/* Heater Control Lab — FOPTD physical plant (shared by browser worker / Node tests).
   Model: tau*dT/dt = -(T - ambient) + K*u(t-L) + disturbance.
   u is held (ZOH) over each controller period, with exact transport delay.
   Analytic first-order thermal update between changes of delayed u.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HeaterPhysics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SAMPLE_PERIODS = Object.freeze([0.1, 0.2, 0.5, 1]);
  const DEFAULTS = Object.freeze({ K: 0.65, tau: 25, delay: 6, dt: 0.2, ambient: 25, uMax: 100 });
  const MODES = Object.freeze(['setpoint', 'switch', 'ramp', 'load']);
  const DURATION = 240;

  function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
  function numberOr(x, fallback) { return Number.isFinite(Number(x)) && x !== '' && x !== null ? Number(x) : fallback; }
  function sanitizeConfig(input) {
    const p = input || {};
    const dt = numberOr(p.dt, DEFAULTS.dt);
    return {
      K: clamp(numberOr(p.K, DEFAULTS.K), 0.05, 1.5),
      tau: clamp(numberOr(p.tau, DEFAULTS.tau), 5, 120),
      delay: clamp(numberOr(p.delay, DEFAULTS.delay), 0, 45),
      dt: SAMPLE_PERIODS.includes(dt) ? dt : DEFAULTS.dt,
      ambient: clamp(numberOr(p.ambient, DEFAULTS.ambient), 10, 40),
      uMax: clamp(numberOr(p.uMax, DEFAULTS.uMax), 10, 100)
    };
  }
  function targetAt(t, scenario, manualTarget) {
    if (scenario === 'switch') return t < 100 - 1e-9 ? 50 : 65;
    if (scenario === 'ramp') return t < 20 ? 40 : t >= 140 ? 65 : 40 + (25 * (t - 20) / 120);
    if (scenario === 'load') return 60;
    return Number.isFinite(manualTarget) ? clamp(manualTarget, 20, 100) : 55;
  }
  function disturbanceAt(t, scenario) {
    return scenario === 'load' && t >= 100 - 1e-9 ? -8 : 0; // Equivalent steady-state temperature loss, °C
  }
  function createPlant(input, scenario, manualTarget) {
    const params = sanitizeConfig(input);
    const mode = MODES.includes(scenario) ? scenario : 'setpoint';
    return {
      params, mode, manualTarget: Number.isFinite(manualTarget) ? manualTarget : null,
      commands: [],
      state: { t: 0, temperature: params.ambient, power: 0,
        delayedPower: 0, disturbance: disturbanceAt(0, mode) }
    };
  }
  function exponentialStep(T, u, disturbance, params, period) {
    if (period <= 1e-12) return T;
    const equilibrium = params.ambient + params.K * u + disturbance;
    return equilibrium + (T - equilibrium) * Math.exp(-period / params.tau);
  }
  function step(plant, requested) {
    const p = plant.params;
    const old = plant.state;
    const k = plant.commands.length;
    const u = clamp(requested, 0, p.uMax);
    plant.commands.push(u);

    // L = n*h + r. During the first r seconds of this sample, the delayed
    // ZOH signal is u[k-n-1]; during the rest it is u[k-n]. This handles
    // fractional delays EXACTLY, without rounding L to a sampling grid.
    let n = Math.floor((p.delay / p.dt) + 1e-10);
    let r = p.delay - n * p.dt;
    if (r < 1e-9) r = 0;
    const oldPower = (k - n - 1 >= 0) ? plant.commands[k - n - 1] : 0;
    const newPower = (k - n >= 0) ? plant.commands[k - n] : 0;
    const d = disturbanceAt(old.t, plant.mode);
    let nextT;
    if (r === 0) nextT = exponentialStep(old.temperature, newPower, d, p, p.dt);
    else {
      const middle = exponentialStep(old.temperature, oldPower, d, p, r);
      nextT = exponentialStep(middle, newPower, d, p, p.dt - r);
    }
    const effectivePower = r === 0 ? newPower : (oldPower * r + newPower * (p.dt - r)) / p.dt;
    const t = Math.round((k + 1) * p.dt * 1e9) / 1e9;
    plant.state = { t, temperature: nextT, power: u,
      delayedPower: effectivePower, disturbance: d };
    return sample(plant);
  }
  function sample(plant) {
    const { state: s, params: p, mode } = plant;
    const target = targetAt(s.t, mode, plant.manualTarget);
    return {
      scenario: mode, t: s.t, temperature: s.temperature, target,
      ambient: p.ambient, power: s.power, delayedPower: s.delayedPower,
      disturbance: s.disturbance, error: target - s.temperature,
      K: p.K, tau: p.tau, delay: p.delay, dt: p.dt, uMax: p.uMax
    };
  }
  return { SAMPLE_PERIODS, DEFAULTS, MODES, DURATION, clamp, sanitizeConfig,
    targetAt, disturbanceAt, createPlant, exponentialStep, step, sample };
});
