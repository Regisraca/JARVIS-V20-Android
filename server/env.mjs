import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function loadDotEnvFile(path) {
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) continue
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    const key = raw.slice(0, eq).trim()
    let value = raw.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

// Vercel injects environment variables itself. Locally we also load the usual
// files so `npm run dev` behaves like the deployment without shipping a secrets file.
loadDotEnvFile(join(process.cwd(), '.env'))
loadDotEnvFile(join(process.cwd(), '.env.local'))

export function envString(name, fallback = '') {
  const value = String(process.env[name] ?? '').trim()
  return value || fallback
}

export function listEnv(name, fallback = []) {
  const raw = envString(name)
  if (!raw) return [...fallback]
  return raw.split(',').map((x) => x.trim()).filter(Boolean)
}
