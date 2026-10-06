import assert from 'node:assert/strict'
import * as disk from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../dsh-cursor-code/index.js'

const root = await disk.mkdtemp(path.join(os.tmpdir(), 'workbench-test-'))
const routes = []
let mode = 'workspace-write'
const scope = {
  effect: (callback) => callback(),
  connection: { admit: () => ({}), fetch: { register: (route) => { routes.push(route); return () => {} } } },
  tools: { register: () => () => {} },
  sessions: { get: () => ({ header: { cwd: root } }) },
  get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } : undefined,
  fs: {
    resolve: async (filename) => ({ displayPath: path.resolve(filename), targetKey: path.resolve(filename) }),
    contains: (parent, child) => { const relative = path.relative(parent.displayPath, child.displayPath); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative) },
    writeText: async (target, text) => disk.writeFile(target.displayPath, text, { flag: 'wx' }),
  },
}
apply({ inject: (names, callback) => callback(scope) })
const route = routes.find((entry) => entry.path.endsWith('/file-operation'))
const operation = async (kind, source, destination) => (await route.fetch(new Request('http://localhost/api/cursor-code/file-operation', { method: 'POST', body: JSON.stringify({ sessionId: 'test', operation: kind, path: source, destination }) }))).json()
try {
  const folder = path.join(root, 'folder')
  const original = path.join(folder, 'original.txt')
  const renamed = path.join(folder, 'renamed.txt')
  assert.equal((await operation('createDirectory', folder)).ok, true)
  assert.equal((await operation('createFile', original)).ok, true)
  assert.equal((await operation('createFile', original)).ok, false)
  assert.equal((await operation('rename', original, renamed)).ok, true)
  assert.equal((await operation('copy', renamed, original)).ok, true)
  assert.equal((await operation('rename', renamed, original)).ok, false)
  assert.equal((await operation('delete', root)).ok, false)
  assert.equal((await operation('createFile', path.join(root, '..', 'outside.txt'))).ok, false)
  mode = 'read-only'
  assert.equal((await operation('delete', renamed)).ok, false)
  mode = 'workspace-write'
  assert.equal((await operation('delete', folder)).ok, true)
} finally { await disk.rm(root, { recursive: true, force: true }) }
console.log('File operations: ALL PASS')
