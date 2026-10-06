import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrapper = path.join(root, 'validation/code-server/code-server-4.140.0-windows-amd64/lib/vscode/node_modules/@parcel/watcher/wrapper.js')
const original = '    for (const value of ignore) {'
const replacement = "    for (const rawValue of ignore) {\n      const normalized = process.platform === 'win32' ? rawValue.replace(/\\\\/g, '/') : rawValue;\n      const directory = normalized.endsWith('/**') ? normalized.slice(0, -3) : null;\n      const value = process.platform === 'win32' && directory !== null && !isGlob(directory) ? directory : normalized;"
const source = readFileSync(wrapper, 'utf8')
if (source.includes(replacement)) {
  console.log('Windows watcher path normalization already applied')
} else {
  if (!source.includes(original)) throw new Error('Unsupported watcher source; refusing to patch an unknown version')
  writeFileSync(wrapper, source.replace(original, replacement))
  console.log('Applied Windows watcher ignore-path normalization')
}
