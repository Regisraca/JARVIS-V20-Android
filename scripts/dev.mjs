import { spawn } from 'node:child_process'

const children = [
  spawn(process.execPath, ['server/dev.mjs'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web'], { stdio: 'inherit' }),
]

const shutdown = (code = 0) => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(code)
}

for (const child of children) child.on('exit', (code) => {
  if (code && code !== 143) shutdown(code)
})
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
