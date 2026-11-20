/* HeaterLab UI. The plant and all student code execute in worker.js. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storageKey = 'heaterlab.student.controller.v1_0';
  const starterCode = `// Standard callback: called once on each fresh experiment.
function init() {
  memory.integral = 0;
}

// Standard callback: automatically called every params.dt.
// state, params, memory are accessible in ALL custom functions.
function controller() {
  const error = state.target.temperature - state.temperature;

  // TODO: Design your heater controller.
  // The heater accepts power from 0 to params.uMax (%).
  const power = 0;

  return power;
}`;
  let worker = null;
  let history = [];
  let latest = null;
  let running = false;
  let dirty = false;
  let pendingAction = null;
  let lastResponse = 0;
  let loadTimer = null;
  let drawRequested = false;

  function fmt(v, n = 1) { return Number.isFinite(v) ? v.toFixed(n) : '—'; }
  function escapeHTML(v) { return String(v).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])); }
  function setStatus(s, kind = '') {
    const el = $('statusLabel');
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = '<i></i> ' + escapeHTML(s);
  }
  function msg(s, kind = '') {
    $('message').textContent = s;
    $('message').className = 'editor-message' + (kind ? ' ' + kind : '');
  }
  function scenario() { return $('scenarioSelect').value; }
  function config() {
    return {
      K: Number($('gainInput').value), tau: Number($('tauInput').value),
      delay: Number($('delayInput').value), dt: Number($('dtSelect').value),
      ambient: Number($('ambientInput').value), uMax: Number($('maxPowerInput').value)
    };
  }
  function resizeGutter() {
    const e = $('codeEditor');
    $('lineNumbers').textContent = Array.from({length: e.value.split('\n').length}, (_, i) => i + 1).join('\n');
    $('lineNumbers').scrollTop = e.scrollTop;
  }
  function saveEditor() {
    try { localStorage.setItem(storageKey, $('codeEditor').value); }
    catch (_) { /* Private browsing or storage blocked: editing still works. */ }
  }
  function setDirty() {
    dirty = true;
    msg('Editor changed. Press Apply & reset to load the new controller.');
    saveEditor();
    resizeGutter();
  }
  function loadEditor() {
    try { $('codeEditor').value = localStorage.getItem(storageKey) || starterCode; }
    catch (_) { $('codeEditor').value = starterCode; }
    resizeGutter();
  }
  function refreshScenarioFields() {
    const fixed = scenario() === 'setpoint';
    $('setpointInput').disabled = !fixed;
    $('stepLabel').textContent = fmt(config().dt, 1) + ' s';
    $('apiDt').textContent = fmt(config().dt, 1) + ' s';
    $('configNote').textContent = `Tₛ = ${fmt(config().dt, 1)} s · L = ${fmt(config().delay, 1)} s · 240 s max`;
    $('pathDelay').textContent = fmt(config().delay, 1);
  }
  function parseURL() {
    const q = new URLSearchParams(location.search);
    const assign = (key, id) => { if (q.has(key)) $(id).value = q.get(key); };
    if (q.has('task') && ['setpoint','switch','ramp','load'].includes(q.get('task'))) $('scenarioSelect').value = q.get('task');
    assign('K', 'gainInput'); assign('tau', 'tauInput'); assign('delay', 'delayInput');
    assign('ambient', 'ambientInput'); assign('uMax', 'maxPowerInput');
    assign('setpoint', 'setpointInput');
    if (q.has('dt') && ['0.1', '0.2', '0.5', '1'].includes(q.get('dt'))) $('dtSelect').value = q.get('dt');
    refreshScenarioFields();
  }
  function send(kind, payload = {}) { if (worker) worker.postMessage({ kind, ...payload }); }
  function killWorker() {
    if (loadTimer !== null) { clearTimeout(loadTimer); loadTimer = null; }
    if (worker) worker.terminate();
    worker = null;
    running = false;
  }
  function openWorker(nextAction = null) {
    pendingAction = nextAction;
    if (location.protocol === 'file:') {
      setStatus('Local server needed', 'error');
      msg('Open a terminal in this folder and run: python3 -m http.server 8000. Then visit http://localhost:8000/ (file:// blocks Web Workers).', 'error');
      return;
    }
    killWorker();
    try { worker = new Worker('./worker.js?v=1.0.0'); }
    catch (err) { setStatus('Worker unavailable', 'error'); msg('Could not create Web Worker: ' + (err.message || err), 'error'); return; }
    setStatus('Loading…');
    lastResponse = performance.now();
    const thisWorker = worker;
    worker.onmessage = ev => {
      if (thisWorker !== worker) return;
      lastResponse = performance.now();
      const data = ev.data || {};
      if (data.kind === 'frames') {
        if (data.reason === 'reset') {
          history = [];
          $('testResults').innerHTML = '<div class="empty-tests">No tests yet. Apply your controller, then run the four scenarios.</div>';
        }
        for (const row of data.rows || []) {
          if (data.reason === 'target' && history.length && history[history.length - 1].t === row.t) history[history.length - 1] = row;
          else history.push(row);
          latest = row;
        }
        refreshNumbers();
        requestDraw();
      } else if (data.kind === 'ready') {
        if (loadTimer !== null) { clearTimeout(loadTimer); loadTimer = null; }
        dirty = false; running = false;
        msg('Controller initialized. Run, Step, or evaluate the four scenarios.', 'success');
        setStatus('Ready');
        if (pendingAction) { const a = pendingAction; pendingAction = null; send(a); }
      } else if (data.kind === 'running') { running = true; setStatus('Simulating', 'running'); }
      else if (data.kind === 'paused') { running = false; setStatus('Paused'); }
      else if (data.kind === 'done') { running = false; setStatus('Completed'); msg('Simulation complete. You can export its CSV history.', 'success'); }
      else if (data.kind === 'test-start') { setStatus('Testing', 'running'); $('testResults').innerHTML = '<div class="empty-tests">Evaluating four independent 240 s scenarios…</div>'; }
      else if (data.kind === 'test-results') { running = false; setStatus('Ready'); renderTests(data.results || []); }
      else if (data.kind === 'error') { running = false; pendingAction = null; setStatus('Code error', 'error'); msg(data.message || 'Unknown controller error', 'error'); }
    };
    worker.onerror = ev => {
      running = false; pendingAction = null;
      setStatus('Worker error', 'error');
      msg('Could not load worker.js / physics.js. Start a local HTTP server and check the browser console. ' + (ev.message || ''), 'error');
    };
    worker.onmessageerror = () => { setStatus('Worker error', 'error'); msg('The worker returned unreadable data.', 'error'); };
    worker.postMessage({ kind: 'load', source: $('codeEditor').value,
      scenario: scenario(), params: config(), speed: Number($('speedSelect').value),
      setpoint: Number($('setpointInput').value) });
    loadTimer = setTimeout(() => {
      if (thisWorker !== worker || dirty) return;
      if (performance.now() - lastResponse > 7900) {
        setStatus('Controller unresponsive', 'error');
        msg('Controller did not respond. Check for an infinite loop in your JavaScript. Change your code and press Apply & reset to restart the worker.', 'error');
        killWorker();
      }
    }, 8000);
  }
  function run(kind) {
    if (!worker || dirty) openWorker(kind);
    else send(kind);
  }
  function refreshNumbers() {
    if (!latest) return;
    const row = latest;
    $('readTemp').textContent = fmt(row.temperature, 1);
    $('readTarget').textContent = fmt(row.target, 1);
    $('readPower').textContent = fmt(row.power, 1);
    $('readError').textContent = (row.error >= 0 ? '+' : '') + fmt(row.error, 1);
    $('gaugeNumber').textContent = fmt(row.temperature, 1) + '°';
    $('ambientRead').textContent = fmt(row.ambient, 0) + '°C';
    $('heaterMode').textContent = row.power < .1 ? 'HEATER OFF' : 'HEATING · ' + Math.round(row.power) + '%';
    $('heaterCoil').classList.toggle('active', row.delayedPower > 1);
    $('warmth').style.opacity = String(Math.min(.85, Math.max(.04, (row.temperature - row.ambient) / 70)));
    $('thermoFill').style.height = Math.max(0, Math.min(100, (row.temperature - 20) / 80 * 100)) + '%';
    $('pathCommand').textContent = fmt(row.power, 0) + '%';
    $('pathDelayed').textContent = fmt(row.delayedPower, 0) + '%';
    $('stageTime').textContent = 't = ' + fmt(row.t, 1) + ' s';
    $('durationLabel').textContent = fmt(row.t, 1) + ' / 240 s';
    $('progressFill').style.width = Math.max(0, Math.min(100, row.t / 240 * 100)) + '%';
    let sum = 0, n = 0;
    for (const h of history) if (h.t >= 30) { sum += h.error * h.error; n++; }
    $('rmsLabel').textContent = n ? fmt(Math.sqrt(sum/n), 2) + ' °C' : '—';
  }
  function pixelRatio(ctx, canvas) {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }
  function drawPlot(canvas, type) {
    const ctx = canvas.getContext('2d');
    const { w, h } = pixelRatio(ctx, canvas);
    ctx.clearRect(0, 0, w, h);
    const left = 44, right = w - 14, top = 13, bottom = h - 25;
    let minY, maxY;
    if (type === 'temperature') {
      const all = history.flatMap(x => [x.temperature, x.target]);
      minY = Math.min(15, ...(all.length ? [Math.min(...all)] : [25]));
      maxY = Math.max(75, ...(all.length ? [Math.max(...all)] : [75]));
      minY = Math.floor((minY - 2) / 10) * 10;
      maxY = Math.ceil((maxY + 2) / 10) * 10;
    } else { minY = 0; maxY = 100; }
    const xpix = t => left + (t / 240) * (right - left);
    const ypix = y => bottom - (y - minY) / (maxY - minY) * (bottom - top);
    ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#e5edf0'; ctx.fillStyle = '#96a5ae'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = minY + (maxY - minY) * i / 4;
      const py = ypix(y);
      ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(String(Math.round(y)), left - 8, py);
    }
    for (let i = 0; i <= 4; i++) {
      const x = i * 60;
      ctx.beginPath(); ctx.moveTo(xpix(x), top); ctx.lineTo(xpix(x), bottom); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(x, xpix(x), bottom + 15);
    }
    if (!history.length) return;
    function line(get, color, dash) {
      ctx.save(); ctx.beginPath(); ctx.lineWidth = 2.2; ctx.strokeStyle = color;
      ctx.setLineDash(dash ? [6, 4] : []);
      for (let i = 0; i < history.length; i++) {
        const p = history[i];
        const x = xpix(p.t), y = ypix(get(p));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
    }
    if (type === 'temperature') {
      line(x => x.target, '#259b9a', true);
      line(x => x.temperature, '#ec884e', false);
    } else {
      line(x => x.delayedPower, '#5c99bc', true);
      line(x => x.power, '#ec884e', false);
    }
  }
  function requestDraw() {
    if (drawRequested) return;
    drawRequested = true;
    requestAnimationFrame(() => {
      drawRequested = false;
      drawPlot($('temperatureChart'), 'temperature');
      drawPlot($('powerChart'), 'power');
    });
  }
  const names = {setpoint:'Fixed setpoint',switch:'Setpoint change',ramp:'Moving ramp',load:'Heat-loss rejection'};
  function renderTests(results) {
    $('testResults').innerHTML = results.map(r => `<div class="test-card ${r.passed ? 'pass':'fail'}">
      <span class="tag">${escapeHTML(r.passed ? 'PASS':'TRY AGAIN')}</span>
      <h4>${escapeHTML(names[r.mode] || r.mode)}</h4>
      <div class="result">${fmt(r.value, 2)} °C</div>
      <div class="rule">${escapeHTML(r.metric)}<br>Target: &lt; ${fmt(r.threshold, 1)} °C</div>
    </div>`).join('');
  }
  function download(name, text, contentType) {
    const url = URL.createObjectURL(new Blob([text], {type:contentType}));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function csvExport() {
    if (!history.length) { msg('No samples yet. Run or Step the simulation before exporting CSV.', 'error'); return; }
    const fields = ['scenario','t_s','temperature_C','target_C','ambient_C','commanded_power_pct','delayed_power_pct','disturbance_C','error_C','K_C_per_pct','tau_s','delay_s','dt_s','uMax_pct'];
    const keys = ['scenario','t','temperature','target','ambient','power','delayedPower','disturbance','error','K','tau','delay','dt','uMax'];
    const csv = fields.join(',') + '\r\n' + history.map(h => keys.map(k => k === 'scenario' ? h[k] : Number(h[k]).toFixed(k === 't' ? 4 : 6)).join(',')).join('\r\n') + '\r\n';
    download('heaterlab_' + scenario() + '.csv', csv, 'text/csv;charset=utf-8');
    msg('CSV exported: ' + history.length + ' simulation rows.', 'success');
  }
  function share() {
    const url = new URL(location.href);
    url.search = '';
    const p = config();
    const entries = { task: scenario(), K:p.K, tau:p.tau, delay:p.delay, dt:p.dt,
      ambient:p.ambient, uMax:p.uMax, setpoint:Number($('setpointInput').value) };
    for (const [k,v] of Object.entries(entries)) url.searchParams.set(k, v);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url.toString()).then(() => msg('Setup link copied.', 'success')).catch(() => msg('Unable to copy setup link automatically.', 'error'));
    } else { window.prompt('Copy this setup link:', url.toString()); }
  }
  function makeReset() {
    refreshScenarioFields();
    openWorker();
  }
  function events() {
    $('codeEditor').addEventListener('input', setDirty);
    $('codeEditor').addEventListener('scroll', () => { $('lineNumbers').scrollTop = $('codeEditor').scrollTop; });
    $('codeEditor').addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const el = e.target; const start = el.selectionStart;
        el.setRangeText('  ', start, el.selectionEnd, 'end');
        setDirty();
      }
    });
    $('applyBtn').addEventListener('click', () => openWorker());
    $('restoreBtn').addEventListener('click', () => {
      if ($('codeEditor').value !== starterCode && !window.confirm('Replace the editor with the original zero-power starter?')) return;
      $('codeEditor').value = starterCode; setDirty();
    });
    $('runBtn').addEventListener('click', () => run('start'));
    $('pauseBtn').addEventListener('click', () => { if (worker) send('pause'); });
    $('stepBtn').addEventListener('click', () => run('step'));
    $('resetBtn').addEventListener('click', makeReset);
    $('testBtn').addEventListener('click', () => run('test'));
    $('speedSelect').addEventListener('change', () => send('speed', {speed: Number($('speedSelect').value)}));
    $('saveBtn').addEventListener('click', () => download('heater_controller.js', $('codeEditor').value, 'text/javascript;charset=utf-8'));
    $('csvBtn').addEventListener('click', csvExport);
    $('shareBtn').addEventListener('click', share);
    for (const id of ['scenarioSelect','gainInput','tauInput','delayInput','ambientInput','maxPowerInput','dtSelect'])
      $(id).addEventListener('change', makeReset);
    $('setpointInput').addEventListener('change', () => {
      if (scenario() === 'setpoint' && worker) send('target', {target:Number($('setpointInput').value)});
    });
    window.addEventListener('resize', requestDraw);
  }
  function main() {
    loadEditor(); parseURL(); events();
    requestDraw(); openWorker();
  }
  main();
})();
