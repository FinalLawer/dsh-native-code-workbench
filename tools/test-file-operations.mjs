/**
 * File-operation route test (`POST /api/code-workbench/file-operation`).
 *
 * These are the operations the official filesystem service does not offer —
 * creating a directory, deleting, renaming, copying — so the guarantees the
 * official path would have given are owed here: containment inside the session
 * workspace, the session's sandbox mode, no silent overwrite, and no copy into
 * its own source. This runs against a real temporary directory, not a stub, so
 * the failure mapping is exercised against real errno.
 *
 *   node tools/test-file-operations.mjs
 */
import * as disk from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../dsh-code-workbench/index.js'

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const root = await disk.mkdtemp(path.join(os.tmpdir(), 'workbench-test-'))
const routes = []
let mode = 'workspace-write'
const scope = {
  effect: (callback) => callback(),
  connection: { admit: () => ({}), fetch: { register: (route) => { routes.push(route); return () => {} } } },
  tools: { register: () => () => {} },
  sessions: { get: (id) => (id === 'test' ? { header: { cwd: root } } : undefined) },
  get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } : undefined,
  fs: {
    resolve: async (filename) => ({ displayPath: path.resolve(filename), targetKey: path.resolve(filename) }),
    contains: (parent, child) => { const relative = path.relative(parent.displayPath, child.displayPath); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative) },
    writeText: async (target, text) => disk.writeFile(target.displayPath, text, { flag: 'wx' }),
  },
}
apply({ inject: (names, callback) => callback(scope) })
const route = routes.find((entry) => entry.path.endsWith('/file-operation'))

/** Run one operation and report the status and body. */
const call = async (payload) => {
  const response = await route.fetch(new Request('http://localhost/api/code-workbench/file-operation', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'test', ...payload }),
  }))
  return { status: response.status, body: await response.json() }
}
/** Run one operation and report only whether it succeeded. */
const operation = async (kind, source, destination) => (await call({ operation: kind, path: source, destination })).body.ok
/** Assert one failure carries the status and code the editor is told to expect. */
const refuses = async (label, payload, status, code) => {
  const result = await call(payload)
  check(label, result.status === status && result.body.ok === false && result.body.error?.code === code,
    { status: result.status, ...result.body })
  return result
}

try {
  const folder = path.join(root, 'folder')
  const original = path.join(folder, 'original.txt')
  const renamed = path.join(folder, 'renamed.txt')

  console.log('the operations work')
  check('a directory is created', (await operation('createDirectory', folder)) === true)
  check('a file is created inside it', (await operation('createFile', original)) === true)
  check('creating the same file again is refused', (await operation('createFile', original)) === false)
  check('a file is renamed', (await operation('rename', original, renamed)) === true)
  check('a file is copied to a new name', (await operation('copy', renamed, original)) === true)
  check('renaming onto an occupied name is refused', (await operation('rename', renamed, original)) === false)
  check('deleting the workspace root is refused', (await operation('delete', root)) === false)
  check('touching a path outside the workspace is refused', (await operation('createFile', path.join(root, '..', 'outside.txt'))) === false)
  mode = 'read-only'
  check('a read-only session may not delete', (await operation('delete', renamed)) === false)
  mode = 'workspace-write'
  check('the directory deletes recursively', (await operation('delete', folder)) === true)

  console.log('\nfailures name the reason, not just "400"')
  const box = path.join(root, 'box')
  check('creating a directory succeeds', (await operation('createDirectory', box)) === true)
  await refuses('an unknown operation is 400 BAD_REQUEST', { operation: 'move', path: box }, 400, 'BAD_REQUEST')
  await refuses('a missing session id is 400 BAD_REQUEST', { operation: 'delete', path: box, sessionId: '' }, 400, 'BAD_REQUEST')
  await refuses('an empty path is 400 BAD_REQUEST', { operation: 'delete', path: '' }, 400, 'BAD_REQUEST')
  await refuses('a rename without a destination is 400 BAD_REQUEST', { operation: 'rename', path: box, destination: '' }, 400, 'BAD_REQUEST')
  await refuses('an unknown session is 404 UNKNOWN_SESSION', { operation: 'delete', path: box, sessionId: 's' }, 404, 'UNKNOWN_SESSION')
  await refuses('creating over an existing name is 409 ALREADY_EXISTS', { operation: 'createDirectory', path: box }, 409, 'ALREADY_EXISTS')
  await refuses('deleting what is not there is 404 NOT_FOUND', { operation: 'delete', path: path.join(box, 'ghost') }, 404, 'NOT_FOUND')
  await refuses('renaming what is not there is 404 NOT_FOUND', { operation: 'rename', path: path.join(box, 'ghost'), destination: path.join(box, 'x') }, 404, 'NOT_FOUND')
  await refuses('deleting the root is 403 OUTSIDE_WORKSPACE', { operation: 'delete', path: root }, 403, 'OUTSIDE_WORKSPACE')
  await refuses('leaving the workspace is 403 OUTSIDE_WORKSPACE', { operation: 'createFile', path: path.join(root, '..', 'outside.txt') }, 403, 'OUTSIDE_WORKSPACE')
  // mkdir is deliberately not recursive, and the message says why in words a
  // person can read rather than the errno text.
  const missingParent = await refuses('a missing parent directory is 404 NOT_FOUND', { operation: 'createDirectory', path: path.join(box, 'missing', 'deep') }, 404, 'NOT_FOUND')
  check('the message is readable, not an errno', missingParent.body.error.message === '目标不存在（可能已被移动或删除）', missingParent.body.error.message)

  mode = 'read-only'
  await refuses('a read-only session is 403 READ_ONLY_SESSION', { operation: 'delete', path: box }, 403, 'READ_ONLY_SESSION')
  mode = 'workspace-write'

  console.log('\nnothing is overwritten and nothing escapes')
  const kept = path.join(box, 'kept.txt')
  const other = path.join(box, 'other.txt')
  check('a file is created', (await operation('createFile', kept)) === true)
  check('a second file is created', (await operation('createFile', other)) === true)
  // Both live inside `box`, so this is purely the "destination is occupied"
  // refusal and not the containment one below.
  await refuses('renaming onto an occupied name is 409 ALREADY_EXISTS', { operation: 'rename', path: other, destination: kept }, 409, 'ALREADY_EXISTS')
  const nest = path.join(box, 'nest')
  check('a directory is created', (await operation('createDirectory', nest)) === true)
  await refuses('moving a directory into itself is 403 OUTSIDE_WORKSPACE', { operation: 'copy', path: box, destination: path.join(box, 'inner') }, 403, 'OUTSIDE_WORKSPACE')
  check('the source survived every refusal', (await disk.readdir(box)).includes('kept.txt') && (await disk.readdir(box)).includes('other.txt'))
  check('a directory copies recursively', (await operation('copy', box, path.join(root, 'box-copy'))) === true)
  check('the copy holds the nested tree', (await disk.readdir(path.join(root, 'box-copy', 'nest'))).length === 0)
} finally {
  await disk.rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nFile operations: ALL PASS' : `\nFile operations: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
