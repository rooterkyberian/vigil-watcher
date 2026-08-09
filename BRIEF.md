# Project brief — `vigil-watcher`

> Paste this whole file into Claude Code as the opening prompt, in an empty repo.

---

## 0. What you are building

**Vigil** — a single-page, installable PWA that watches the user's face through the front camera
and warns them when they are falling asleep. All inference runs locally in WASM; **no frame,
landmark, or metric ever leaves the device, and the app makes zero network requests after first
load**.

It ships as a GitHub Pages site at `https://<user>.github.io/vigil-watcher/` and is installable
to the Android home screen from there. Android Chrome is the target platform; desktop Chrome is
the development surface.

Repo conventions follow `github.com/rooterkyberian/barance` — same owner, same taste: TypeScript
+ Vite, `src/` split by role with a code map table in the README, all tuning constants in
`src/config.ts`, a pure deterministic core separated from the runtime, a `window.*` debug handle,
MIT license, GitHub Actions deploy to Pages, milestone-based status line in the README.

Build from scratch. There is no existing code.

---

## 1. Domain: how drowsiness detection actually works

You need this to write the core correctly. Do not invent your own metric.

### 1.1 EAR — eye aspect ratio

Soukupová & Čech (2016), *Real-Time Eye Blink Detection using Facial Landmarks*. For six points
around one eye — `p1` outer corner, `p2` `p3` upper lid, `p4` inner corner, `p5` `p6` lower lid:

```
EAR = (‖p2 − p6‖ + ‖p3 − p5‖) / (2 · ‖p1 − p4‖)
```

Roughly constant while the eye is open, collapses toward 0 on closure. The denominator makes it
scale-invariant, so distance from the camera mostly cancels out. It is **not** invariant to head
yaw, eye shape, or eyewear — hence mandatory per-user calibration.

MediaPipe FaceMesh landmark indices:

| Eye | `[p1, p2, p3, p4, p5, p6]` |
|---|---|
| Left | `[33, 160, 158, 133, 153, 144]` |
| Right | `[362, 385, 387, 263, 373, 380]` |

Average the two eyes, then smooth with an EMA (α ≈ 0.45 at 15 Hz). Keep the **raw** value too —
calibration needs unsmoothed minima so short blinks aren't averaged away.

### 1.2 PERCLOS

Fraction of a rolling window during which the eyes are closed. The best-validated single
drowsiness proxy in the driver-monitoring literature (Wierwille et al.; adopted in NHTSA work).
Use a 60 s window; require ≥15 s of accumulated data before trusting it.

Published alert thresholds range roughly 0.08–0.20 depending on window length, closure definition
(80 % closed vs. fully closed) and study population. Ship 0.08 caution / 0.15 alarm as defaults,
expose them in `config.ts`, and state in the README that they are literature-derived starting
points, not tuned for any particular camera.

### 1.3 Supporting signals

| Signal | Definition | Default trip point |
|---|---|---|
| Long blinks | closures > 300 ms, counted per minute over the same window | 2/min caution, 4/min alarm |
| Microsleep | one continuous closure | 800 ms → immediate alarm, bypasses the window |
| Head pitch | angle of the forehead(10)→chin(152) vector in the y–z plane, vs. a calibrated baseline | 16° drift |
| Blink floor | closures < 60 ms are landmark noise, discard | — |

Head pitch here is a **nod detector, not head-pose estimation** — MediaPipe's `z` is relative and
noisy. Label it honestly in the UI and in code comments. Don't decode
`facialTransformationMatrixes` unless you first verify the row/column-major convention
empirically against a known rotation; the geometric approximation is good enough and has no
ambiguity.

### 1.4 Alert arbitration

Never fire on a single frame. Levels: `ok` → `caution` → `alarm`.

- `alarm` if: microsleep held > 800 ms, **or** PERCLOS > 0.15, **or** ≥4 long blinks/min,
  **or** (nod > 16° **and** PERCLOS > 0.08).
- `caution` if any single caution threshold is crossed.
- Face lost > 1.2 s → pause accumulation and show a distinct "no face" state. Missing data must
  never be counted as eyes-open.
- After the user dismisses an alarm ("I'm awake"), clear the window and mute re-triggering for
  20 s — otherwise the stale window instantly re-alarms.
- Each level carries a human-readable reason string, surfaced in the UI. "Eyes closed for 1.4 s",
  not "threshold exceeded".

### 1.5 Calibration (mandatory, not polish)

Two phases, ~15 s total:

1. **Eyes open, 8 s** — median of smoothed EAR → `open`. Also median pitch → `pitchBase`.
2. **Slow blinks, 7 s** — 3rd percentile of *raw* EAR → `closed`.

`threshold = open − sensitivity · (open − closed)`; sensitivity slider 0.50–0.88, default 0.70.

Reject the calibration if `open − closed < 0.03`, with an actionable message naming the likely
cause (lighting, glasses, camera angle). Persist to `localStorage` under a versioned key so
future schema changes degrade instead of crashing. Prompt to recalibrate when the session starts
in visibly different conditions.

---

## 2. Runtime stack

- **`@mediapipe/tasks-vision` FaceLandmarker**, pinned to an exact version, `runningMode: 'VIDEO'`,
  `numFaces: 1`, `delegate: 'GPU'`. 478 landmarks, ~3.7 MB float16 model. Blendshapes and
  transformation matrices off by default (turn blendshapes on only in M3 for yawn detection).
- **Camera**: `getUserMedia({ video: { facingMode: 'user', width: {ideal:640}, height: {ideal:480},
  frameRate: {ideal:30} }, audio: false })`. Mirror the preview with `transform: scaleX(-1)`.
- **Inference throttled to 15 FPS** by a timestamp gate inside the rAF loop — the camera runs at
  30, you infer at 15. `detectForVideo` needs monotonically increasing `performance.now()`
  timestamps.
- **Alarm**: WebAudio square-wave oscillator pair (880 / 1180 Hz alternating, ~420 ms period) plus
  `navigator.vibrate` plus a visual flash. No audio files — a bundled asset is a bundled asset,
  but generated tone keeps the payload tiny and works offline by construction.
- **Screen Wake Lock**, re-acquired on `visibilitychange`.

---

## 3. Architecture

Non-negotiable: **the core is pure and headless.** `src/core/` must not import MediaPipe, touch
the DOM, or read the clock. It takes `(timestampMs, earRaw, pitchDeg | null)` samples in and
emits signals and an alert level out. This is what makes it testable, and it mirrors barance's
`model.ts` / `sim.ts` split.

```
src/
  config.ts          All tuning: thresholds, windows, FPS cap, EAR indices, calibration timings
  core/
    types.ts         Sample, Signals, AlertLevel, Calibration, CalibrationPhase
    ear.ts           Pure geometry: eyeAspect(), pitchDeg(), EMA — no I/O
    window.ts        Rolling sample buffer, PERCLOS, blink FSM, long-blink rate
    arbiter.ts       Signals -> AlertLevel + reason, with hysteresis, warm-up and mute
    calibration.ts   Calibration FSM (pure; driven by samples + elapsed time)
  detector.ts        MediaPipe FaceLandmarker: load (vendored, CDN fallback), detectForVideo
  camera.ts          getUserMedia lifecycle, constraints, teardown, error taxonomy
  alarm.ts           WebAudio beeper, Vibration, visual flash, respects prefers-reduced-motion
  wakelock.ts        Screen Wake Lock + re-acquire on visibilitychange
  storage.ts         Typed, versioned, quota-safe localStorage wrapper
  render.ts          Canvas trace: EAR history, threshold line, shaded closure spans
  ui.ts              DOM binding + HUD updates (no logic, no thresholds)
  main.ts            Controller: rAF loop, FPS throttle, wiring, debug handle
  sw.ts              Service worker (injectManifest)
public/
  vendor/            Vendored MediaPipe runtime + model (see §4)
  icons/
test/
  core/*.test.ts     Vitest, pure-core only
  fixtures/*.json    Synthetic EAR traces
scripts/
  vendor-assets.mjs  Copies tasks-vision wasm + downloads face_landmarker.task
```

Hot-loop rules: no `document.getElementById` inside the rAF callback (cache refs at init), no
per-frame allocation in `core/`, ring buffer rather than `Array.shift()` if that reads cleaner.

`window.vigil` exposes the controller for console poking and headless testing, mirroring
barance's `window.bl`:

```js
vigil.feed(fixture)          // replay a trace through the core, no camera
vigil.signals()              // current PERCLOS / blink rate / pitch / level
vigil.setCalibration({ open: 0.31, closed: 0.11, pitchBase: 88 })
vigil.simulateClosure(1200)  // force an alarm, to test the alert path
```

---

## 4. Offline is a hard requirement

The app must run with the network fully off, including a cold start after install.

- `scripts/vendor-assets.mjs` copies `node_modules/@mediapipe/tasks-vision/wasm/` →
  `public/vendor/tasks-vision/wasm/` and downloads the float16 `face_landmarker.task` →
  `public/vendor/`. Wire it into both `prepare` and `prebuild`.
- **Commit the `.task` file.** 3.7 MB is well inside GitHub's limits, and it means a fresh clone
  and a fresh CI run both work without reaching `storage.googleapis.com`. No Git LFS.
- Keep a CDN path as a runtime fallback only, behind a `HEAD` probe on the local asset — a broken
  vendor step should degrade, not white-screen.
- Service worker via `vite-plugin-pwa` in `injectManifest` mode. Precache the shell **and** the
  vendored wasm/model; verify the generated precache list actually contains the `.task` and
  `.wasm` files, because the default glob usually misses them.
- Manifest: `display: fullscreen`, portrait, `start_url: "./"`, `scope: "./"`, maskable icon,
  theme colour `#0B1020`.
- **Acceptance test:** install to the home screen, enable airplane mode, cold-launch, complete a
  calibration, trigger an alarm. If any of that fails, the milestone isn't done.

MediaPipe Tasks Vision does not require cross-origin isolation for the single-threaded/SIMD
build — fortunate, since GitHub Pages cannot set COOP/COEP headers. If you find yourself needing
threads, stop and reconsider rather than adding a header workaround.

---

## 5. Platform reality — put these in the README, don't paper over them

| Constraint | Consequence |
|---|---|
| `getUserMedia` needs a secure context | Pages HTTPS is fine; local dev needs `localhost`. Document `adb reverse tcp:5173 tcp:5173` for on-device testing over USB — `http://192.168.x.x` is blocked by Chrome |
| Screen off / tab backgrounded stops camera + rAF | Wake Lock helps only while foregrounded. A browser tab is not a reliable alarm clock. Say so plainly; Capacitor + foreground service is the M4 answer |
| Visible-light camera in the dark | Real driver-monitoring systems use IR illumination. A phone can't. Accuracy collapses at night |
| Glasses / sunglasses | Reflections and tint break EAR outright. Catch the low-contrast case at calibration and refuse rather than silently misbehaving |
| Thermals and battery | ~15–25 %/hour, throttles after ~20 min. Hence 640×480 @ 15 Hz inference and the GPU delegate |
| iOS Safari standalone PWA camera | Historically flaky. Best-effort only |

The README and the app itself must carry a clear line: **assistive only, not a safety system, do
not rely on it while driving.** Reported 85–95 % accuracies come from lab datasets (NTHU-DDD,
UTA-RLDD) under cooperative lighting; real dashboard performance is meaningfully worse. State
that honestly rather than quoting the headline number.

---

## 6. UI direction

Sleep-lab telemetry, not a consumer wellness app. It is used in the dark, often in peripheral
vision, so: deep night-blue ground `#0B1020`, panel `#141A2E`, rule `#28325A`, cyan trace
`#6EE0FF`, amber caution `#FFB020`, red alarm `#FF4D6D`, dim ink `#8792B8`. Monospace for all
numerics and labels (`ui-monospace, "Roboto Mono", monospace`) — system fonts only, because a
webfont is a network dependency and this app has none. Tabular numerals, uppercase wide-tracked
labels, medical-device register.

**Signature element:** a live 60-second scrolling trace of eye opening, with the calibrated
closure threshold drawn as a dashed line and closure spans shaded red. Blinks read as spikes
crossing the line; a microsleep reads as a wide band. This is the one loud thing, and it is also
functional — it's how the user judges whether their calibration is sane. Everything else (status
band with a single state lamp, three metric cells, camera thumbnail, sensitivity slider) stays
quiet and disciplined.

Copy rules: name things by what the user controls. "Start session", not "Initialize". Errors say
what happened and what to do — "Camera blocked. Allow camera access in site settings, then start
again." No apologising, no vague states. The standby screen tells them what to do next.

Quality floor, unannounced: works down to a 360 px viewport, visible keyboard focus,
`prefers-reduced-motion` respected (the alarm flash becomes a static fill), safe-area insets
handled. The app is dark always, on purpose — no light theme.

---

## 7. Testing

Vitest, `test/core/` only. The core is pure, so this is cheap and worth doing properly.

- **Synthetic traces:** generate EAR sequences programmatically (steady open; regular 120 ms
  blinks; drowsy 400 ms blinks; a 2 s microsleep; face-lost gaps) and assert PERCLOS, long-blink
  rate, and `AlertLevel` transitions.
- **Boundary cases:** exactly-at-threshold values, a blink spanning the window edge as it scrolls
  out, sample gaps (must not count as eyes-open), the mute period after dismissal, a window
  shorter than warm-up.
- **Calibration:** feed a synthetic open+blink sequence and assert the derived threshold; assert
  rejection when open/closed separation is too small.
- **Determinism:** the same fixture replayed twice yields identical signals. No `Date.now()` in
  core — timestamps arrive as arguments.
- `.github/workflows/ci.yml` runs `tsc --noEmit`, `vitest run`, and `npm run build` on PRs.

---

## 8. Repo furniture

- `.github/workflows/deploy.yml` — build + deploy to Pages on push to `main`
  (Settings → Pages → Source: **GitHub Actions**). `vite.config.ts` sets `base: './'` so the
  project-page subpath works.
- `.github/workflows/ci.yml` — typecheck, test, build on PRs.
- `LICENSE` — MIT.
- The MediaPipe face landmarker model is Apache-2.0 — attribute it in the README or a `NOTICE`.
- `README.md`, in this order: a **▶ Try it here** link to the Pages URL, the one-line pitch, the
  assistive-only warning, a status line naming the current milestone, how detection works (the
  table from §1), calibration instructions, the platform-limits table from §5, `## Development`
  with the npm scripts, `## Deploy`, and a `## Code map` table mapping each `src/` file to its
  role. Same shape as the barance README.
- Scripts: `dev | build | preview | test | typecheck | vendor`.
- No analytics, no telemetry, no third-party scripts at runtime — say so in the README. For this
  app the privacy claim is a feature, and a single stray CDN reference falsifies it.

---

## 9. Milestones

Work in order. Commit at each boundary with a README status update, exactly like barance's
"Status: M2 — generated challenges." line.

**M1 — it works and it's honest.** Vite + TS scaffold, module split, full pipeline, tests green,
vendored assets, service worker, installable PWA, deployed to Pages, verified offline on an
Android device.

**M2 — trustworthy.** Session log (start/end, alarms, peak PERCLOS) persisted locally with JSON
export; trace recording to fixtures; a replay mode that feeds a recorded trace through the core
with no camera, so thresholds get tuned against real data instead of vibes; per-profile
calibration slots (glasses / no glasses).

**M3 — better signals.** Yawn detection via mouth aspect ratio or the `jawOpen` blendshape as a
corroborating vote; an adaptive baseline that tracks slow EAR drift within a session without
letting a genuinely drowsy user drag the threshold down with them (gate adaptation on
`level === 'ok'` — this is the subtle one); low-light detection from frame luminance with an
explicit "too dark to trust this" state instead of silent degradation.

**M4 — beyond the tab.** Capacitor wrapper with a foreground service so the monitor survives
screen-off, which is the only way this becomes dependable. Same core, new shell.

---

## 10. First response, before writing code

Do not scaffold yet. Reply with:

1. The proposed file tree, one line per module saying what it owns.
2. The `core/types.ts` interfaces — `Sample`, `Signals`, `AlertLevel`, `Calibration` — since
   everything else hangs off those.
3. Anything in this brief you think is wrong, under-specified, or a worse idea than an
   alternative you'd pick. Push back now rather than building around a bad call.

Then wait for a go-ahead.
