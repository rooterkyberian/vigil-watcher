# Vigil

**▶ [Try it here](https://rooterkyberian.github.io/vigil-watcher/)** — installable from that page to your Android home screen.

A single-page PWA that watches your face through the front camera and warns you when you are falling asleep. All inference runs locally in WebAssembly. No frame, landmark or metric ever leaves the device.

> **Assistive only. Not a safety system. Do not rely on it while driving.**
> Published accuracies of 85–95 % come from lab datasets (NTHU-DDD, UTA-RLDD) recorded under cooperative lighting with willing subjects. Real-world performance on a phone clipped to a dashboard is meaningfully worse, and this app has not been validated against any of them. Treat it as a nudge, never as a guarantee.

**Status: M1 — full pipeline, tests green, installable, verified offline.**

## Privacy

There is no analytics, no telemetry, no error reporting and no third-party script at runtime. For this app the claim is the feature, so it is enforced rather than asserted:

- The camera stream never leaves the page. Nothing is uploaded, and there is no code path that could upload it.
- MediaPipe's runtime ships an analytics logger that queues events and POSTs them to `odml.pa.googleapis.com` every 60 seconds. It is not opt-in. Vigil rewrites that endpoint to an unresolvable address at build time, and the build **fails** if the string ever disappears from the dependency — so a version bump cannot silently switch reporting back on. See `stripMediaPipeTelemetry` in `vite.config.ts`.
- `npm run build` runs an audit that fails on any known reporting host appearing anywhere in `dist/`.
- The only outbound request the app is capable of making is fetching the face model itself, and only if the bundled copy is missing. That path is behind an explicit one-tap confirmation that names Google as the destination. In a normal install it never runs.

## How the detection works

Nothing here is invented; it follows the driver-monitoring literature.

### EAR — eye aspect ratio

Soukupová & Čech (2016), *Real-Time Eye Blink Detection using Facial Landmarks*. For six points around one eye — `p1` outer corner, `p2` `p3` upper lid, `p4` inner corner, `p5` `p6` lower lid:

```
EAR = (‖p2 − p6‖ + ‖p3 − p5‖) / (2 · ‖p1 − p4‖)
```

Roughly constant while the eye is open, collapsing toward 0 on closure. The denominator makes it scale-invariant, so distance from the camera mostly cancels. It is **not** invariant to head yaw, eye shape or eyewear — hence mandatory per-user calibration.

| Eye | MediaPipe FaceMesh indices `[p1, p2, p3, p4, p5, p6]` |
|---|---|
| Left | `33, 160, 158, 133, 153, 144` |
| Right | `362, 385, 387, 263, 373, 380` |

Both eyes are averaged. Landmark `x` is scaled by the video aspect ratio first, so vertical and horizontal distances share a unit.

### Signals

| Signal | Definition | Default trip point |
|---|---|---|
| PERCLOS | fraction of *observed* time with the eyes below the closure threshold, over a 60 s window | 0.08 caution, 0.15 alarm |
| Long blinks | closures longer than 300 ms, per minute of observed time | 2/min caution, 4/min alarm |
| Microsleep | one continuous closure | 800 ms, alarms immediately and bypasses the window |
| Head drop | forehead→chin foreshortening against a calibrated baseline | 16° |
| Blink floor | closures under 60 ms are discarded as landmark noise | — |

PERCLOS needs 15 s of observed data before it reports anything, and at least 50 % coverage of the window — a long stretch of missing face will not produce a confident number from a handful of frames.

**These thresholds are literature-derived starting points, not tuned for any particular camera or person.** Published values range roughly 0.08–0.20 depending on window length, closure definition (80 % closed vs. fully closed) and study population. All of them live in `src/config.ts`.

### Alert arbitration

Levels are `ok` → `caution` → `alarm`, and nothing ever fires on a single frame.

- **alarm** if a closure has held past 800 ms, **or** PERCLOS > 0.15, **or** ≥4 long blinks/min, **or** (head drop > 16° **and** PERCLOS > 0.08).
- **caution** if any single caution threshold is crossed.
- Face lost for more than 1.2 s pauses accumulation and shows a distinct "no face" state. Missing data is never counted as eyes-open — it is excluded from both sides of the PERCLOS ratio, so a gap cannot dilute the number toward zero.
- An alarm already ringing is **held** through a face loss rather than silently cleared, since a head dropping out of frame is exactly when you least want the alarm to stop.
- Every level carries a human-readable reason: "Eyes closed for 1.4 s", not "threshold exceeded".

### Calibration

Mandatory, about 15 seconds, and the app will not monitor without it.

1. **Eyes open, 8 s** — median of smoothed EAR becomes `open`; median head geometry becomes the pitch baseline.
2. **Slow blinks, 7 s** — 3rd percentile of *raw* EAR becomes `closed`.

`threshold = open − closurePoint · (open − closed)`, with the slider spanning 0.50–0.88 and defaulting to 0.70.

Calibration is rejected if `open − closed < 0.03`, and the message names the likely cause — glasses reflecting the screen, a bright window behind you, or a camera angle looking up from below. It distinguishes "the camera delivered no frames" from "frames arrived but your face was not in them", because those need different fixes. Results are persisted under a versioned `localStorage` key; an unrecognised schema is discarded rather than crashing. If your eyes read materially differently from the stored calibration once a session settles, the app says so and suggests recalibrating.

Watch the trace after calibrating. Ordinary blinks should dip below the dashed line and come straight back up. If the line sits above or below everything your calibration is wrong, and the trace is how you find that out.

## Where this deviates from the obvious implementation

Each of these is a deliberate choice, not an oversight.

- **The slider is "closure point", not "sensitivity".** In `open − k · (open − closed)`, raising `k` *lowers* the threshold and makes the app *less* eager to alarm — the opposite of what a control called "sensitivity" implies. It is named for what it does.
- **PERCLOS is time-weighted, not sample-counted.** At 15 Hz a frame is 66.7 ms, so counting samples would quantise every blink to ±67 ms and make the 60 ms noise floor unenforceable. Threshold crossings are linearly interpolated between samples instead, which also keeps the metric correct when frames are dropped.
- **Closure detection runs on a median-of-3 filter, not the EMA.** An EMA with α = 0.45 at 15 Hz has a ~150 ms effective window and attenuates a 120 ms blink below the threshold entirely. A median filter kills single-frame landmark dropouts while preserving edges. The trade-off is an effective floor of about two frames (~130 ms); a genuine single-frame dip is treated as noise. The EMA is kept for the on-screen readout.
- **Head drop is measured in 2D.** MediaPipe's `z` is relative and noisy enough that an atan2 in the y–z plane would mostly track jitter. Vigil uses image-plane forehead→chin length over inter-ocular distance instead, which foreshortens as the head pitches; `acos` of the ratio against the calibrated baseline gives an honest weak-perspective angle with no `z` at all. Sign comes from how the face's vertical balance shifts. It is a **nod detector, not head-pose estimation**, and it is labelled that way in the UI.
- **Dismissing an alarm does not mute microsleep.** "I'm awake" clears the window and mutes the window-derived triggers for 20 s, but a fresh 800 ms closure still alarms after a 5 s guard. Someone who dismisses and immediately shuts their eyes is the case that matters most. (`DISMISS_MUTE_MS > WARMUP_MS` is asserted at startup — otherwise the cleared window has not re-warmed when the mute lifts and the app is blind.)
- **Only the WebAssembly SIMD runtime is bundled.** MediaPipe ships three ~11 MB builds; the loader selects exactly one, and the ES-module variant is never chosen. Shipping all three meant a 38 MB precache. Vigil bundles the SIMD build (15.7 MB total precache) and probes for SIMD explicitly, so a browser without it gets a clear message rather than a 404.
- **`display: standalone`, not `fullscreen`.** A monitoring session runs for an hour unattended; hiding the clock and battery for that long is a worse trade than the extra strip of chrome.

## Platform limits

None of these are papered over.

| Constraint | Consequence |
|---|---|
| `getUserMedia` needs a secure context | Pages HTTPS is fine; local dev needs `localhost`. For on-device testing over USB use `adb reverse tcp:5173 tcp:5173` — Chrome blocks the camera on `http://192.168.x.x` |
| Screen off or tab backgrounded stops the camera and rAF | Wake Lock only helps while foregrounded. **A browser tab is not a reliable alarm clock.** Capacitor with a foreground service is the M4 answer |
| Visible-light camera in the dark | Real driver-monitoring systems use infrared illumination. A phone cannot. Accuracy collapses at night |
| Glasses and sunglasses | Reflections and tint break EAR outright. Calibration catches the low-contrast case and refuses rather than misbehaving quietly |
| Thermals and battery | Roughly 15–25 %/hour, with throttling after ~20 minutes. Hence 640×480 at 15 Hz inference on the GPU delegate |
| iOS Safari standalone PWA camera | Historically flaky. Best-effort only |
| More than one face in frame | `numFaces: 1`, so a passenger leaning in can take over the tracked face |

## Development

```bash
npm install        # also vendors the MediaPipe runtime
npm run dev        # http://localhost:5173
npm test           # vitest, pure core only
npm run typecheck  # app and service worker
npm run build      # production build + precache/privacy audit
npm run preview    # serve dist/
npm run vendor     # re-vendor wasm + model (--force to re-download)
npm run icons      # regenerate PWA icons
```

The console handle mirrors the app's internals:

```js
vigil.feed(trace, calibration)   // replay a trace through the core, no camera
vigil.signals()                  // current PERCLOS / blink rate / head drop / level
vigil.setCalibration({ open: 0.31, closed: 0.11 })
vigil.simulateClosure(1200)      // force an alarm, to test the alert path
vigil.calibration()              // what is stored
vigil.forget()                   // clear stored calibration
```

`vigil.feed` takes `{ tMs, earRaw, pitch? }[]` and returns one frame per sample, so thresholds can be checked against a recorded trace instead of against vibes.

### Offline is a hard requirement

The model is **committed** to the repo — 3.6 MB, no Git LFS. A fresh clone and a fresh CI run both build without reaching `storage.googleapis.com`; `scripts/vendor-assets.mjs` verifies the committed file against a pinned SHA-256 and only downloads when it is missing or altered. CI asserts the file did not change during the run.

MediaPipe Tasks Vision does not need cross-origin isolation for the single-threaded SIMD build, which is fortunate because GitHub Pages cannot set COOP/COEP headers.

Verified in headless Chrome: install, go offline, cold-launch, load the model from cache, start the camera, run the alert path — with zero network requests attempted. **The one thing not yet done is the same run on a physical Android handset**, which is the remaining M1 sign-off.

## Deploy

Push to `main`. `.github/workflows/deploy.yml` builds and publishes to Pages; set **Settings → Pages → Source: GitHub Actions** once. `vite.config.ts` sets `base: './'` so the project-page subpath works.

## Code map

| File | Owns |
|---|---|
| `src/config.ts` | Every tunable: thresholds, windows, FPS cap, landmark indices, calibration timings, plus the invariants between them |
| `src/core/types.ts` | `Sample`, `Signals`, `AlertLevel`, `Calibration`, `Closure`, `ReasonCode` |
| `src/core/ear.ts` | Pure geometry and filters: `eyeAspect`, head-pitch proxy, median/EMA, percentiles, threshold crossing |
| `src/core/window.ts` | Rolling raw-sample ring buffer; time-weighted PERCLOS, closure FSM, long-blink rate, trace view |
| `src/core/arbiter.ts` | Signals → level and reason, with warm-up, hysteresis, dismissal mute and face-loss handling |
| `src/core/calibration.ts` | Two-phase calibration FSM, driven by samples and elapsed time |
| `src/detector.ts` | FaceLandmarker lifecycle, local-first asset loading, SIMD probe, landmarks → EAR and pitch |
| `src/camera.ts` | `getUserMedia` lifecycle, constraints, teardown, error taxonomy |
| `src/alarm.ts` | WebAudio tone pair, vibration, visual flash; owns AudioContext unlock on the start tap |
| `src/wakelock.ts` | Screen Wake Lock, re-acquired on `visibilitychange` |
| `src/storage.ts` | Typed, versioned, quota-safe `localStorage` wrapper |
| `src/render.ts` | Canvas trace: EAR history, dashed threshold, shaded closure spans, gap bands |
| `src/ui.ts` | Cached DOM refs and HUD writes. No logic, no thresholds |
| `src/main.ts` | Controller: rAF loop, 15 Hz throttle, wiring, `window.vigil` |
| `src/sw.ts` | Service worker (injectManifest) |
| `scripts/vendor-assets.mjs` | Copies the tasks-vision SIMD runtime, checksum-guards the committed model |
| `scripts/check-precache.mjs` | Fails the build on a precache gap or a reporting host in `dist/` |
| `scripts/make-icons.mjs` | Generates the PWA icons with a dependency-free PNG encoder |

`src/core/` is pure and headless: it never imports MediaPipe, touches the DOM, or reads the clock. Timestamps arrive as arguments, which is what makes the whole thing testable and deterministic.

## Roadmap

- **M1 — it works and it's honest.** ✅ except physical-device offline sign-off
- **M2 — trustworthy.** Session log with JSON export, trace recording to fixtures, replay mode, per-profile calibration slots (glasses / no glasses)
- **M3 — better signals.** Yawn detection as a corroborating vote, adaptive baseline gated on `level === 'ok'`, low-light detection with an explicit "too dark to trust this" state
- **M4 — beyond the tab.** Capacitor wrapper with a foreground service so monitoring survives screen-off

## Licence

MIT — see [LICENSE](LICENSE). The MediaPipe face landmarker model and runtime are Apache-2.0; see [NOTICE](NOTICE).
