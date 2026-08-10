export type Millis = number
export type Ear = number
export type Degrees = number

export type AlertLevel = 'ok' | 'caution' | 'alarm'

export type ReasonCode =
  | 'ok'
  | 'warming'
  | 'no-face'
  | 'insufficient-data'
  | 'muted'
  | 'microsleep'
  | 'perclos'
  | 'long-blinks'
  | 'nod'
  | 'nod-with-perclos'

export type DataState = 'idle' | 'warming' | 'tracking' | 'no-face' | 'insufficient-data'

export interface Point2 {
  x: number
  y: number
}

/**
 * Nod proxy, not head-pose estimation. `foreshorten` is the image-plane forehead-to-chin
 * length over inter-ocular distance, which shortens as the head pitches away from the
 * calibrated baseline. `balance` is the lower face's share of total face height and only
 * supplies the sign. Neither uses MediaPipe's `z`, which is relative and too noisy here.
 */
export interface PitchProxy {
  foreshorten: number
  balance: number
}

export interface Sample {
  tMs: Millis
  earRaw: Ear | null
  pitch: PitchProxy | null
}

export interface Calibration {
  schemaVersion: 1
  openEar: Ear
  closedEar: Ear
  pitchBase: PitchProxy
  closurePoint: number
  capturedAtEpochMs: Millis
  profileLabel: string
}

export interface Closure {
  startMs: Millis
  endMs: Millis
  durationMs: Millis
  endedByFaceLoss: boolean
}

export interface Signals {
  level: AlertLevel
  reasonCode: ReasonCode
  reason: string
  dataState: DataState
  perclos: number | null
  longBlinksPerMin: number | null
  openClosureMs: Millis
  pitchDriftDeg: Degrees | null
  earSmoothed: Ear | null
  earRaw: Ear | null
  closureThreshold: Ear
  faceLostMs: Millis
  observedMs: Millis
  coverage: number
}

export type CalibrationPhase = 'idle' | 'open' | 'blink' | 'done' | 'rejected'

export type CalibrationRejectionCode = 'low-separation' | 'insufficient-face' | 'too-few-samples'

export interface CalibrationRejection {
  code: CalibrationRejectionCode
  message: string
  hint: string
}

export interface CalibrationMeasurement {
  openEar: Ear
  closedEar: Ear
  pitchBase: PitchProxy
}

export interface CalibrationState {
  phase: CalibrationPhase
  phaseElapsedMs: Millis
  phaseRemainingMs: Millis
  phaseProgress: number
  usableSamples: number
  measurement: CalibrationMeasurement | null
  rejection: CalibrationRejection | null
}

export interface TracePoint {
  tMs: Millis
  earRaw: Ear | null
}
