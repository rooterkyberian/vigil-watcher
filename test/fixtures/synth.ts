import { INFERENCE_FPS } from '../../src/config'
import { Arbiter, type Verdict } from '../../src/core/arbiter'
import { closureThreshold } from '../../src/core/ear'
import type { AlertLevel, Calibration, PitchProxy, Sample } from '../../src/core/types'
import { SampleWindow, type WindowStats } from '../../src/core/window'

export const PERIOD_MS = 1000 / INFERENCE_FPS
export const OPEN_EAR = 0.3
export const SHUT_EAR = 0.08

export const BASE_PITCH: PitchProxy = { foreshorten: 2, balance: 0.55 }

export const CALIBRATION: Calibration = {
  schemaVersion: 1,
  openEar: 0.3,
  closedEar: 0.1,
  pitchBase: BASE_PITCH,
  closurePoint: 0.7,
  capturedAtEpochMs: 0,
  profileLabel: 'test',
}

export const THRESHOLD = closureThreshold(CALIBRATION)

export class TraceBuilder {
  private readonly samples: Sample[] = []
  private tMs: number
  private pitch: PitchProxy | null

  constructor(startMs = 1000, pitch: PitchProxy | null = BASE_PITCH) {
    this.tMs = startMs
    this.pitch = pitch
  }

  open(durationMs: number): this {
    return this.emit(this.frames(durationMs), OPEN_EAR)
  }

  shut(durationMs: number): this {
    return this.emit(this.frames(durationMs), SHUT_EAR)
  }

  lost(durationMs: number): this {
    return this.emit(this.frames(durationMs), null)
  }

  frameOpen(count: number): this {
    return this.emit(count, OPEN_EAR)
  }

  frameShut(count: number): this {
    return this.emit(count, SHUT_EAR)
  }

  at(earRaw: number, durationMs: number): this {
    return this.emit(this.frames(durationMs), earRaw)
  }

  blinkTrain(durationMs: number, everyMs: number, blinkMs: number): this {
    const cycles = Math.floor(durationMs / everyMs)
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      this.open(everyMs - blinkMs)
      this.shut(blinkMs)
    }
    return this
  }

  withPitch(pitch: PitchProxy | null): this {
    this.pitch = pitch
    return this
  }

  nodding(durationMs: number, foreshorten: number, closed = false): this {
    const previous = this.pitch
    this.pitch = { foreshorten, balance: 0.4 }
    this.emit(this.frames(durationMs), closed ? SHUT_EAR : OPEN_EAR)
    this.pitch = previous
    return this
  }

  build(): Sample[] {
    return this.samples
  }

  private frames(durationMs: number): number {
    return Math.max(1, Math.round(durationMs / PERIOD_MS))
  }

  private emit(count: number, earRaw: number | null): this {
    for (let index = 0; index < count; index += 1) {
      this.samples.push({ tMs: this.tMs, earRaw, pitch: earRaw === null ? null : this.pitch })
      this.tMs += PERIOD_MS
    }
    return this
  }
}

export interface ReplayFrame {
  tMs: number
  stats: WindowStats
  verdict: Verdict
}

export function replay(samples: readonly Sample[], calibration: Calibration = CALIBRATION): ReplayFrame[] {
  const window = new SampleWindow()
  const arbiter = new Arbiter()
  const threshold = closureThreshold(calibration)
  const frames: ReplayFrame[] = []

  for (const sample of samples) {
    window.push(sample)
    const stats = window.compute(threshold, calibration.pitchBase)
    frames.push({ tMs: sample.tMs, stats, verdict: arbiter.update(stats, sample.tMs) })
  }
  return frames
}

export function finalStats(samples: readonly Sample[], calibration: Calibration = CALIBRATION): WindowStats {
  const window = new SampleWindow()
  for (const sample of samples) window.push(sample)
  return window.compute(closureThreshold(calibration), calibration.pitchBase)
}

export function levelsSeen(frames: readonly ReplayFrame[]): AlertLevel[] {
  const seen: AlertLevel[] = []
  for (const frame of frames) {
    if (seen[seen.length - 1] !== frame.verdict.level) seen.push(frame.verdict.level)
  }
  return seen
}

export function stubStats(overrides: Partial<WindowStats> = {}): WindowStats {
  return {
    perclos: 0,
    longBlinksPerMin: 0,
    longBlinkCount: 0,
    openClosureMs: 0,
    pitchDriftDeg: 0,
    earRaw: OPEN_EAR,
    earSmoothed: OPEN_EAR,
    closureThreshold: THRESHOLD,
    faceLostMs: 0,
    observedMs: 30_000,
    closedMs: 0,
    spanMs: 30_000,
    coverage: 1,
    closures: [],
    sampleCount: 450,
    lastTimestampMs: 31_000,
    ...overrides,
  }
}
