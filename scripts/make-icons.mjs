import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public/icons')

const GROUND = [0x0b, 0x10, 0x20]
const TRACE = [0x6e, 0xe0, 0xff]
const PANEL = [0x14, 0x1a, 0x2e]

const SUPERSAMPLE = 3

function coverage(nx, ny, scale) {
  const outerA = 0.66 * scale
  const outerB = 0.38 * scale
  const innerA = 0.53 * scale
  const innerB = 0.25 * scale
  const pupil = 0.155 * scale

  const inOuter = (nx / outerA) ** 2 + (ny / outerB) ** 2 <= 1
  const inInner = (nx / innerA) ** 2 + (ny / innerB) ** 2 <= 1
  const inPupil = nx * nx + ny * ny <= pupil * pupil

  if (inPupil) return 'trace'
  if (inOuter && !inInner) return 'trace'
  if (inOuter) return 'panel'
  return 'ground'
}

function render(size, scale) {
  const pixels = Buffer.alloc(size * size * 4)
  const step = 1 / SUPERSAMPLE

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let trace = 0
      let panel = 0
      let ground = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const nx = ((x + (sx + 0.5) * step) / size) * 2 - 1
          const ny = ((y + (sy + 0.5) * step) / size) * 2 - 1
          const hit = coverage(nx, ny, scale)
          if (hit === 'trace') trace += 1
          else if (hit === 'panel') panel += 1
          else ground += 1
        }
      }

      const total = SUPERSAMPLE * SUPERSAMPLE
      const offset = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          (TRACE[channel] * trace + PANEL[channel] * panel + GROUND[channel] * ground) / total,
        )
      }
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

await mkdir(outDir, { recursive: true })

const targets = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  { name: 'maskable-512.png', size: 512, scale: 0.72 },
]

for (const target of targets) {
  const png = encodePng(target.size, render(target.size, target.scale))
  await writeFile(resolve(outDir, target.name), png)
  console.log(`icons: ${target.name} (${png.length} bytes)`)
}
