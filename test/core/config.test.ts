import { describe, expect, it } from 'vitest'
import {
  EAR_LANDMARKS,
  INFERENCE_FPS,
  MAX_SAMPLE_RATE_HZ,
  PROFILES,
  WARMUP_MS,
  configProblems,
} from '../../src/config'

describe('config invariants', () => {
  it('holds every relationship the arbiter depends on', () => {
    expect(configProblems()).toEqual([])
  })

  it('keeps every dismissal mute longer than the warm-up, or the app goes blind after a dismissal', () => {
    for (const tuning of Object.values(PROFILES)) {
      expect(tuning.dismissMuteMs).toBeGreaterThan(WARMUP_MS)
    }
  })

  it('uses six distinct landmarks per eye', () => {
    expect(EAR_LANDMARKS.left).toHaveLength(6)
    expect(EAR_LANDMARKS.right).toHaveLength(6)
    expect(new Set(EAR_LANDMARKS.left).size).toBe(6)
    expect(new Set(EAR_LANDMARKS.right).size).toBe(6)
    expect(new Set([...EAR_LANDMARKS.left, ...EAR_LANDMARKS.right]).size).toBe(12)
  })

  it('sizes the ring buffer above the inference rate', () => {
    expect(MAX_SAMPLE_RATE_HZ).toBeGreaterThanOrEqual(INFERENCE_FPS)
  })
})
