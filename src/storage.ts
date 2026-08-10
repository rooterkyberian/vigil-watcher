import { DEFAULT_PROFILE, STORAGE_KEY_CALIBRATION, STORAGE_KEY_PROFILE, isProfileId, type ProfileId } from './config'
import type { Calibration } from './core/types'

export function loadCalibration(): Calibration | null {
  const raw = read(STORAGE_KEY_CALIBRATION)
  if (raw === null) return null
  try {
    return validate(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveCalibration(calibration: Calibration): boolean {
  return write(STORAGE_KEY_CALIBRATION, JSON.stringify(calibration))
}

export function loadProfile(): ProfileId {
  const raw = read(STORAGE_KEY_PROFILE)
  return isProfileId(raw) ? raw : DEFAULT_PROFILE
}

export function saveProfile(profile: ProfileId): boolean {
  return write(STORAGE_KEY_PROFILE, profile)
}

export function clearCalibration(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY_CALIBRATION)
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function validate(value: unknown): Calibration | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['schemaVersion'] !== 1) return null

  const openEar = finite(record['openEar'])
  const closedEar = finite(record['closedEar'])
  const closurePoint = finite(record['closurePoint'])
  const capturedAtEpochMs = finite(record['capturedAtEpochMs'])
  const pitch = record['pitchBase']
  if (openEar === null || closedEar === null || closurePoint === null || capturedAtEpochMs === null) return null
  if (typeof pitch !== 'object' || pitch === null) return null

  const pitchRecord = pitch as Record<string, unknown>
  const foreshorten = finite(pitchRecord['foreshorten'])
  const balance = finite(pitchRecord['balance'])
  if (foreshorten === null || balance === null) return null
  if (!(openEar > closedEar)) return null

  return {
    schemaVersion: 1,
    openEar,
    closedEar,
    closurePoint,
    capturedAtEpochMs,
    pitchBase: { foreshorten, balance },
    profileLabel: typeof record['profileLabel'] === 'string' ? record['profileLabel'] : 'default',
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
