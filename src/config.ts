export const EAR_LANDMARKS = {
  left: [33, 160, 158, 133, 153, 144],
  right: [362, 385, 387, 263, 373, 380],
} as const

export const PITCH_LANDMARKS = {
  forehead: 10,
  chin: 152,
  eyeOuterLeft: 33,
  eyeOuterRight: 263,
} as const

export const INFERENCE_FPS = 15
export const INFERENCE_INTERVAL_MS = 1000 / INFERENCE_FPS
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: 'user',
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30 },
  },
  audio: false,
}

export const EMA_ALPHA = 0.45

export const WINDOW_MS = 60_000
export const WARMUP_MS = 15_000
export const MIN_COVERAGE = 0.5
export const MAX_SAMPLE_GAP_MS = 500
export const MAX_SAMPLE_RATE_HZ = 30

export const BLINK_FLOOR_MS = 60
export const NOD_DEADBAND_DEG = 4
export const FACE_LOST_MS = 1200

export const CLOSURE_POINT_MIN = 0.5
export const CLOSURE_POINT_MAX = 0.88
export const CLOSURE_POINT_DEFAULT = 0.7
export const CLOSURE_POINT_STEP = 0.01

export const CAL_OPEN_MS = 8_000
export const CAL_BLINK_MS = 7_000
export const CAL_TOTAL_MS = CAL_OPEN_MS + CAL_BLINK_MS
export const CAL_CLOSED_PERCENTILE = 3
export const CAL_MIN_SEPARATION = 0.03
export const CAL_MIN_FACE_FRACTION = 0.6
export const CAL_MIN_SAMPLES_PER_PHASE = 20

export const RECALIBRATE_DRIFT_EAR = 0.05
export const RECALIBRATE_CHECK_AFTER_MS = 20_000

export const TRACE_WINDOW_MS = WINDOW_MS
export const ALARM_TEST_MS = 1400

export const STORAGE_KEY_CALIBRATION = 'vigil.calibration.v1'
export const STORAGE_KEY_PROFILE = 'vigil.profile.v1'

export type ProfileId = 'vigilant' | 'couch'

export interface AlarmStyle {
  waveform: OscillatorType
  toneAHz: number
  toneBHz: number
  swapMs: number
  gain: number
  vibrate: readonly number[] | null
}

export interface Tuning {
  id: ProfileId
  label: string
  blurb: string
  perclosCaution: number
  perclosAlarm: number
  longBlinkMs: number
  longBlinkRateCaution: number
  longBlinkRateAlarm: number
  microsleepMs: number
  nodDriftDeg: number | null
  levelDwellMs: number
  dismissMuteMs: number
  microsleepMuteMs: number
  alarm: AlarmStyle
}

export const PROFILES: Record<ProfileId, Tuning> = {
  vigilant: {
    id: 'vigilant',
    label: 'Vigilant',
    blurb: 'Driver-monitoring thresholds. Fires early, on the first hint of drowsiness.',
    perclosCaution: 0.08,
    perclosAlarm: 0.15,
    longBlinkMs: 300,
    longBlinkRateCaution: 2,
    longBlinkRateAlarm: 4,
    microsleepMs: 800,
    nodDriftDeg: 16,
    levelDwellMs: 3_000,
    dismissMuteMs: 20_000,
    microsleepMuteMs: 5_000,
    alarm: {
      waveform: 'square',
      toneAHz: 880,
      toneBHz: 1180,
      swapMs: 210,
      gain: 0.28,
      vibrate: [220, 120, 220],
    },
  },
  couch: {
    id: 'couch',
    label: 'Couch',
    blurb: 'Only once you are properly gone. Slow, quiet, and ignores a head resting back.',
    perclosCaution: 0.25,
    perclosAlarm: 0.45,
    longBlinkMs: 600,
    longBlinkRateCaution: 8,
    longBlinkRateAlarm: 14,
    microsleepMs: 4_000,
    nodDriftDeg: null,
    levelDwellMs: 6_000,
    dismissMuteMs: 120_000,
    microsleepMuteMs: 45_000,
    alarm: {
      waveform: 'sine',
      toneAHz: 523,
      toneBHz: 659,
      swapMs: 600,
      gain: 0.09,
      vibrate: [400],
    },
  },
}

export const DEFAULT_PROFILE: ProfileId = 'vigilant'

export function isProfileId(value: unknown): value is ProfileId {
  return value === 'vigilant' || value === 'couch'
}

export function configProblems(): string[] {
  const problems: string[] = []

  for (const tuning of Object.values(PROFILES)) {
    const where = `profile "${tuning.id}"`
    if (tuning.dismissMuteMs <= WARMUP_MS) {
      problems.push(
        `${where}: dismissMuteMs (${tuning.dismissMuteMs}) must exceed WARMUP_MS (${WARMUP_MS}), otherwise ` +
          'the window cleared on dismissal has not re-warmed when the mute lifts and the app is blind.',
      )
    }
    if (tuning.microsleepMuteMs >= tuning.dismissMuteMs) {
      problems.push(`${where}: microsleepMuteMs must be shorter than dismissMuteMs — microsleep stays live.`)
    }
    if (BLINK_FLOOR_MS >= tuning.longBlinkMs) problems.push(`${where}: BLINK_FLOOR_MS must be below longBlinkMs.`)
    if (tuning.longBlinkMs >= tuning.microsleepMs) {
      problems.push(`${where}: longBlinkMs must be below microsleepMs.`)
    }
    if (tuning.perclosCaution >= tuning.perclosAlarm) {
      problems.push(`${where}: perclosCaution must be below perclosAlarm.`)
    }
    if (tuning.perclosAlarm > 1) problems.push(`${where}: perclosAlarm is a fraction and cannot exceed 1.`)
    if (tuning.longBlinkRateCaution >= tuning.longBlinkRateAlarm) {
      problems.push(`${where}: longBlinkRateCaution must be below longBlinkRateAlarm.`)
    }
    if (tuning.nodDriftDeg !== null && tuning.nodDriftDeg <= NOD_DEADBAND_DEG) {
      problems.push(`${where}: nodDriftDeg must exceed NOD_DEADBAND_DEG or the deadband swallows it.`)
    }
    if (tuning.alarm.gain <= 0 || tuning.alarm.gain > 1) problems.push(`${where}: alarm gain must be in (0, 1].`)
  }

  if (WARMUP_MS >= WINDOW_MS) problems.push('WARMUP_MS must be below WINDOW_MS.')
  if (CLOSURE_POINT_DEFAULT < CLOSURE_POINT_MIN || CLOSURE_POINT_DEFAULT > CLOSURE_POINT_MAX) {
    problems.push('CLOSURE_POINT_DEFAULT must sit inside the slider range.')
  }
  return problems
}
