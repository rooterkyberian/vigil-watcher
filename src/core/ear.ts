import type { Calibration, Degrees, Ear, PitchProxy, Point2 } from './types'

export type EyePoints = readonly [Point2, Point2, Point2, Point2, Point2, Point2]

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

export function eyeAspect(eye: EyePoints): Ear {
  const horizontal = distance(eye[0], eye[3])
  if (!(horizontal > 0)) return Number.NaN
  return (distance(eye[1], eye[5]) + distance(eye[2], eye[4])) / (2 * horizontal)
}

export function averageEyeAspect(left: EyePoints, right: EyePoints): Ear | null {
  const l = eyeAspect(left)
  const r = eyeAspect(right)
  const lOk = Number.isFinite(l)
  const rOk = Number.isFinite(r)
  if (lOk && rOk) return (l + r) / 2
  if (lOk) return l
  if (rOk) return r
  return null
}

export function headPitchProxy(
  forehead: Point2,
  chin: Point2,
  eyeLeft: Point2,
  eyeRight: Point2,
): PitchProxy | null {
  const interocular = distance(eyeLeft, eyeRight)
  if (!(interocular > 0)) return null

  const eyeMid = { x: (eyeLeft.x + eyeRight.x) / 2, y: (eyeLeft.y + eyeRight.y) / 2 }
  const upper = distance(forehead, eyeMid)
  const lower = distance(eyeMid, chin)
  const height = upper + lower
  if (!(height > 0)) return null

  return { foreshorten: distance(forehead, chin) / interocular, balance: lower / height }
}

/**
 * Signed drift from the calibrated baseline under a weak-perspective assumption, positive
 * for a downward nod. Ill-conditioned near zero (acos has infinite slope at 1), so callers
 * smooth the proxy first and apply a deadband before acting on the result.
 */
export function pitchDriftDeg(now: PitchProxy, base: PitchProxy): Degrees {
  if (!(base.foreshorten > 0)) return 0
  const magnitude = (Math.acos(clamp(now.foreshorten / base.foreshorten, -1, 1)) * 180) / Math.PI
  return now.balance < base.balance ? magnitude : -magnitude
}

export function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
}

export function ema(previous: number | null, next: number, alpha: number): number {
  return previous === null ? next : previous + alpha * (next - previous)
}

export function median(values: readonly number[]): number {
  return percentile(values, 50)
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (clamp(p, 0, 100) / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  const lowValue = sorted[low]
  const highValue = sorted[high]
  if (lowValue === undefined || highValue === undefined) return Number.NaN
  return lowValue + (highValue - lowValue) * (rank - low)
}

export function closureThreshold(calibration: Calibration): Ear {
  return calibration.openEar - calibration.closurePoint * (calibration.openEar - calibration.closedEar)
}

export function crossingFraction(from: number, to: number, threshold: number): number {
  const span = from - to
  if (span === 0) return 0.5
  return clamp((from - threshold) / span, 0, 1)
}
