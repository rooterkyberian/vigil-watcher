import { TRACE_WINDOW_MS } from './config'
import type { AlertLevel, Ear, Millis, TracePoint } from './core/types'

const PANEL = '#141A2E'
const RULE = '#28325A'
const TRACE = '#6EE0FF'
const CAUTION = '#FFB020'
const ALARM = '#FF4D6D'
const DIM = '#8792B8'
const PAD = 8

const LEVEL_STROKE: Record<AlertLevel, string> = { ok: TRACE, caution: CAUTION, alarm: ALARM }

export function drawTrace(
  canvas: HTMLCanvasElement,
  points: readonly TracePoint[],
  threshold: Ear,
  nowMs: Millis,
  level: AlertLevel,
): void {
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  if (cssWidth <= 0 || cssHeight <= 0) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixelWidth = Math.round(cssWidth * dpr)
  const pixelHeight = Math.round(cssHeight * dpr)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = PANEL
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  const columns = Math.max(1, Math.floor(cssWidth))
  const startMs = nowMs - TRACE_WINDOW_MS
  const buckets = bucketMinima(points, startMs, columns)

  let peak = threshold * 2
  for (const value of buckets) if (value !== null && value > peak) peak = value
  const top = Math.max(peak * 1.12, 0.05)
  const plotHeight = cssHeight - PAD * 2
  const yOf = (value: number): number => cssHeight - PAD - (value / top) * plotHeight
  const xOf = (column: number): number => (column / columns) * cssWidth

  ctx.fillStyle = 'rgba(255, 77, 109, 0.20)'
  for (let column = 0; column < columns; column += 1) {
    const value = buckets[column]
    if (value !== null && value !== undefined && value < threshold) {
      ctx.fillRect(xOf(column), 0, cssWidth / columns + 0.6, cssHeight)
    }
  }

  ctx.fillStyle = 'rgba(135, 146, 184, 0.14)'
  for (let column = 0; column < columns; column += 1) {
    if (buckets[column] === null) ctx.fillRect(xOf(column), 0, cssWidth / columns + 0.6, cssHeight)
  }

  ctx.strokeStyle = RULE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, cssHeight - 0.5)
  ctx.lineTo(cssWidth, cssHeight - 0.5)
  ctx.stroke()

  ctx.strokeStyle = CAUTION
  ctx.lineWidth = 1
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  const thresholdY = Math.round(yOf(threshold)) + 0.5
  ctx.moveTo(0, thresholdY)
  ctx.lineTo(cssWidth, thresholdY)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.strokeStyle = LEVEL_STROKE[level]
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  ctx.beginPath()
  let drawing = false
  for (let column = 0; column < columns; column += 1) {
    const value = buckets[column]
    if (value === null || value === undefined) {
      drawing = false
      continue
    }
    const x = xOf(column)
    const y = yOf(value)
    if (drawing) ctx.lineTo(x, y)
    else {
      ctx.moveTo(x, y)
      drawing = true
    }
  }
  ctx.stroke()

  ctx.fillStyle = DIM
  ctx.fillRect(cssWidth - 1, 0, 1, cssHeight)
}

function bucketMinima(
  points: readonly TracePoint[],
  startMs: Millis,
  columns: number,
): Array<Ear | null> {
  const buckets: Array<Ear | null> = new Array<Ear | null>(columns).fill(null)
  for (const point of points) {
    if (point.earRaw === null) continue
    const offset = (point.tMs - startMs) / TRACE_WINDOW_MS
    if (offset < 0 || offset > 1) continue
    const column = Math.min(columns - 1, Math.floor(offset * columns))
    const existing = buckets[column]
    if (existing === null || existing === undefined || point.earRaw < existing) {
      buckets[column] = point.earRaw
    }
  }
  return buckets
}
