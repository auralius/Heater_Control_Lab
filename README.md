# Heater Control Lab — FOPTD

__URL: https://auralius.github.io/Heater_Control_Lab/__

---

A lightweight, dependency-free browser laboratory for **first-order-plus-time-delay (FOPTD)** temperature control. Designed for undergraduate control systems courses and modest laptops.

The plant has thermal inertia, an actual transport delay, a heating-only actuator, time-varying reference signals, and an optional heat-loss disturbance. Students write the controller in JavaScript; the browser simulator advances the plant.

## Run on Ubuntu / Linux

From this extracted folder:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/>. Stop the server with **Ctrl+C**. **Do not** open `index.html` via `file://`: browsers generally prevent the Web Worker from loading this way.

To deploy: upload the files to the root of a GitHub repository and enable **Settings → Pages → Deploy from a branch → main / (root)**. No build system, Node/npm installation, cloud service, or third-party JavaScript package is required for the student site.

## The FOPTD plant

The simulator models heater power `u(t)` (%) and measured temperature `T(t)` (°C):

$$
\tau\frac{dT}{dt} = -(T-T_a) + K\,u(t-L)+d(t).
$$

For a zero initial deviation, with zero disturbance, the transfer function is

$$
\frac{T(s)-T_a/s}{U(s)} = \frac{K e^{-Ls}}{\tau s+1}.
$$

Here:

| Symbol | Meaning | Default |
|---|---|---:|
| `K` | Steady-state temperature gain, °C per % heater input | 0.65 °C/% |
| `tau` / τ | First-order time constant | 25 s |
| `L` / `delay` | Pure heater transport dead time | 6 s |
| `dt` | Controller sampling period | 0.2 s (5 Hz) |
| `uMax` | Maximum heater power | 100% |
| `ambient` / T_a | Ambient temperature | 25 °C |
| `d(t)` | Equivalent steady-state temperature-load disturbance | 0 °C (normally) |

The physical command is clamped to **0–`uMax`** percent. The heater cannot actively cool, so a reduced command allows passive cooling toward ambient. Disturbance `d` is applied *inside the plant's thermal equilibrium*, not added as instant temperature jumps.

The measured temperature remains unchanged until an earlier heater command has emerged from the delay element. For example, with `K=0.65 °C/%`, `tau=25 s`, `L=6 s`, `ambient=25 °C`, and a sustained 50% heater command starting at `t=0`:

$$
T(t)=\begin{cases}
25, & t\le 6,\\
25+32.5(1-e^{-(t-6)/25}), & t>6.
\end{cases}
$$

## Exact first-order update with an exact transport delay

The controller is called at the selected sample time `h = params.dt` (0.1, 0.2, 0.5, or 1 second). The controller's output is held until the next sample.

For each interval during which the delayed heater command `u_d` is constant, the simulator uses the **exact first-order solution**:

$$
T_{next}=T_{eq}+(T_{current}-T_{eq})e^{-\Delta t/\tau},\qquad
T_{eq}=T_a + K u_d + d.
$$

Transport delay is **not rounded** to a multiple of the sampling period. If `L=n h+r`, with `0≤r<h`, then during a sampling interval the delayed input is `u[k-n-1]` for the first `r` seconds and `u[k-n]` for the remaining `h-r` seconds. For `r=0`, only `u[k-n]` is used. Before the start of the simulation, the command history is zero. The simulator applies the exact thermal update once or twice per sample as needed. This is a discrete-time controller driving a first-order plant with ZOH input and pure transport delay, **not** a forward Euler approximation.

The UI's `state.delayedPower` is the *average delayed heater command acting during the last sample*, not necessarily the instantaneous command value at the end of that interval.

## Controller programming API

### Standard functions

The simulator calls two standard functions automatically:

- `init()` — **optional**. Runs once when an experiment is initialized/reset, before its first controller call. Initialize your memory variables here.
- `controller()` — **required**. Runs each sampling period. Return a single **finite numeric heater power (percent)** or `{ power: number }`.

You may define as many custom helper functions as needed. Three bindings are automatically available to all functions, without argument passing:

- **`state`** — read-only process snapshot.
- **`params`** — read-only plant configuration.
- **`memory`** — writable student-owned persistent data.

The old argument style `controller(state, params, memory)` also works. Never redeclare `state`, `params`, or `memory` at the top level of the editor.

### Available fields

| `state` | Meaning |
|---|---|
| `state.t` | Current simulation time, seconds |
| `state.temperature` | Measured process temperature, °C |
| `state.target.temperature` | Current reference temperature, °C |
| `state.error` | Setpoint minus measured temperature, °C |
| `state.power` | Previously commanded heater power, % |
| `state.delayedPower` | Average delayed power from the preceding sample, % |
| `state.ambient` | Ambient temperature, °C |
| `state.disturbance` | Thermal-load-equivalent offset, °C |

| `params` | Meaning |
|---|---|
| `params.K` | Plant gain, °C/% |
| `params.tau` | Time constant, s |
| `params.delay` | Transport delay, s |
| `params.dt` | Controller sampling period, s |
| `params.uMax` | Maximum heater power, % |
| `params.ambient` | Ambient temperature, °C |

### Student starter (unsolved)

```javascript
function init() {
  memory.integral = 0;
}

function controller() {
  const error = state.target.temperature - state.temperature;
  // TODO: Replace zero power with your controller.
  const power = 0;
  return power;
}
```

`memory` starts as an empty object `{}`. Uninitialized properties are `undefined`, **not zero**. Initialization in `init()` is often more readable than repeatedly checking `undefined` inside `controller()`. Only students' JavaScript updates controller memory; the simulator updates the physical temperature automatically.

The editor autosaves in the browser with a separate localStorage key. **Apply & reset** loads current source, resets the thermal plant, clears `memory`, then calls `init()`. Reset and changing plant parameters or scenarios also call `init()` again. Pause/resume does not. Each automated scenario uses its own fresh runtime and memory.

## Four experiments

1. **Fixed setpoint:** Control temperature to 55 °C (or another instructor-selected setpoint in the interactive experiment).
2. **Setpoint change:** Track a change from 50 °C to 65 °C at simulation time 100 s.
3. **Ramp:** Track 40 °C initially, increase linearly from 40 °C at 20 s to 65 °C at 140 s, and hold.
4. **Heat-loss rejection:** Maintain 60 °C despite the equivalent -8 °C thermal disturbance starting at 100 s.

Each automated test lasts 240 s and uses current physical parameters. The four checks use the *built-in reference values*, not the manual fixed-scenario setpoint. Their simple educational thresholds are:

| Test | Check | Threshold |
|---|---|---:|
| Fixed setpoint | Mean absolute error over last 20 s | <1.0 °C |
| Setpoint change | Mean absolute error over last 20 s | <1.5 °C |
| Ramp | RMS error from 80–240 s | <5.0 °C |
| Heat loss | Mean absolute error over last 20 s | <1.5 °C |

The built-in checks help with feedback, but are not a secure, tamper-proof student grade. To assess students, also collect the submitted JavaScript and run their code against instructor-controlled settings.

## CSV export for analysis and grading

The **Export CSV** button writes `heaterlab_<scenario>.csv` for the *current interactive simulation*. It contains the initial state and one row for every simulated sample, with the following columns:

```text
scenario,t_s,temperature_C,target_C,ambient_C,commanded_power_pct,
delayed_power_pct,disturbance_C,error_C,K_C_per_pct,tau_s,
delay_s,dt_s,uMax_pct
```

(The CSV header is a single physical line; shown wrapped above.) Each row includes the scenario, physical parameters, control input, and observed output, allowing a later autograder to validate the experiment. **The four offline checks show results in the UI; they do not automatically export four CSV files.** For submissions, run and export each scenario separately, then submit your `.js` file with the CSV results.

## Sharing setups

The **Copy setup link** control builds a shareable URL containing the initial scenario and all plant settings. Example:

```text
https://YOURNAME.github.io/Heater_Control_Lab/?task=load&K=0.65&tau=25&delay=6&dt=0.2&ambient=25&uMax=100&setpoint=55
```

The URL initializes the experiment but does not lock it: students can still change settings. The setpoint field can be changed live in the fixed-setpoint scenario without restarting the current experiment.

## Teaching prompts (no solutions)

- Begin with proportional-only heater control. What steady-state error remains?
- Add integral action using `memory` and `params.dt`. How does dead time affect oscillation?
- Observe the separate plots of commanded and delayed power. What changes at the heater **before** and **after** `L` seconds?
- Change the sampling period while holding controller gains fixed.
- Explore saturation and integral windup; consider anti-windup techniques.
- Compare real dead time with merely increasing the time constant. Are they interchangeable?

## Project files

- `index.html` — student interface
- `styles.css` — responsive layout and visuals
- `app.js` — editor, plots, controls, CSV, share URL
- `physics.js` — FOPTD process model
- `worker.js` — standard callbacks and simulation / test lifecycle
- `tests/` — Node.js physics and worker tests (instructor development only)
- `LICENSE` — MIT

### Local development tests (optional)

```bash
node --test tests/*.test.js
```

Node.js is **only** for running development tests; students don't need it to use the site.

## Limitations and safety

- This is an **educational simulated heater**, not a real hardware controller. It does not include thermal shutdown, hardware protection, sensor faults, thermal radiation, power supply dynamics, or safety-rated interlocks.
- The browser Web Worker prevents normal student code from blocking the rendering thread, but is **not** a strong security sandbox for arbitrary untrusted code. Use trusted classroom code; an infinite loop may require **Apply & reset** to restart the worker.
- Browser playback speed changes wall-clock pacing, not the controller's `params.dt`.
- The application does not require internet access after its files are loaded, but GitHub Pages alone does not make the site a reliable offline PWA.
