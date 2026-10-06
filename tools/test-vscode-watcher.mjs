import assert from 'node:assert/strict'
import * as disk from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Run this validation on Windows')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireRuntime = createRequire(path.join(root, 'validation/code-server/code-server-4.140.0-windows-amd64/lib/vscode/package.json'))
const watcher = requireRuntime('@parcel/watcher')
const probe = await disk.mkdtemp(path.join(root, 'validation/code-server/watcher-test-'))
const ignored = path.join(probe, 'excluded')
const snapshot = path.join(probe, 'snapshot')
await disk.mkdir(ignored)
const options = { ignore: [ignored + '\\**'] }
try {
  await watcher.writeSnapshot(probe, snapshot, options)
  await disk.writeFile(path.join(probe, 'visible.txt'), 'visible')
  await disk.writeFile(path.join(ignored, 'hidden.txt'), 'hidden')
  const events = await watcher.getEventsSince(probe, snapshot, options)
  assert.ok(events.some((event) => event.path.endsWith('visible.txt')))
  assert.ok(!events.some((event) => event.path.endsWith('hidden.txt')), JSON.stringify(events))
} finally {
  await disk.rm(probe, { recursive: true, force: true })
}
console.log('Windows watcher path normalization and exclusions: ALL PASS')
