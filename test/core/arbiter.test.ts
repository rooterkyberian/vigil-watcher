import { describe, expect, it } from 'vitest'
import { Arbiter } from '../../src/core/arbiter'
import { COUCH, TraceBuilder, VIGILANT, levelsSeen, replay, stubStats } from '../fixtures/synth'

const DISMISS_MUTE_MS = VIGILANT.dismissMuteMs
const LEVEL_DWELL_MS = VIGILANT.levelDwellMs
const MICROSLEEP_MUTE_MS = VIGILANT.microsleepMuteMs

describe('threshold ladder', () => {
  it('stays quiet when every signal is nominal', () => {
    const verdict = new Arbiter(VIGILANT).update(stubStats(), 1_000)
    expect(verdict.level).toBe('ok')
    expect(verdict.reasonCode).toBe('ok')
    expect(verdict.dataState).toBe('tracking')
  })

  it('alarms on a microsleep even before the window has warmed up', () => {
    const verdict = new Arbiter(VIGILANT).update(
      stubStats({ openClosureMs: 1_400, perclos: null, longBlinksPerMin: null, observedMs: 4_000 }),
      1_000,
    )
    expect(verdict.level).toBe('alarm')
    expect(verdict.reasonCode).toBe('microsleep')
    expect(verdict.reason).toBe('Eyes closed for 1.4 s')
  })

  it('separates caution from alarm on PERCLOS', () => {
    expect(new Arbiter(VIGILANT).update(stubStats({ perclos: 0.1 }), 1_000).level).toBe('caution')
    expect(new Arbiter(VIGILANT).update(stubStats({ perclos: 0.16 }), 1_000).level).toBe('alarm')
    expect(new Arbiter(VIGILANT).update(stubStats({ perclos: 0.08 }), 1_000).level).toBe('ok')
  })

  it('separates caution from alarm on long-blink rate', () => {
    expect(new Arbiter(VIGILANT).update(stubStats({ longBlinksPerMin: 2 }), 1_000).level).toBe('caution')
    expect(new Arbiter(VIGILANT).update(stubStats({ longBlinksPerMin: 4 }), 1_000).level).toBe('alarm')
  })

  it('treats a nod alone as caution and a nod with closure as alarm', () => {
    expect(new Arbiter(VIGILANT).update(stubStats({ pitchDriftDeg: 20 }), 1_000).level).toBe('caution')
    expect(new Arbiter(VIGILANT).update(stubStats({ pitchDriftDeg: 20, perclos: 0.1 }), 1_000).reasonCode).toBe(
      'nod-with-perclos',
    )
    expect(new Arbiter(VIGILANT).update(stubStats({ pitchDriftDeg: 20, perclos: 0.1 }), 1_000).level).toBe('alarm')
    expect(new Arbiter(VIGILANT).update(stubStats({ pitchDriftDeg: -20 }), 1_000).level).toBe('ok')
  })

  it('carries a readable reason, not a threshold name', () => {
    expect(new Arbiter(VIGILANT).update(stubStats({ perclos: 0.22 }), 1_000).reason).toBe(
      'Eyes shut 22% of the last minute',
    )
    expect(new Arbiter(VIGILANT).update(stubStats({ longBlinksPerMin: 5 }), 1_000).reason).toBe(
      '5 long blinks in the last minute',
    )
  })
})

describe('missing data', () => {
  it('shows a distinct no-face state rather than an all-clear', () => {
    const verdict = new Arbiter(VIGILANT).update(stubStats({ faceLostMs: 2_000 }), 1_000)
    expect(verdict.reasonCode).toBe('no-face')
    expect(verdict.dataState).toBe('no-face')
    expect(verdict.level).toBe('ok')
  })

  it('holds an active alarm through a face loss instead of dropping it', () => {
    const arbiter = new Arbiter(VIGILANT)
    expect(arbiter.update(stubStats({ openClosureMs: 1_200 }), 1_000).level).toBe('alarm')
    const during = arbiter.update(stubStats({ faceLostMs: 4_000, openClosureMs: 0 }), 30_000)
    expect(during.level).toBe('alarm')
    expect(during.dataState).toBe('no-face')
  })

  it('reports warm-up and low-coverage separately', () => {
    expect(
      new Arbiter(VIGILANT).update(stubStats({ perclos: null, longBlinksPerMin: null, observedMs: 5_000 }), 1_000)
        .reasonCode,
    ).toBe('warming')
    expect(
      new Arbiter(VIGILANT).update(
        stubStats({ perclos: null, longBlinksPerMin: null, observedMs: 20_000, coverage: 0.2 }),
        1_000,
      ).reasonCode,
    ).toBe('insufficient-data')
  })
})

describe('dismissal', () => {
  it('mutes the window-derived triggers for the full mute period', () => {
    const arbiter = new Arbiter(VIGILANT)
    arbiter.dismiss(1_000)
    expect(arbiter.update(stubStats({ perclos: 0.5 }), 2_000).level).toBe('ok')
    expect(arbiter.update(stubStats({ perclos: 0.5 }), 1_000 + DISMISS_MUTE_MS - 1).reasonCode).toBe('muted')
    expect(arbiter.update(stubStats({ perclos: 0.5 }), 1_000 + DISMISS_MUTE_MS + 1).level).toBe('alarm')
  })

  it('keeps microsleep live on a much shorter mute', () => {
    const arbiter = new Arbiter(VIGILANT)
    arbiter.dismiss(1_000)
    expect(arbiter.update(stubStats({ openClosureMs: 1_500 }), 1_000 + MICROSLEEP_MUTE_MS - 1).level).toBe('ok')
    expect(arbiter.update(stubStats({ openClosureMs: 1_500 }), 1_000 + MICROSLEEP_MUTE_MS + 1).level).toBe(
      'alarm',
    )
  })
})

describe('hysteresis', () => {
  it('will not drop a level until it has been held for the dwell time', () => {
    const arbiter = new Arbiter(VIGILANT)
    expect(arbiter.update(stubStats({ perclos: 0.2 }), 1_000).level).toBe('alarm')
    expect(arbiter.update(stubStats({ perclos: 0 }), 1_000 + LEVEL_DWELL_MS - 1).level).toBe('alarm')
    expect(arbiter.update(stubStats({ perclos: 0 }), 1_000 + LEVEL_DWELL_MS + 1).level).toBe('ok')
  })

  it('escalates immediately without waiting for the dwell', () => {
    const arbiter = new Arbiter(VIGILANT)
    expect(arbiter.update(stubStats({ perclos: 0.1 }), 1_000).level).toBe('caution')
    expect(arbiter.update(stubStats({ perclos: 0.2 }), 1_100).level).toBe('alarm')
  })
})

describe('end to end over synthetic traces', () => {
  it('never alarms on a normally blinking, alert user', () => {
    const frames = replay(new TraceBuilder().blinkTrain(90_000, 3_000, 133).build())
    expect(levelsSeen(frames)).toEqual(['ok'])
  })

  it('escalates to alarm on a two-second microsleep', () => {
    const frames = replay(new TraceBuilder().open(30_000).shut(2_000).open(5_000).build())
    expect(frames.some((frame) => frame.verdict.reasonCode === 'microsleep')).toBe(true)
    expect(levelsSeen(frames)).toContain('alarm')
  })

  it('escalates on a sustained run of drowsy long blinks', () => {
    const frames = replay(new TraceBuilder().blinkTrain(90_000, 3_000, 400).build())
    const final = frames[frames.length - 1]
    expect(final?.verdict.level).toBe('alarm')
    expect(['perclos', 'long-blinks']).toContain(final?.verdict.reasonCode)
  })

  it('alarms on a nod plus closure that neither would trigger alone', () => {
    const nodded = { foreshorten: 2 * Math.cos((22 * Math.PI) / 180), balance: 0.4 }
    const heavyLids = new TraceBuilder().blinkTrain(70_000, 2_300, 250)
    const upright = replay(heavyLids.build())
    const uprightFinal = upright[upright.length - 1]
    expect(uprightFinal?.verdict.level).toBe('caution')
    expect(uprightFinal?.stats.longBlinkCount).toBe(0)

    const frames = replay(new TraceBuilder().withPitch(nodded).blinkTrain(70_000, 2_300, 250).build())
    const final = frames[frames.length - 1]
    expect(final?.verdict.level).toBe('alarm')
    expect(final?.verdict.reasonCode).toBe('nod-with-perclos')
  })
})

describe('watch modes', () => {
  const NODDED = { foreshorten: 2 * Math.cos((22 * Math.PI) / 180), balance: 0.4 }

  it('couch ignores the run of drowsy blinks that alarms vigilant', () => {
    const samples = new TraceBuilder().blinkTrain(90_000, 3_000, 400).build()
    expect(levelsSeen(replay(samples, undefined, VIGILANT))).toContain('alarm')
    expect(levelsSeen(replay(samples, undefined, COUCH))).toEqual(['ok'])
  })

  it('couch rides out a head bob that vigilant treats as a microsleep', () => {
    const samples = new TraceBuilder().open(30_000).shut(1_500).open(5_000).build()
    expect(levelsSeen(replay(samples, undefined, VIGILANT))).toContain('alarm')
    expect(levelsSeen(replay(samples, undefined, COUCH))).toEqual(['ok'])
  })

  it('couch ignores a head settling back, which vigilant reads as a nod', () => {
    const samples = new TraceBuilder().open(30_000).withPitch(NODDED).open(30_000).build()
    expect(levelsSeen(replay(samples, undefined, VIGILANT))).toContain('caution')
    expect(levelsSeen(replay(samples, undefined, COUCH))).toEqual(['ok'])
  })

  it('couch still alarms once someone is properly asleep', () => {
    const frames = replay(new TraceBuilder().open(30_000).shut(6_000).build(), undefined, COUCH)
    const final = frames[frames.length - 1]
    expect(final?.verdict.level).toBe('alarm')
    expect(final?.verdict.reasonCode).toBe('microsleep')
  })

  it('is uniformly more permissive in couch than in vigilant', () => {
    expect(COUCH.perclosCaution).toBeGreaterThan(VIGILANT.perclosCaution)
    expect(COUCH.perclosAlarm).toBeGreaterThan(VIGILANT.perclosAlarm)
    expect(COUCH.longBlinkMs).toBeGreaterThan(VIGILANT.longBlinkMs)
    expect(COUCH.longBlinkRateAlarm).toBeGreaterThan(VIGILANT.longBlinkRateAlarm)
    expect(COUCH.microsleepMs).toBeGreaterThan(VIGILANT.microsleepMs)
    expect(COUCH.levelDwellMs).toBeGreaterThan(VIGILANT.levelDwellMs)
    expect(COUCH.dismissMuteMs).toBeGreaterThan(VIGILANT.dismissMuteMs)
    expect(COUCH.alarm.gain).toBeLessThan(VIGILANT.alarm.gain)
    expect(COUCH.nodDriftDeg).toBeNull()
  })
})
