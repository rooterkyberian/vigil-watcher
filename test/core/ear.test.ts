import { describe, expect, it } from 'vitest'
import {
  averageEyeAspect,
  clamp,
  closureThreshold,
  crossingFraction,
  ema,
  eyeAspect,
  headPitchProxy,
  median,
  median3,
  percentile,
  pitchDriftDeg,
  type EyePoints,
} from '../../src/core/ear'
import { CALIBRATION } from '../fixtures/synth'

const openEye: EyePoints = [
  { x: 0, y: 0 },
  { x: 3, y: 2 },
  { x: 7, y: 2 },
  { x: 10, y: 0 },
  { x: 7, y: -2 },
  { x: 3, y: -2 },
]

const shutEye: EyePoints = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 7, y: 0 },
  { x: 10, y: 0 },
  { x: 7, y: 0 },
  { x: 3, y: 0 },
]

describe('eyeAspect', () => {
  it('matches the Soukupova-Cech ratio for an open eye', () => {
    expect(eyeAspect(openEye)).toBeCloseTo(0.4, 10)
  })

  it('collapses to zero when the lids meet', () => {
    expect(eyeAspect(shutEye)).toBe(0)
  })

  it('is invariant to scale, so camera distance cancels out', () => {
    const scaled = openEye.map((point) => ({ x: point.x * 7.3, y: point.y * 7.3 })) as unknown as EyePoints
    expect(eyeAspect(scaled)).toBeCloseTo(eyeAspect(openEye), 10)
  })

  it('returns NaN when the eye corners coincide', () => {
    const degenerate = openEye.map(() => ({ x: 1, y: 1 })) as unknown as EyePoints
    expect(Number.isNaN(eyeAspect(degenerate))).toBe(true)
  })

  it('averages both eyes and tolerates one degenerate side', () => {
    expect(averageEyeAspect(openEye, shutEye)).toBeCloseTo(0.2, 10)
    const degenerate = openEye.map(() => ({ x: 1, y: 1 })) as unknown as EyePoints
    expect(averageEyeAspect(openEye, degenerate)).toBeCloseTo(0.4, 10)
    expect(averageEyeAspect(degenerate, degenerate)).toBeNull()
  })
})

describe('head pitch proxy', () => {
  const forehead = { x: 0, y: -1 }
  const chin = { x: 0, y: 1 }
  const eyeLeft = { x: -0.5, y: 0 }
  const eyeRight = { x: 0.5, y: 0 }

  it('reports forehead-to-chin length over inter-ocular distance', () => {
    const proxy = headPitchProxy(forehead, chin, eyeLeft, eyeRight)
    expect(proxy?.foreshorten).toBeCloseTo(2, 10)
    expect(proxy?.balance).toBeCloseTo(0.5, 10)
  })

  it('reads foreshortening as a signed angle against the baseline', () => {
    const base = { foreshorten: 2, balance: 0.55 }
    const nodded = { foreshorten: 2 * Math.cos((20 * Math.PI) / 180), balance: 0.4 }
    expect(pitchDriftDeg(nodded, base)).toBeCloseTo(20, 6)

    const raised = { foreshorten: nodded.foreshorten, balance: 0.7 }
    expect(pitchDriftDeg(raised, base)).toBeCloseTo(-20, 6)
  })

  it('clamps to zero drift when the head is more upright than the baseline', () => {
    expect(pitchDriftDeg({ foreshorten: 3, balance: 0.4 }, { foreshorten: 2, balance: 0.55 })).toBe(0)
  })

  it('degenerates safely without a usable baseline', () => {
    expect(pitchDriftDeg({ foreshorten: 1, balance: 0.4 }, { foreshorten: 0, balance: 0.5 })).toBe(0)
    expect(headPitchProxy(forehead, chin, eyeLeft, eyeLeft)).toBeNull()
  })
})

describe('filters and statistics', () => {
  it('median3 picks the middle value regardless of order', () => {
    expect(median3(1, 2, 3)).toBe(2)
    expect(median3(3, 1, 2)).toBe(2)
    expect(median3(5, 5, 1)).toBe(5)
    expect(median3(0.3, 0.08, 0.3)).toBe(0.3)
  })

  it('ema seeds from the first value', () => {
    expect(ema(null, 0.4, 0.45)).toBe(0.4)
    expect(ema(0.4, 0.2, 0.5)).toBeCloseTo(0.3, 10)
  })

  it('percentile interpolates linearly', () => {
    const values = [5, 1, 4, 2, 3]
    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 100)).toBe(5)
    expect(percentile(values, 50)).toBe(3)
    expect(percentile(values, 25)).toBe(2)
    expect(median(values)).toBe(3)
    expect(Number.isNaN(percentile([], 50))).toBe(true)
  })

  it('clamp bounds both ends', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
})

describe('closure threshold', () => {
  it('sits closurePoint of the way from open down to shut', () => {
    expect(closureThreshold(CALIBRATION)).toBeCloseTo(0.16, 10)
    expect(closureThreshold({ ...CALIBRATION, closurePoint: 0.5 })).toBeCloseTo(0.2, 10)
    expect(closureThreshold({ ...CALIBRATION, closurePoint: 0.88 })).toBeCloseTo(0.124, 10)
  })

  it('locates the sub-frame crossing between two samples', () => {
    expect(crossingFraction(0.3, 0.08, 0.16)).toBeCloseTo(0.14 / 0.22, 10)
    expect(crossingFraction(0.08, 0.3, 0.16)).toBeCloseTo(0.08 / 0.22, 10)
    expect(crossingFraction(0.2, 0.2, 0.16)).toBe(0.5)
  })
})
