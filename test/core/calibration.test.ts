import { describe, expect, it } from 'vitest'
import { CAL_MIN_SEPARATION, CLOSURE_POINT_DEFAULT } from '../../src/config'
import { CalibrationRun } from '../../src/core/calibration'
import { closureThreshold } from '../../src/core/ear'
import type { CalibrationMeasurement, Sample } from '../../src/core/types'
import { BASE_PITCH, PERIOD_MS, TraceBuilder } from '../fixtures/synth'

function run(samples: readonly Sample[]): CalibrationRun {
  const calibration = new CalibrationRun()
  for (const sample of samples) calibration.push(sample)
  return calibration
}

function goodTrace(shutEar = 0.08): Sample[] {
  const builder = new TraceBuilder(0)
  builder.open(8_000)
  for (let cycle = 0; cycle < 6; cycle += 1) {
    builder.open(700)
    builder.at(shutEar, 500)
  }
  return builder.open(500).build()
}

describe('two-phase calibration', () => {
  it('derives open, shut and the closure threshold from a clean run', () => {
    const state = run(goodTrace()).state()
    expect(state.phase).toBe('done')
    expect(state.rejection).toBeNull()

    const measurement = state.measurement as CalibrationMeasurement
    expect(measurement.openEar).toBeCloseTo(0.3, 3)
    expect(measurement.closedEar).toBeCloseTo(0.08, 3)
    expect(measurement.pitchBase.foreshorten).toBeCloseTo(BASE_PITCH.foreshorten, 6)
    expect(measurement.pitchBase.balance).toBeCloseTo(BASE_PITCH.balance, 6)

    const threshold = closureThreshold({
      schemaVersion: 1,
      openEar: measurement.openEar,
      closedEar: measurement.closedEar,
      pitchBase: measurement.pitchBase,
      closurePoint: CLOSURE_POINT_DEFAULT,
      capturedAtEpochMs: 0,
      profileLabel: 'test',
    })
    expect(threshold).toBeCloseTo(0.3 - 0.7 * 0.22, 3)
  })

  it('walks through both phases with a countdown before settling', () => {
    const samples = goodTrace()
    const calibration = new CalibrationRun()
    const phases: string[] = []

    for (const sample of samples) {
      calibration.push(sample)
      const state = calibration.state()
      if (phases[phases.length - 1] !== state.phase) phases.push(state.phase)
    }

    expect(phases).toEqual(['open', 'blink', 'done'])
    expect(calibration.state().phaseProgress).toBe(1)
  })

  it('refuses a run where open and shut are too close together', () => {
    const state = run(goodTrace(0.29)).state()
    expect(state.phase).toBe('rejected')
    expect(state.measurement).toBeNull()
    expect(state.rejection?.code).toBe('low-separation')
    expect(state.rejection?.message).toContain(String(CAL_MIN_SEPARATION))
    expect(state.rejection?.hint).toMatch(/glasses/i)
  })

  it('refuses a run where the face kept leaving the frame', () => {
    const samples = goodTrace().map((sample, index) =>
      index % 2 === 0 && sample.tMs < 8_000 ? { ...sample, earRaw: null, pitch: null } : sample,
    )
    const state = run(samples).state()
    expect(state.phase).toBe('rejected')
    expect(state.rejection?.code).toBe('insufficient-face')
  })

  it('blames the face, not the camera, when frames arrive with nobody in them', () => {
    const samples = goodTrace().map((sample) => ({ ...sample, earRaw: null, pitch: null }))
    const state = run(samples).state()
    expect(state.phase).toBe('rejected')
    expect(state.rejection?.code).toBe('insufficient-face')
    expect(state.rejection?.hint).toMatch(/centre your face/i)
    expect(state.rejection?.hint).not.toMatch(/stalled/i)
  })

  it('blames the camera only when the camera really did stall', () => {
    const sparse: Sample[] = [
      { tMs: 0, earRaw: 0.3, pitch: BASE_PITCH },
      { tMs: 8_100, earRaw: 0.08, pitch: BASE_PITCH },
      { tMs: 15_100, earRaw: 0.3, pitch: BASE_PITCH },
    ]
    const state = run(sparse).state()
    expect(state.phase).toBe('rejected')
    expect(state.rejection?.code).toBe('too-few-samples')
  })

  it('replays byte-identically from the same samples', () => {
    const samples = goodTrace()
    expect(JSON.stringify(run(samples).state())).toBe(JSON.stringify(run(samples).state()))
  })

  it('measures from elapsed time, so an absolute clock offset changes nothing', () => {
    const samples = goodTrace()
    const shifted = samples.map((sample) => ({ ...sample, tMs: sample.tMs + 987_654 }))
    const before = run(samples).state()
    const after = run(shifted).state()

    expect(after.phase).toBe(before.phase)
    expect(after.measurement).toEqual(before.measurement)
    expect(after.usableSamples).toBeCloseTo(before.usableSamples, -1)
  })

  it('ignores samples that arrive after it has settled', () => {
    const calibration = run(goodTrace())
    const before = JSON.stringify(calibration.state())
    calibration.push({ tMs: 99_000, earRaw: 0.01, pitch: BASE_PITCH })
    expect(JSON.stringify(calibration.state())).toBe(before)
  })

  it('samples the blink phase at the configured rate', () => {
    expect(PERIOD_MS).toBeCloseTo(1000 / 15, 6)
  })
})
