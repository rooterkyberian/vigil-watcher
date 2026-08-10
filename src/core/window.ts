import {
  BLINK_FLOOR_MS,
  EMA_ALPHA,
  LONG_BLINK_MS,
  MAX_SAMPLE_GAP_MS,
  MAX_SAMPLE_RATE_HZ,
  MIN_COVERAGE,
  NOD_DEADBAND_DEG,
  WARMUP_MS,
  WINDOW_MS,
} from '../config'
import { crossingFraction, ema, median3, pitchDriftDeg } from './ear'
import type { Closure, Degrees, Ear, Millis, PitchProxy, Sample, TracePoint } from './types'

export interface WindowStats {
  perclos: number | null
  longBlinksPerMin: number | null
  longBlinkCount: number
  openClosureMs: Millis
  pitchDriftDeg: Degrees | null
  earRaw: Ear | null
  earSmoothed: Ear | null
  closureThreshold: Ear
  faceLostMs: Millis
  observedMs: Millis
  closedMs: Millis
  spanMs: Millis
  coverage: number
  closures: readonly Closure[]
  sampleCount: number
  lastTimestampMs: Millis | null
}

interface StoredSample {
  tMs: Millis
  earRaw: Ear | null
  earFiltered: Ear | null
  pitch: PitchProxy | null
}

const CAPACITY = Math.ceil((WINDOW_MS / 1000) * MAX_SAMPLE_RATE_HZ) + 8

export class SampleWindow {
  private readonly buffer: StoredSample[] = []
  private start = 0
  private count = 0
  private recentRaw: number[] = []
  private droppedTimestamps = 0

  push(sample: Sample): boolean {
    const last = this.at(this.count - 1)
    if (last !== null && sample.tMs <= last.tMs) {
      this.droppedTimestamps += 1
      return false
    }

    const stored: StoredSample = {
      tMs: sample.tMs,
      earRaw: sample.earRaw,
      earFiltered: this.filterRaw(sample.earRaw),
      pitch: sample.pitch,
    }

    if (this.count < CAPACITY) {
      this.buffer[(this.start + this.count) % CAPACITY] = stored
      this.count += 1
    } else {
      this.buffer[this.start] = stored
      this.start = (this.start + 1) % CAPACITY
    }

    this.evictOlderThan(sample.tMs - WINDOW_MS)
    return true
  }

  clear(): void {
    this.start = 0
    this.count = 0
    this.buffer.length = 0
    this.recentRaw = []
  }

  get drops(): number {
    return this.droppedTimestamps
  }

  compute(threshold: Ear, pitchBase: PitchProxy | null): WindowStats {
    const empty = this.count === 0
    const newest = this.at(this.count - 1)
    const oldest = this.at(0)

    let observedMs = 0
    let closedMs = 0
    let closureStart: Millis | null = null
    let lastFaceMs: Millis | null = null
    let earEma: Ear | null = null
    let foreshortenEma: number | null = null
    let balanceEma: number | null = null
    const closures: Closure[] = []

    for (let i = 0; i < this.count; i += 1) {
      const current = this.at(i)
      if (current === null) continue

      if (current.earFiltered !== null) earEma = ema(earEma, current.earFiltered, EMA_ALPHA)
      else earEma = null

      if (current.earRaw !== null) lastFaceMs = current.tMs

      if (current.pitch !== null) {
        foreshortenEma = ema(foreshortenEma, current.pitch.foreshorten, EMA_ALPHA)
        balanceEma = ema(balanceEma, current.pitch.balance, EMA_ALPHA)
      }

      if (i === 0) continue
      const previous = this.at(i - 1)
      if (previous === null) continue

      const dt = current.tMs - previous.tMs
      const previousEar = previous.earFiltered
      const currentEar = current.earFiltered

      if (previousEar === null || currentEar === null || dt <= 0 || dt > MAX_SAMPLE_GAP_MS) {
        if (closureStart !== null) {
          closures.push({
            startMs: closureStart,
            endMs: previous.tMs,
            durationMs: previous.tMs - closureStart,
            endedByFaceLoss: true,
          })
          closureStart = null
        }
        continue
      }

      observedMs += dt
      const wasClosed = previousEar < threshold
      const isClosed = currentEar < threshold

      if (wasClosed && isClosed) {
        closedMs += dt
        if (closureStart === null) closureStart = previous.tMs
      } else if (!wasClosed && isClosed) {
        const crossing = previous.tMs + dt * crossingFraction(previousEar, currentEar, threshold)
        closedMs += current.tMs - crossing
        closureStart = crossing
      } else if (wasClosed && !isClosed) {
        const crossing = previous.tMs + dt * crossingFraction(previousEar, currentEar, threshold)
        closedMs += crossing - previous.tMs
        const startMs = closureStart ?? previous.tMs
        closures.push({
          startMs,
          endMs: crossing,
          durationMs: crossing - startMs,
          endedByFaceLoss: false,
        })
        closureStart = null
      }
    }

    let noiseMs = 0
    const kept: Closure[] = []
    for (const closure of closures) {
      if (closure.durationMs < BLINK_FLOOR_MS) noiseMs += closure.durationMs
      else kept.push(closure)
    }
    closedMs = Math.max(0, closedMs - noiseMs)

    const spanMs = empty || newest === null || oldest === null ? 0 : newest.tMs - oldest.tMs
    const coverage = spanMs > 0 ? observedMs / spanMs : 0
    const trustworthy = observedMs >= WARMUP_MS && coverage >= MIN_COVERAGE

    const longBlinkCount = kept.filter((c) => !c.endedByFaceLoss && c.durationMs >= LONG_BLINK_MS).length

    const openClosureMs =
      closureStart !== null && newest !== null && newest.earFiltered !== null
        ? newest.tMs - closureStart
        : 0

    let drift: Degrees | null = null
    if (pitchBase !== null && foreshortenEma !== null && balanceEma !== null) {
      const raw = pitchDriftDeg({ foreshorten: foreshortenEma, balance: balanceEma }, pitchBase)
      drift = Math.abs(raw) < NOD_DEADBAND_DEG ? 0 : raw
    }

    return {
      perclos: trustworthy ? closedMs / observedMs : null,
      longBlinksPerMin: trustworthy ? longBlinkCount / (observedMs / 60_000) : null,
      longBlinkCount,
      openClosureMs,
      pitchDriftDeg: drift,
      earRaw: newest?.earRaw ?? null,
      earSmoothed: earEma,
      closureThreshold: threshold,
      faceLostMs: newest === null ? 0 : lastFaceMs === null ? spanMs : newest.tMs - lastFaceMs,
      observedMs,
      closedMs,
      spanMs,
      coverage,
      closures: kept,
      sampleCount: this.count,
      lastTimestampMs: newest?.tMs ?? null,
    }
  }

  trace(): TracePoint[] {
    const points: TracePoint[] = []
    for (let i = 0; i < this.count; i += 1) {
      const sample = this.at(i)
      if (sample === null) continue
      points.push({ tMs: sample.tMs, earRaw: sample.earFiltered })
    }
    return points
  }

  private filterRaw(earRaw: Ear | null): Ear | null {
    if (earRaw === null) {
      this.recentRaw = []
      return null
    }
    this.recentRaw.push(earRaw)
    if (this.recentRaw.length > 3) this.recentRaw.shift()
    const [first, second, third] = this.recentRaw
    if (first === undefined || second === undefined || third === undefined) return earRaw
    return median3(first, second, third)
  }

  private evictOlderThan(cutoffMs: Millis): void {
    while (this.count > 0) {
      const oldest = this.at(0)
      if (oldest === null || oldest.tMs >= cutoffMs) break
      this.start = (this.start + 1) % CAPACITY
      this.count -= 1
    }
  }

  private at(index: number): StoredSample | null {
    if (index < 0 || index >= this.count) return null
    return this.buffer[(this.start + index) % CAPACITY] ?? null
  }
}
