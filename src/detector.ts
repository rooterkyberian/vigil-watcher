import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { EAR_LANDMARKS, PITCH_LANDMARKS } from './config'
import { averageEyeAspect, headPitchProxy, type EyePoints } from './core/ear'
import type { Ear, PitchProxy, Point2 } from './core/types'

const LOCAL_WASM = new URL('./vendor/tasks-vision/wasm', document.baseURI).href
const LOCAL_MODEL = new URL('./vendor/face_landmarker.task', document.baseURI).href
const REMOTE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

export type AssetSource = 'local' | 'remote'
export type Delegate = 'GPU' | 'CPU'

export interface Detection {
  earRaw: Ear | null
  pitch: PitchProxy | null
}

export interface Detector {
  readonly source: AssetSource
  readonly delegate: Delegate
  detect(video: HTMLVideoElement, timestampMs: number): Detection
  close(): void
}

export class DetectorLoadError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message)
    this.name = 'DetectorLoadError'
  }
}

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98,
  11,
])

export function hasWasmSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

export async function createDetector(confirmRemoteFetch: () => Promise<boolean>): Promise<Detector> {
  let localFailure: unknown = null
  const simd = hasWasmSimd()

  if (simd) {
    try {
      return await load(LOCAL_WASM, LOCAL_MODEL, 'local')
    } catch (error) {
      localFailure = error
    }
  } else {
    localFailure = new Error('this browser has no WebAssembly SIMD, and only the SIMD runtime is bundled')
  }

  const allowed = await confirmRemoteFetch()
  if (!allowed) {
    throw new DetectorLoadError(
      simd ? 'The face model is missing from this install.' : 'This browser needs the non-SIMD runtime.',
      simd
        ? `Vigil ships the model with the app so it never needs the network. Reinstall or reload the page. (${describe(localFailure)})`
        : 'Vigil bundles only the WebAssembly SIMD runtime, which every current Chrome has. Update your browser, or allow the one-off download to fetch the fallback runtime.',
    )
  }

  try {
    return await load(REMOTE_WASM, REMOTE_MODEL, 'remote')
  } catch (error) {
    throw new DetectorLoadError(
      'The face model could not be loaded locally or from the network.',
      `Check your connection and reload. (${describe(error)})`,
    )
  }
}

async function load(wasmPath: string, modelPath: string, source: AssetSource): Promise<Detector> {
  const fileset = await FilesetResolver.forVisionTasks(wasmPath)

  const attempt = async (delegate: Delegate): Promise<Detector> => {
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    })
    return {
      source,
      delegate,
      detect: (video, timestampMs) => measure(landmarker, video, timestampMs),
      close: () => landmarker.close(),
    }
  }

  try {
    return await attempt('GPU')
  } catch {
    return await attempt('CPU')
  }
}

function measure(landmarker: FaceLandmarker, video: HTMLVideoElement, timestampMs: number): Detection {
  const result = landmarker.detectForVideo(video, timestampMs)
  const face = result.faceLandmarks[0]
  if (face === undefined || face.length === 0) return { earRaw: null, pitch: null }

  const aspect = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 1
  const point = (index: number): Point2 | null => {
    const landmark = face[index]
    return landmark === undefined ? null : { x: landmark.x * aspect, y: landmark.y }
  }

  const left = eyePoints(point, EAR_LANDMARKS.left)
  const right = eyePoints(point, EAR_LANDMARKS.right)
  const earRaw = left !== null && right !== null ? averageEyeAspect(left, right) : null

  const forehead = point(PITCH_LANDMARKS.forehead)
  const chin = point(PITCH_LANDMARKS.chin)
  const eyeLeft = point(PITCH_LANDMARKS.eyeOuterLeft)
  const eyeRight = point(PITCH_LANDMARKS.eyeOuterRight)
  const pitch =
    forehead !== null && chin !== null && eyeLeft !== null && eyeRight !== null
      ? headPitchProxy(forehead, chin, eyeLeft, eyeRight)
      : null

  return { earRaw, pitch }
}

function eyePoints(point: (index: number) => Point2 | null, indices: readonly number[]): EyePoints | null {
  const resolved: Point2[] = []
  for (const index of indices) {
    const value = point(index)
    if (value === null) return null
    resolved.push(value)
  }
  const [p1, p2, p3, p4, p5, p6] = resolved
  if (p1 === undefined || p2 === undefined || p3 === undefined) return null
  if (p4 === undefined || p5 === undefined || p6 === undefined) return null
  return [p1, p2, p3, p4, p5, p6]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
