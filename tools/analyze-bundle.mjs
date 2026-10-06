/**
 * Bundle size breakdown: which inputs dominate the client bundle.
 *
 *   node tools/analyze-bundle.mjs
 */
import esbuild from '../dsh-cursor-code/node_modules/esbuild/lib/main.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const { build } = esbuild

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dsh-cursor-code')

const result = await build({
  entryPoints: [path.join(root, 'src', 'monaco-entry.mjs')],
  outfile: path.join(root, '.build', 'analyze.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  write: false,
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.css': 'css' },
})

const out = Object.values(result.metafile.outputs)[0]
const rows = Object.entries(out.inputs)
  .map(([file, info]) => [file.replace(/.*node_modules\/monaco-editor\/esm\//, ''), info.bytesInOutput])
  .sort((a, b) => b[1] - a[1])
const total = rows.reduce((sum, [, bytes]) => sum + bytes, 0)
console.log(`total: ${(total / 1024 / 1024).toFixed(2)} MiB`)
for (const [file, bytes] of rows.slice(0, 35)) {
  console.log(`${String(Math.round(bytes / 1024)).padStart(7)} KB  ${file}`)
}
