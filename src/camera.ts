import { CAMERA_CONSTRAINTS } from './config'

export type CameraErrorCode = 'insecure-context' | 'unsupported' | 'denied' | 'not-found' | 'in-use' | 'unknown'

export class CameraError extends Error {
  constructor(
    readonly code: CameraErrorCode,
    message: string,
    readonly hint: string,
  ) {
    super(message)
    this.name = 'CameraError'
  }
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraError(
      'insecure-context',
      'The camera needs a secure connection.',
      'Open this page over HTTPS, or on localhost during development. Chrome blocks the camera on plain http:// addresses such as http://192.168.x.x.',
    )
  }
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new CameraError(
      'unsupported',
      'This browser has no camera API.',
      'Use Chrome on Android, or a recent desktop Chrome.',
    )
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
  } catch (error) {
    throw translate(error)
  }

  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.muted = true
  await video.play()
  return stream
}

export function stopCamera(video: HTMLVideoElement, stream: MediaStream | null): void {
  if (stream !== null) for (const track of stream.getTracks()) track.stop()
  video.srcObject = null
}

function translate(error: unknown): CameraError {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError(
        'denied',
        'Camera blocked.',
        'Allow camera access in site settings, then start the session again.',
      )
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError(
        'not-found',
        'No front camera available.',
        'Connect or enable a front-facing camera, then start the session again.',
      )
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError(
        'in-use',
        'The camera is already in use.',
        'Close other apps or tabs using the camera, then start the session again.',
      )
    default:
      return new CameraError(
        'unknown',
        'The camera could not be started.',
        `Reload the page and try again. (${error instanceof Error ? error.message : String(error)})`,
      )
  }
}
