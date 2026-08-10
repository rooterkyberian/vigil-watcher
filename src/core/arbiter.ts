import { FACE_LOST_MS, WARMUP_MS, type Tuning } from '../config'
import type { AlertLevel, DataState, Millis, ReasonCode } from './types'
import type { WindowStats } from './window'

export interface Verdict {
  level: AlertLevel
  reasonCode: ReasonCode
  reason: string
  dataState: DataState
}

const RANK: Record<AlertLevel, number> = { ok: 0, caution: 1, alarm: 2 }

const IDLE: Verdict = { level: 'ok', reasonCode: 'ok', reason: 'Standing by', dataState: 'idle' }

export class Arbiter {
  private tuning: Tuning
  private verdict: Verdict = IDLE
  private levelSinceMs: Millis | null = null
  private windowMutedUntilMs: Millis | null = null
  private microsleepMutedUntilMs: Millis | null = null

  constructor(tuning: Tuning) {
    this.tuning = tuning
  }

  setTuning(tuning: Tuning): void {
    this.tuning = tuning
  }

  update(stats: WindowStats, tMs: Millis): Verdict {
    const dataState = resolveDataState(stats)
    const faceLost = stats.faceLostMs > FACE_LOST_MS
    const microsleepMutedUntil = this.microsleepMutedUntilMs
    const windowMutedUntil = this.windowMutedUntilMs
    const microsleepMuted = microsleepMutedUntil !== null && tMs < microsleepMutedUntil

    if (!microsleepMuted && stats.openClosureMs > this.tuning.microsleepMs) {
      return this.settle(
        {
          level: 'alarm',
          reasonCode: 'microsleep',
          reason: `Eyes closed for ${(stats.openClosureMs / 1000).toFixed(1)} s`,
          dataState,
        },
        tMs,
      )
    }

    if (faceLost) {
      if (this.verdict.level === 'alarm') {
        this.verdict = { ...this.verdict, dataState: 'no-face' }
        return this.verdict
      }
      return this.settle(
        {
          level: 'ok',
          reasonCode: 'no-face',
          reason: 'No face in view — monitoring paused',
          dataState: 'no-face',
        },
        tMs,
      )
    }

    if (windowMutedUntil !== null && tMs < windowMutedUntil) {
      const secondsLeft = Math.ceil((windowMutedUntil - tMs) / 1000)
      return this.settle(
        {
          level: 'ok',
          reasonCode: 'muted',
          reason: `Muted for ${secondsLeft} s after dismissal`,
          dataState,
        },
        tMs,
      )
    }

    const { perclos, longBlinksPerMin } = stats
    if (perclos === null || longBlinksPerMin === null) {
      const secondsLeft = Math.ceil(Math.max(0, WARMUP_MS - stats.observedMs) / 1000)
      return this.settle(
        dataState === 'insufficient-data'
          ? {
              level: 'ok',
              reasonCode: 'insufficient-data',
              reason: 'Too little usable data — keep your face in view',
              dataState,
            }
          : {
              level: 'ok',
              reasonCode: 'warming',
              reason: `Warming up — ${secondsLeft} s more data needed`,
              dataState,
            },
        tMs,
      )
    }

    const nod = stats.pitchDriftDeg ?? 0
    const nodding = this.tuning.nodDriftDeg !== null && nod > this.tuning.nodDriftDeg
    const shutPercent = Math.round(perclos * 100)
    const blinkRate = Math.round(longBlinksPerMin)

    if (perclos > this.tuning.perclosAlarm) {
      return this.settle(
        {
          level: 'alarm',
          reasonCode: 'perclos',
          reason: `Eyes shut ${shutPercent}% of the last minute`,
          dataState,
        },
        tMs,
      )
    }
    if (longBlinksPerMin >= this.tuning.longBlinkRateAlarm) {
      return this.settle(
        {
          level: 'alarm',
          reasonCode: 'long-blinks',
          reason: `${blinkRate} long blinks in the last minute`,
          dataState,
        },
        tMs,
      )
    }
    if (nodding && perclos > this.tuning.perclosCaution) {
      return this.settle(
        {
          level: 'alarm',
          reasonCode: 'nod-with-perclos',
          reason: `Head dropped ${Math.round(nod)}° with eyes shut ${shutPercent}% of the minute`,
          dataState,
        },
        tMs,
      )
    }
    if (perclos > this.tuning.perclosCaution) {
      return this.settle(
        {
          level: 'caution',
          reasonCode: 'perclos',
          reason: `Eyes shut ${shutPercent}% of the last minute`,
          dataState,
        },
        tMs,
      )
    }
    if (longBlinksPerMin >= this.tuning.longBlinkRateCaution) {
      return this.settle(
        {
          level: 'caution',
          reasonCode: 'long-blinks',
          reason: `${blinkRate} long blinks in the last minute`,
          dataState,
        },
        tMs,
      )
    }
    if (nodding) {
      return this.settle(
        {
          level: 'caution',
          reasonCode: 'nod',
          reason: `Head dropped ${Math.round(nod)}° below your baseline`,
          dataState,
        },
        tMs,
      )
    }

    return this.settle({ level: 'ok', reasonCode: 'ok', reason: 'Alert', dataState }, tMs)
  }

  dismiss(tMs: Millis): void {
    this.windowMutedUntilMs = tMs + this.tuning.dismissMuteMs
    this.microsleepMutedUntilMs = tMs + this.tuning.microsleepMuteMs
    this.verdict = { level: 'ok', reasonCode: 'muted', reason: 'Dismissed', dataState: 'warming' }
    this.levelSinceMs = tMs
  }

  reset(): void {
    this.verdict = IDLE
    this.levelSinceMs = null
    this.windowMutedUntilMs = null
    this.microsleepMutedUntilMs = null
  }

  current(): Verdict {
    return this.verdict
  }

  private settle(target: Verdict, tMs: Millis): Verdict {
    const held = this.levelSinceMs !== null && tMs - this.levelSinceMs < this.tuning.levelDwellMs
    if (RANK[target.level] < RANK[this.verdict.level] && held) {
      this.verdict = { ...this.verdict, dataState: target.dataState }
      return this.verdict
    }
    if (target.level !== this.verdict.level) this.levelSinceMs = tMs
    this.verdict = target
    return this.verdict
  }
}

function resolveDataState(stats: WindowStats): DataState {
  if (stats.sampleCount === 0) return 'idle'
  if (stats.faceLostMs > FACE_LOST_MS) return 'no-face'
  if (stats.perclos !== null) return 'tracking'
  if (stats.observedMs >= WARMUP_MS) return 'insufficient-data'
  return 'warming'
}
