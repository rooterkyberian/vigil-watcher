import { describe, expect, it } from 'vitest'
import { BLINK_FLOOR_MS, LONG_BLINK_MS, MICROSLEEP_MS } from '../../src/config'
import { SampleWindow } from '../../src/core/window'
import { CALIBRATION, PERIOD_MS, THRESHOLD, TraceBuilder, finalStats, replay } from '../fixtures/synth'

describe('steady state', () => {
  it('reports no closure at all while the eyes stay open', () => {
    const stats = finalStats(new TraceBuilder().open(30_000).build())
    expect(stats.perclos).toBe(0)
    expect(stats.longBlinksPerMin).toBe(0)
    expect(stats.closures).toHaveLength(0)
    expect(stats.faceLostMs).toBe(0)
    expect(stats.coverage).toBeCloseTo(1, 3)
  })

  it('withholds PERCLOS until the warm-up has enough observed time', () => {
    expect(finalStats(new TraceBuilder().open(10_000).build()).perclos).toBeNull()
    expect(finalStats(new TraceBuilder().open(20_000).build()).perclos).not.toBeNull()
  })
})

describe('blink measurement', () => {
  it('discards a single-frame dip as landmark noise', () => {
    const stats = finalStats(new TraceBuilder().open(5_000).frameShut(1).open(5_000).build())
    expect(stats.closures).toHaveLength(0)
    expect(stats.closedMs).toBe(0)
  })

  it('measures a 400 ms closure as a long blink', () => {
    const stats = finalStats(new TraceBuilder().open(5_000).shut(400).open(5_000).build())
    expect(stats.closures).toHaveLength(1)
    expect(stats.closures[0]?.durationMs).toBeGreaterThan(340)
    expect(stats.closures[0]?.durationMs).toBeLessThan(410)
    expect(stats.longBlinkCount).toBe(1)
  })

  it('counts a short blink toward PERCLOS but not toward the long-blink rate', () => {
    const stats = finalStats(new TraceBuilder().open(5_000).shut(133).open(5_000).build())
    expect(stats.closures).toHaveLength(1)
    const duration = stats.closures[0]?.durationMs ?? 0
    expect(duration).toBeGreaterThan(BLINK_FLOOR_MS)
    expect(duration).toBeLessThan(LONG_BLINK_MS)
    expect(stats.longBlinkCount).toBe(0)
    expect(stats.closedMs).toBeGreaterThan(0)
  })

  it('tracks a microsleep as one continuous, still-open closure', () => {
    const stats = finalStats(new TraceBuilder().open(5_000).shut(2_000).build())
    expect(stats.openClosureMs).toBeGreaterThan(MICROSLEEP_MS)
    expect(stats.openClosureMs).toBeLessThan(2_000)
    expect(stats.closures).toHaveLength(0)
  })

  it('keeps ordinary blinking well under the caution threshold', () => {
    const stats = finalStats(new TraceBuilder().blinkTrain(60_000, 3_000, 133).build())
    expect(stats.perclos).toBeLessThan(0.08)
    expect(stats.longBlinkCount).toBe(0)
  })

  it('raises the long-blink rate when blinks lengthen', () => {
    const stats = finalStats(new TraceBuilder().blinkTrain(60_000, 3_000, 400).build())
    expect(stats.longBlinkCount).toBeGreaterThanOrEqual(15)
    expect(stats.longBlinksPerMin ?? 0).toBeGreaterThan(4)
  })
})

describe('missing data', () => {
  it('excludes a face-lost gap from observed time instead of counting it as eyes-open', () => {
    const stats = finalStats(
      new TraceBuilder().open(10_000).shut(3_000).lost(10_000).open(10_000).build(),
    )

    expect(stats.spanMs).toBeGreaterThan(32_000)
    expect(stats.observedMs).toBeLessThan(24_000)
    expect(stats.perclos ?? 0).toBeGreaterThan(0.11)
    expect(stats.perclos ?? 0).toBeLessThan(0.15)
  })

  it('never lets a gap dilute PERCLOS toward zero', () => {
    const withGap = finalStats(new TraceBuilder().open(10_000).shut(3_000).lost(10_000).open(10_000).build())
    const countingTheGapAsOpen = 3_000 / 33_000
    expect(withGap.perclos ?? 0).toBeGreaterThan(countingTheGapAsOpen * 1.3)
  })

  it('refuses to classify a closure that ended because the face vanished', () => {
    const stats = finalStats(new TraceBuilder().open(10_000).shut(3_000).lost(5_000).open(10_000).build())
    const truncated = stats.closures.filter((closure) => closure.endedByFaceLoss)
    expect(truncated).toHaveLength(1)
    expect(stats.longBlinkCount).toBe(0)
  })

  it('reports how long the face has been missing', () => {
    const stats = finalStats(new TraceBuilder().open(10_000).lost(3_000).build())
    expect(stats.faceLostMs).toBeGreaterThan(2_800)
    expect(stats.faceLostMs).toBeLessThan(3_100)
  })
})

describe('window boundaries', () => {
  it('lets a long blink age out of the rolling window', () => {
    const frames = replay(new TraceBuilder().shut(400).open(75_000).build())
    const counts = frames.map((frame) => frame.stats.longBlinkCount)
    expect(Math.max(...counts)).toBe(1)
    expect(counts[counts.length - 1]).toBe(0)
  })

  it('keeps the buffer bounded to the window length', () => {
    const stats = finalStats(new TraceBuilder().open(180_000).build())
    expect(stats.spanMs).toBeLessThanOrEqual(60_000)
    expect(stats.sampleCount).toBeLessThanOrEqual(Math.ceil(60_000 / PERIOD_MS) + 2)
  })

  it('rejects duplicate and backward timestamps', () => {
    const window = new SampleWindow()
    expect(window.push({ tMs: 1_000, earRaw: 0.3, pitch: null })).toBe(true)
    expect(window.push({ tMs: 1_000, earRaw: 0.3, pitch: null })).toBe(false)
    expect(window.push({ tMs: 999, earRaw: 0.3, pitch: null })).toBe(false)
    expect(window.push({ tMs: 1_067, earRaw: 0.3, pitch: null })).toBe(true)
    expect(window.drops).toBe(2)
    expect(window.compute(THRESHOLD, null).sampleCount).toBe(2)
  })
})

describe('determinism', () => {
  it('yields identical signals when the same fixture is replayed twice', () => {
    const samples = new TraceBuilder().blinkTrain(40_000, 2_500, 350).lost(2_000).shut(1_200).build()
    const first = replay(samples).map((frame) => frame.stats)
    const second = replay(samples).map((frame) => frame.stats)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('reacts to the closure point without needing new samples', () => {
    const samples = new TraceBuilder().open(20_000).at(0.18, 3_000).open(5_000).build()
    const window = new SampleWindow()
    for (const sample of samples) window.push(sample)

    const strict = window.compute(0.2, CALIBRATION.pitchBase)
    const loose = window.compute(0.16, CALIBRATION.pitchBase)
    expect(strict.perclos ?? 0).toBeGreaterThan(0)
    expect(loose.perclos).toBe(0)
  })
})
