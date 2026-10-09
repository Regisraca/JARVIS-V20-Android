import { cpSync, existsSync } from 'node:fs'

// Hand tracking needs MediaPipe's wasm served from our own origin (see start.mjs).
const from = 'node_modules/@mediapipe/tasks-vision/wasm'
if (existsSync(from)) {
  try {
    cpSync(from, 'public/mediapipe', { recursive: true })
  } catch (err) {
    console.warn('could not vendor mediapipe:', err.message)
  }
}
