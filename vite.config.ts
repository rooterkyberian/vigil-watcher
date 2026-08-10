import type { Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

const TELEMETRY_URL = 'https://odml.pa.googleapis.com/v1/log'
const TELEMETRY_SINK = 'https://telemetry.disabled.invalid/'

/**
 * MediaPipe builds an analytics logger unconditionally and flushes queued events to Google
 * every 60 s; it is not opt-in. Vigil's whole claim is that nothing leaves the device, so the
 * endpoint is rewritten to a reserved .invalid host that can never resolve. The build fails if
 * the literal ever disappears, so a dependency bump cannot silently restore the reporting.
 */
function stripMediaPipeTelemetry(): Plugin {
  let rewrites = 0
  return {
    name: 'vigil:strip-mediapipe-telemetry',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@mediapipe/tasks-vision')) return null
      if (!code.includes(TELEMETRY_URL)) return null
      rewrites += 1
      return { code: code.split(TELEMETRY_URL).join(TELEMETRY_SINK), map: null }
    },
    closeBundle() {
      if (this.environment?.name === 'client' && rewrites === 0) {
        this.error(
          `expected to rewrite ${TELEMETRY_URL} in @mediapipe/tasks-vision but found no occurrence — ` +
            'check whether the dependency changed its telemetry endpoint before shipping',
        )
      }
    },
  }
}

export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    stripMediaPipeTelemetry(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      injectManifest: {
        globPatterns: ['**/*.{html,css,js,json,svg,png,ico,wasm,task,bin,data}'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
      manifest: {
        name: 'Vigil — drowsiness watcher',
        short_name: 'Vigil',
        description:
          'On-device drowsiness detection. Everything runs locally; nothing is transmitted. Assistive only, not a safety system.',
        start_url: './',
        scope: './',
        display: 'standalone',
        display_override: ['standalone'],
        orientation: 'portrait',
        background_color: '#0B1020',
        theme_color: '#0B1020',
        categories: ['health', 'utilities'],
        icons: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: './icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
