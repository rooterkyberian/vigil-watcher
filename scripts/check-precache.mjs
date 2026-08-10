import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const swPath = resolve(dist, 'sw.js')

const PRECACHE_REQUIRED = [
  { label: 'face landmarker model', pattern: /face_landmarker[^"']*\.task/ },
  { label: 'tasks-vision wasm binary', pattern: /vision_wasm_internal[^"']*\.wasm/ },
  { label: 'app shell', pattern: /index\.html/ },
]

const FORBIDDEN_HOSTS = [
  { host: 'odml.pa.googleapis.com', why: 'MediaPipe analytics endpoint' },
  { host: 'google-analytics.com', why: 'analytics' },
  { host: 'googletagmanager.com', why: 'analytics' },
  { host: 'sentry.io', why: 'error reporting' },
  { host: 'doubleclick.net', why: 'advertising' },
]

const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.webmanifest'])

async function walk(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(full)))
    else if (SCANNED_EXTENSIONS.has(extname(entry.name))) found.push(full)
  }
  return found
}

let sw
try {
  sw = await readFile(swPath, 'utf8')
} catch {
  console.error(`audit: ${swPath} not found — did the PWA plugin run?`)
  process.exit(1)
}

const failures = []

for (const entry of PRECACHE_REQUIRED) {
  if (!entry.pattern.test(sw)) failures.push(`precache is missing ${entry.label} (${entry.pattern})`)
}

for (const file of await walk(dist)) {
  if (file.endsWith('.map')) continue
  const source = await readFile(file, 'utf8')
  for (const entry of FORBIDDEN_HOSTS) {
    if (source.includes(entry.host)) {
      failures.push(`${relative(root, file)} references ${entry.host} (${entry.why})`)
    }
  }
}

if (failures.length > 0) {
  console.error('audit FAILED — this build breaks a promise the README makes.')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('Precache gaps: see injectManifest options in vite.config.ts.')
  console.error('Forbidden hosts: see stripMediaPipeTelemetry in vite.config.ts.')
  process.exit(1)
}

const entries = sw.match(/"revision":/g)?.length ?? 0
console.log(`audit: ok — ${entries} precache entries, model and wasm present, no reporting endpoints`)
