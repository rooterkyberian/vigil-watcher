import {
  CAL_BLINK_MS,
  CAL_CLOSED_PERCENTILE,
  CAL_MIN_FACE_FRACTION,
  CAL_MIN_SAMPLES_PER_PHASE,
  CAL_MIN_SEPARATION,
  CAL_OPEN_MS,
  CAL_TOTAL_MS,
  EMA_ALPHA,
} from '../config'
import { ema, median, percentile } from './ear'
import type {
  CalibrationMeasurement,
  CalibrationPhase,
  CalibrationRejection,
  CalibrationState,
  Ear,
  Millis,
  Sample,
} from './types'

export class CalibrationRun {
  private startMs: Millis | null = null
  private elapsedMs: Millis = 0
  private phase: CalibrationPhase = 'idle'
  private smoothed: Ear | null = null

  private readonly openEars: Ear[] = []
  private readonly openForeshorten: number[] = []
  private readonly openBalance: number[] = []
  private readonly blinkEars: Ear[] = []
  private openFrames = 0
  private blinkFrames = 0

  private measurement: CalibrationMeasurement | null = null
  private rejection: CalibrationRejection | null = null

  push(sample: Sample): void {
    if (this.phase === 'done' || this.phase === 'rejected') return
    if (this.startMs === null) this.startMs = sample.tMs

    this.elapsedMs = sample.tMs - this.startMs

    if (this.elapsedMs < CAL_OPEN_MS) {
      this.phase = 'open'
      this.openFrames += 1
      if (sample.earRaw === null) {
        this.smoothed = null
      } else {
        this.smoothed = ema(this.smoothed, sample.earRaw, EMA_ALPHA)
        this.openEars.push(this.smoothed)
      }
      if (sample.pitch !== null) {
        this.openForeshorten.push(sample.pitch.foreshorten)
        this.openBalance.push(sample.pitch.balance)
      }
      return
    }

    if (this.elapsedMs < CAL_TOTAL_MS) {
      this.phase = 'blink'
      this.blinkFrames += 1
      if (sample.earRaw !== null) this.blinkEars.push(sample.earRaw)
      return
    }

    this.finish()
  }

  state(): CalibrationState {
    const inBlink = this.phase === 'blink'
    const phaseElapsedMs = inBlink ? this.elapsedMs - CAL_OPEN_MS : this.elapsedMs
    const phaseLength = inBlink ? CAL_BLINK_MS : CAL_OPEN_MS
    const settled = this.phase === 'done' || this.phase === 'rejected'

    return {
      phase: this.phase,
      phaseElapsedMs: settled ? phaseLength : Math.max(0, phaseElapsedMs),
      phaseRemainingMs: settled ? 0 : Math.max(0, phaseLength - phaseElapsedMs),
      phaseProgress: settled ? 1 : Math.min(1, Math.max(0, phaseElapsedMs / phaseLength)),
      usableSamples: this.openEars.length + this.blinkEars.length,
      measurement: this.measurement,
      rejection: this.rejection,
    }
  }

  private finish(): void {
    const openCoverage = this.openFrames > 0 ? this.openEars.length / this.openFrames : 0
    const blinkCoverage = this.blinkFrames > 0 ? this.blinkEars.length / this.blinkFrames : 0
    const coverage = Math.min(openCoverage, blinkCoverage)

    if (this.openFrames < CAL_MIN_SAMPLES_PER_PHASE || this.blinkFrames < CAL_MIN_SAMPLES_PER_PHASE) {
      this.reject({
        code: 'too-few-samples',
        message: `The camera delivered only ${this.openFrames + this.blinkFrames} frames during the 15 second calibration.`,
        hint: 'The camera stalled or the tab lost focus. Start the session again and keep this screen in front of you.',
      })
      return
    }

    if (coverage < CAL_MIN_FACE_FRACTION || this.openEars.length < CAL_MIN_SAMPLES_PER_PHASE || this.blinkEars.length < CAL_MIN_SAMPLES_PER_PHASE) {
      this.reject({
        code: 'insufficient-face',
        message: `Your face was only found in ${Math.round(coverage * 100)}% of the calibration frames.`,
        hint: 'Centre your face in the preview, hold the phone at eye level so the camera looks straight at you, and keep still for the full 15 seconds.',
      })
      return
    }

    const openEar = median(this.openEars)
    const closedEar = percentile(this.blinkEars, CAL_CLOSED_PERCENTILE)
    const separation = openEar - closedEar

    if (!(separation >= CAL_MIN_SEPARATION)) {
      this.reject({
        code: 'low-separation',
        message: `Open and shut measured only ${separation.toFixed(3)} apart — this needs at least ${CAL_MIN_SEPARATION}.`,
        hint: 'Usually glasses reflecting the screen, a bright window behind you, or a camera angle looking up from below. Face a lamp, take glasses off if you can, hold the phone at eye level, then calibrate again.',
      })
      return
    }

    this.measurement = {
      openEar,
      closedEar,
      pitchBase:
        this.openForeshorten.length > 0
          ? { foreshorten: median(this.openForeshorten), balance: median(this.openBalance) }
          : { foreshorten: 0, balance: 0 },
    }
    this.phase = 'done'
  }

  private reject(rejection: CalibrationRejection): void {
    this.rejection = rejection
    this.phase = 'rejected'
  }
}
