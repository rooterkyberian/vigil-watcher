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

export const PERCLOS_CAUTION = 0.08
export const PERCLOS_ALARM = 0.15

export const BLINK_FLOOR_MS = 60
export const LONG_BLINK_MS = 300
export const LONG_BLINK_RATE_CAUTION = 2
export const LONG_BLINK_RATE_ALARM = 4
export const MICROSLEEP_MS = 800

export const NOD_DRIFT_DEG = 16
export const NOD_DEADBAND_DEG = 4

export const FACE_LOST_MS = 1200

export const DISMISS_MUTE_MS = 20_000
export const MICROSLEEP_MUTE_MS = 5_000
export const LEVEL_DWELL_MS = 3_000

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
export const ALARM_TONE_A_HZ = 880
export const ALARM_TONE_B_HZ = 1180
export const ALARM_TONE_SWAP_MS = 210
export const ALARM_TEST_MS = 1400
export const VIBRATION_PATTERN = [220, 120, 220]

export const STORAGE_KEY_CALIBRATION = 'vigil.calibration.v1'

export function configProblems(): string[] {
  const problems: string[] = []
  if (DISMISS_MUTE_MS <= WARMUP_MS) {
    problems.push(
      `DISMISS_MUTE_MS (${DISMISS_MUTE_MS}) must exceed WARMUP_MS (${WARMUP_MS}), otherwise the ` +
        'window cleared on dismissal has not re-warmed by the time the mute lifts and the app is blind.',
    )
  }
  if (MICROSLEEP_MUTE_MS >= DISMISS_MUTE_MS) {
    problems.push('MICROSLEEP_MUTE_MS must be shorter than DISMISS_MUTE_MS — microsleep stays live after a dismissal.')
  }
  if (BLINK_FLOOR_MS >= LONG_BLINK_MS) problems.push('BLINK_FLOOR_MS must be below LONG_BLINK_MS.')
  if (PERCLOS_CAUTION >= PERCLOS_ALARM) problems.push('PERCLOS_CAUTION must be below PERCLOS_ALARM.')
  if (LONG_BLINK_RATE_CAUTION >= LONG_BLINK_RATE_ALARM) {
    problems.push('LONG_BLINK_RATE_CAUTION must be below LONG_BLINK_RATE_ALARM.')
  }
  if (WARMUP_MS >= WINDOW_MS) problems.push('WARMUP_MS must be below WINDOW_MS.')
  if (CLOSURE_POINT_DEFAULT < CLOSURE_POINT_MIN || CLOSURE_POINT_DEFAULT > CLOSURE_POINT_MAX) {
    problems.push('CLOSURE_POINT_DEFAULT must sit inside the slider range.')
  }
  return problems
}
