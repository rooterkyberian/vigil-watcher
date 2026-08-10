import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'
const MODEL_PATH = resolve(root, 'public/vendor/face_landmarker.task')

const WASM_SRC = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const WASM_DEST = resolve(root, 'public/vendor/tasks-vision/wasm')

const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']

const force = process.argv.includes('--force')

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function vendorModel() {
  if (!force && (await exists(MODEL_PATH))) {
    const actual = await sha256(MODEL_PATH)
    if (actual === MODEL_SHA256) {
      console.log('model: committed copy matches pinned digest, no download')
      return
    }
    console.warn(`model: digest mismatch (${actual}), re-downloading`)
  }

  console.log(`model: downloading ${MODEL_URL}`)
  const response = await fetch(MODEL_URL)
  if (!response.ok) throw new Error(`model download failed: ${response.status} ${response.statusText}`)

  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (MODEL_SHA256 && digest !== MODEL_SHA256) {
    throw new Error(`model digest mismatch: expected ${MODEL_SHA256}, got ${digest}`)
  }

  await mkdir(dirname(MODEL_PATH), { recursive: true })
  await writeFile(MODEL_PATH, bytes)
  console.log(`model: wrote ${(bytes.length / 1e6).toFixed(2)} MB, sha256 ${digest}`)
}

async function vendorWasm() {
  if (!(await exists(WASM_SRC))) {
    throw new Error(`missing ${WASM_SRC} — run npm install first`)
  }
  await mkdir(WASM_DEST, { recursive: true })

  let bytes = 0
  for (const file of WASM_FILES) {
    const source = resolve(WASM_SRC, file)
    if (!(await exists(source))) throw new Error(`missing ${source} — tasks-vision layout changed`)
    await cp(source, resolve(WASM_DEST, file))
    bytes += (await stat(source)).size
  }
  console.log(`wasm: copied ${WASM_FILES.length} SIMD runtime files (${(bytes / 1e6).toFixed(1)} MB)`)
}

await vendorWasm()
await vendorModel()
