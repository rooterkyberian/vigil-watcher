import './style.css'
import { Alarm } from './alarm'
import { startCamera, stopCamera } from './camera'
import {
  CLOSURE_POINT_DEFAULT,
  CLOSURE_POINT_MAX,
  CLOSURE_POINT_MIN,
  DEFAULT_PROFILE,
  FACE_LOST_MS,
  INFERENCE_INTERVAL_MS,
  PROFILES,
  RECALIBRATE_CHECK_AFTER_MS,
  RECALIBRATE_DRIFT_EAR,
  configProblems,
  isProfileId,
  type ProfileId,
  type Tuning,
} from './config'
import { Arbiter, type Verdict } from './core/arbiter'
import { CalibrationRun } from './core/calibration'
import { clamp, closureThreshold, median } from './core/ear'
import type {
  AlertLevel,
  Calibration,
  CalibrationMeasurement,
  CalibrationState,
  Ear,
  PitchProxy,
  Sample,
  Signals,
} from './core/types'
import { SampleWindow, type WindowStats } from './core/window'
import { createDetector, type Detector } from './detector'
import { drawTrace } from './render'
import { clearCalibration, loadCalibration, loadProfile, saveCalibration, saveProfile } from './storage'
import { Ui, type CalibrationView } from './ui'
import { WakeLockKeeper } from './wakelock'

export interface DebugSample {
  tMs: number
  earRaw: Ear | null
  pitch?: PitchProxy | null
}

export interface DebugFrame {
  tMs: number
  level: AlertLevel
  reasonCode: string
  reason: string
  perclos: number | null
  longBlinksPerMin: number | null
  openClosureMs: number
}

export interface CalibrationPatch {
  open?: number
  closed?: number
  closurePoint?: number
  pitchBase?: PitchProxy
}

export interface VigilDebug {
  feed(trace: readonly DebugSample[], calibration?: Calibration, profile?: ProfileId): DebugFrame[]
  signals(): Signals | null
  setCalibration(patch: CalibrationPatch): Calibration | null
  simulateClosure(durationMs: number): void
  calibration(): Calibration | null
  profile(): ProfileId
  setProfile(profile: ProfileId): ProfileId
  forget(): void
}

declare global {
  interface Window {
    vigil: VigilDebug
  }
}

class Controller {
  private readonly window = new SampleWindow()
  private readonly arbiter = new Arbiter(PROFILES[DEFAULT_PROFILE])
  private readonly wakeLock = new WakeLockKeeper()
  private readonly alarm: Alarm

  private calibration: Calibration | null = null
  private calibrationRun: CalibrationRun | null = null
  private detector: Detector | null = null
  private stream: MediaStream | null = null

  private rafHandle = 0
  private lastInferenceMs = Number.NEGATIVE_INFINITY
  private lastVideoTime = -1
  private sessionStartMs = 0
  private simulateUntilMs: number | null = null
  private alarming = false
  private closurePoint = CLOSURE_POINT_DEFAULT
  private tuning: Tuning = PROFILES[DEFAULT_PROFILE]

  private stats: WindowStats | null = null
  private verdict: Verdict | null = null
  private readonly driftSamples: number[] = []
  private driftChecked = false

  constructor(private readonly ui: Ui) {
    this.alarm = new Alarm(document.body, this.tuning.alarm)
  }

  init(): void {
    const problems = configProblems()
    if (problems.length > 0) {
      console.error('vigil: config invariants violated', problems)
      this.ui.showBanner('Configuration is inconsistent.', problems.join(' '))
    }

    this.calibration = loadCalibration()
    if (this.calibration !== null) this.closurePoint = this.calibration.closurePoint
    this.ui.setClosurePoint(this.closurePoint)
    this.applyProfile(loadProfile(), false)

    this.ui.onStart(() => void this.start())
    this.ui.onStop(() => void this.stop())
    this.ui.onCalibrate(() => void this.calibrate())
    this.ui.onTestAlarm(() => void this.alarm.test())
    this.ui.onDismiss(() => this.dismiss())
    this.ui.onCancelCalibration(() => this.cancelCalibration())
    this.ui.onClosurePoint((value) => this.setClosurePoint(value))
    this.ui.onProfile((profile) => this.applyProfile(profile, true))

    this.ui.setScreen('standby')
    this.ui.setStatus('ok', 'idle', 'STANDBY', this.standbyMessage())
    this.installDebugHandle()
  }

  private standbyMessage(): string {
    return this.calibration === null
      ? 'Calibrate first — 15 seconds, and the app needs it to know your eyes.'
      : 'Ready. Start a session when you want to be watched.'
  }

  private async start(): Promise<void> {
    await this.alarm.unlock().catch(() => undefined)
    if (!(await this.ensureRuntime())) return
    if (this.calibration === null) {
      this.beginCalibration()
      return
    }
    this.resetSession()
    this.ui.setScreen('running')
  }

  private async calibrate(): Promise<void> {
    await this.alarm.unlock().catch(() => undefined)
    if (!(await this.ensureRuntime())) return
    this.beginCalibration()
  }

  private async stop(): Promise<void> {
    this.stopLoop()
    this.alarm.stop()
    this.alarming = false
    this.calibrationRun = null
    await this.wakeLock.release()
    stopCamera(this.ui.video, this.stream)
    this.stream = null
    this.detector?.close()
    this.detector = null
    this.ui.setPreviewLabel('CAMERA OFF')
    this.ui.setEngineLabel('ENGINE IDLE')
    this.ui.setScreen('standby')
    this.ui.showDismiss(false)
    this.ui.setStatus('ok', 'idle', 'STANDBY', this.standbyMessage())
    this.ui.setMetrics({ perclos: '—', blinks: '—', nod: '—' })
  }

  private async ensureRuntime(): Promise<boolean> {
    if (this.detector !== null && this.stream !== null) return true
    this.ui.setBusy(true)
    this.ui.hideBanner()
    try {
      this.ui.setEngineLabel('LOADING MODEL…')
      this.detector = await createDetector(() => this.ui.confirmRemoteFetch())
      this.stream = await startCamera(this.ui.video)
      this.ui.setPreviewLabel('CAMERA LIVE')
      this.ui.setEngineLabel(`ENGINE ${this.detector.source.toUpperCase()} · ${this.detector.delegate}`)
      void this.wakeLock.acquire()
      this.startLoop()
      return true
    } catch (error) {
      this.report(error)
      await this.stop()
      return false
    } finally {
      this.ui.setBusy(false)
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const hint =
      typeof error === 'object' && error !== null && 'hint' in error
        ? String((error as { hint: unknown }).hint)
        : 'Reload the page and try again.'
    this.ui.showBanner(message, hint)
    this.ui.setEngineLabel('ENGINE FAILED')
  }

  private beginCalibration(): void {
    this.calibrationRun = new CalibrationRun()
    this.window.clear()
    this.arbiter.reset()
    this.alarm.stop()
    this.alarming = false
    this.ui.hideBanner()
    this.ui.showDismiss(false)
    this.ui.setScreen('calibrating')
    this.ui.setCalibrationView({
      title: 'Eyes open, look at the screen',
      body: 'Sit the way you will during the session and keep your eyes comfortably open.',
      progress: 0,
      countdown: '8',
    })
  }

  private cancelCalibration(): void {
    this.calibrationRun = null
    this.ui.setScreen(this.calibration === null ? 'standby' : 'running')
    if (this.calibration === null) this.ui.setStatus('ok', 'idle', 'STANDBY', this.standbyMessage())
  }

  private resetSession(): void {
    this.window.clear()
    this.arbiter.reset()
    this.driftSamples.length = 0
    this.driftChecked = false
    this.sessionStartMs = performance.now()
  }

  private startLoop(): void {
    if (this.rafHandle !== 0) return
    this.lastInferenceMs = Number.NEGATIVE_INFINITY
    this.rafHandle = requestAnimationFrame(this.loop)
  }

  private stopLoop(): void {
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle)
    this.rafHandle = 0
  }

  private readonly loop = (): void => {
    this.rafHandle = requestAnimationFrame(this.loop)
    const nowMs = performance.now()
    if (nowMs - this.lastInferenceMs < INFERENCE_INTERVAL_MS) return

    const video = this.ui.video
    const detector = this.detector
    if (detector === null || video.readyState < 2 || video.videoWidth === 0) return
    if (video.currentTime === this.lastVideoTime) return

    this.lastVideoTime = video.currentTime
    this.lastInferenceMs = nowMs

    const detection = detector.detect(video, nowMs)
    const sample: Sample = { tMs: nowMs, earRaw: detection.earRaw, pitch: detection.pitch }

    if (this.calibrationRun !== null) {
      this.stepCalibration(sample)
      return
    }
    if (this.calibration !== null) this.stepMonitor(sample, nowMs)
  }

  private stepCalibration(sample: Sample): void {
    const run = this.calibrationRun
    if (run === null) return
    run.push(sample)
    const state = run.state()

    if (state.phase === 'rejected' && state.rejection !== null) {
      this.calibrationRun = null
      this.ui.setScreen(this.calibration === null ? 'standby' : 'running')
      this.ui.showBanner(state.rejection.message, state.rejection.hint)
      return
    }

    if (state.phase === 'done' && state.measurement !== null) {
      this.calibrationRun = null
      this.acceptCalibration(state.measurement)
      return
    }

    this.ui.setCalibrationView(calibrationView(state))
  }

  private acceptCalibration(measurement: CalibrationMeasurement): void {
    const calibration: Calibration = {
      schemaVersion: 1,
      openEar: measurement.openEar,
      closedEar: measurement.closedEar,
      pitchBase: measurement.pitchBase,
      closurePoint: this.closurePoint,
      capturedAtEpochMs: Date.now(),
      profileLabel: 'default',
    }
    this.calibration = calibration
    this.resetSession()
    this.ui.setScreen('running')

    if (saveCalibration(calibration)) {
      this.ui.showBanner(
        `Calibrated. Open ${calibration.openEar.toFixed(3)}, shut ${calibration.closedEar.toFixed(3)}, counting closed below ${closureThreshold(calibration).toFixed(3)}.`,
        'Watch the trace: ordinary blinks should dip below the dashed line and come straight back up.',
      )
    } else {
      this.ui.showBanner(
        'Calibration applied but not saved.',
        'Browser storage is full or blocked, so you will need to calibrate again next time.',
      )
    }
  }

  private stepMonitor(sample: Sample, nowMs: number): void {
    const calibration = this.calibration
    if (calibration === null) return

    let earRaw = sample.earRaw
    if (this.simulateUntilMs !== null) {
      if (nowMs < this.simulateUntilMs) earRaw = calibration.closedEar * 0.9
      else this.simulateUntilMs = null
    }

    this.window.push({ tMs: sample.tMs, earRaw, pitch: sample.pitch })

    const stats = this.window.compute(closureThreshold(calibration), calibration.pitchBase, this.tuning)
    const verdict = this.arbiter.update(stats, nowMs)
    this.stats = stats
    this.verdict = verdict

    if (verdict.level === 'alarm' && !this.alarming) {
      this.alarm.start()
      this.alarming = true
    } else if (verdict.level !== 'alarm' && this.alarming) {
      this.alarm.stop()
      this.alarming = false
    }

    drawTrace(this.ui.canvas, this.window.trace(), stats.closureThreshold, nowMs, verdict.level)
    this.ui.setStatus(verdict.level, verdict.dataState, headline(verdict), verdict.reason)
    this.ui.setMetrics({
      perclos: stats.perclos === null ? '—' : `${Math.round(stats.perclos * 100)}%`,
      blinks: stats.longBlinksPerMin === null ? '—' : stats.longBlinksPerMin.toFixed(1),
      nod: stats.pitchDriftDeg === null ? '—' : `${Math.round(stats.pitchDriftDeg)}°`,
    })
    this.ui.showDismiss(verdict.level === 'alarm')
    this.ui.setPreviewLabel(stats.faceLostMs > FACE_LOST_MS ? 'NO FACE' : 'CAMERA LIVE')

    this.checkDrift(stats, verdict, nowMs)
  }

  private checkDrift(stats: WindowStats, verdict: Verdict, nowMs: number): void {
    const calibration = this.calibration
    if (this.driftChecked || calibration === null) return
    if (verdict.level !== 'ok' || verdict.dataState !== 'tracking') return
    if (stats.earSmoothed !== null) this.driftSamples.push(stats.earSmoothed)
    if (nowMs - this.sessionStartMs < RECALIBRATE_CHECK_AFTER_MS || this.driftSamples.length < 60) return

    this.driftChecked = true
    const observed = median(this.driftSamples)
    if (Math.abs(observed - calibration.openEar) > RECALIBRATE_DRIFT_EAR) {
      this.ui.showBanner(
        `Your eyes are reading ${observed.toFixed(3)} open, against a calibrated ${calibration.openEar.toFixed(3)}.`,
        'Lighting, glasses or camera angle have changed since you calibrated. Recalibrate for numbers you can trust.',
      )
    }
  }

  private dismiss(): void {
    this.window.clear()
    this.arbiter.dismiss(performance.now())
    this.alarm.stop()
    this.alarming = false
    this.driftSamples.length = 0
    this.ui.showDismiss(false)
  }

  private applyProfile(profile: ProfileId, persist: boolean): void {
    this.tuning = PROFILES[profile]
    this.arbiter.setTuning(this.tuning)
    this.alarm.setStyle(this.tuning.alarm)
    this.ui.setProfile(profile, this.tuning.label, this.tuning.blurb)
    if (persist) saveProfile(profile)
  }

  private setClosurePoint(value: number): void {
    this.closurePoint = clamp(value, CLOSURE_POINT_MIN, CLOSURE_POINT_MAX)
    if (this.calibration === null) return
    this.calibration = { ...this.calibration, closurePoint: this.closurePoint }
    saveCalibration(this.calibration)
  }

  private installDebugHandle(): void {
    window.vigil = {
      feed: (trace, calibration, profile) => this.replay(trace, calibration, profile),
      signals: () => (this.stats === null || this.verdict === null ? null : toSignals(this.stats, this.verdict)),
      setCalibration: (patch) => this.patchCalibration(patch),
      simulateClosure: (durationMs) => {
        this.simulateUntilMs = performance.now() + durationMs
      },
      calibration: () => this.calibration,
      profile: () => this.tuning.id,
      setProfile: (profile) => {
        if (!isProfileId(profile)) throw new Error(`unknown profile "${String(profile)}"`)
        this.applyProfile(profile, true)
        return profile
      },
      forget: () => {
        clearCalibration()
        this.calibration = null
        this.ui.setStatus('ok', 'idle', 'STANDBY', this.standbyMessage())
      },
    }
  }

  private replay(trace: readonly DebugSample[], override?: Calibration, profile?: ProfileId): DebugFrame[] {
    const calibration = override ?? this.calibration
    if (calibration === null) throw new Error('vigil.feed needs a calibration — pass one or calibrate first')

    const tuning = profile === undefined ? this.tuning : PROFILES[profile]
    const window = new SampleWindow()
    const arbiter = new Arbiter(tuning)
    const threshold = closureThreshold(calibration)
    const frames: DebugFrame[] = []

    for (const entry of trace) {
      window.push({ tMs: entry.tMs, earRaw: entry.earRaw, pitch: entry.pitch ?? null })
      const stats = window.compute(threshold, calibration.pitchBase, tuning)
      const verdict = arbiter.update(stats, entry.tMs)
      frames.push({
        tMs: entry.tMs,
        level: verdict.level,
        reasonCode: verdict.reasonCode,
        reason: verdict.reason,
        perclos: stats.perclos,
        longBlinksPerMin: stats.longBlinksPerMin,
        openClosureMs: stats.openClosureMs,
      })
    }
    return frames
  }

  private patchCalibration(patch: CalibrationPatch): Calibration | null {
    const base = this.calibration ?? {
      schemaVersion: 1 as const,
      openEar: 0.3,
      closedEar: 0.1,
      pitchBase: { foreshorten: 1, balance: 0.5 },
      closurePoint: this.closurePoint,
      capturedAtEpochMs: Date.now(),
      profileLabel: 'debug',
    }
    const next: Calibration = {
      ...base,
      openEar: patch.open ?? base.openEar,
      closedEar: patch.closed ?? base.closedEar,
      closurePoint: patch.closurePoint ?? base.closurePoint,
      pitchBase: patch.pitchBase ?? base.pitchBase,
    }
    this.calibration = next
    this.closurePoint = next.closurePoint
    this.ui.setClosurePoint(next.closurePoint)
    saveCalibration(next)
    return next
  }
}

function headline(verdict: Verdict): string {
  if (verdict.level === 'alarm') return 'WAKE UP'
  if (verdict.level === 'caution') return 'CAUTION'
  switch (verdict.dataState) {
    case 'idle':
      return 'STANDBY'
    case 'no-face':
      return 'NO FACE'
    case 'warming':
      return 'WARMING UP'
    case 'insufficient-data':
      return 'LOW DATA'
    default:
      return 'MONITORING'
  }
}

function calibrationView(state: CalibrationState): CalibrationView {
  const countdown = String(Math.ceil(state.phaseRemainingMs / 1000))
  if (state.phase === 'blink') {
    return {
      title: 'Now blink slowly',
      body: 'Close your eyes fully, then open them again. Repeat, unhurried, until the count runs out.',
      progress: state.phaseProgress,
      countdown,
    }
  }
  return {
    title: 'Eyes open, look at the screen',
    body: 'Sit the way you will during the session and keep your eyes comfortably open.',
    progress: state.phaseProgress,
    countdown,
  }
}

function toSignals(stats: WindowStats, verdict: Verdict): Signals {
  return {
    level: verdict.level,
    reasonCode: verdict.reasonCode,
    reason: verdict.reason,
    dataState: verdict.dataState,
    perclos: stats.perclos,
    longBlinksPerMin: stats.longBlinksPerMin,
    openClosureMs: stats.openClosureMs,
    pitchDriftDeg: stats.pitchDriftDeg,
    earSmoothed: stats.earSmoothed,
    earRaw: stats.earRaw,
    closureThreshold: stats.closureThreshold,
    faceLostMs: stats.faceLostMs,
    observedMs: stats.observedMs,
    coverage: stats.coverage,
  }
}

new Controller(new Ui()).init()
