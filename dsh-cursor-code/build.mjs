/**
 * dsh-cursor-code — client bundle build.
 *
 * The DSH client module runtime loads each plugin as one self-contained classic
 * script: `window.__ModuleLoader__.load({ id, factory(require) { … } })`. The
 * factory may `require` only baseline table modules (`react`, `react-dom`,
 * `@deepseek-ai/cordis`, …); everything else must be inlined. Monaco is not in
 * that table, so this script bundles it in:
 *
 *   src/client.mjs ──esbuild(cjs, external react)──► factory body
 *   monaco editor.worker ──esbuild(iife, minified)──► embedded Blob worker
 *   monaco *.css + codicon.ttf ──esbuild(css, dataurl)──► injected <style>
 *
 * Output: client.js (the artifact the Loader serves and HMR rewrites on).
 *
 * Usage:  node build.mjs [--dev]
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const dev = process.argv.includes('--dev')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const id = pkg.name

const monacoDir = path.join(root, 'node_modules', 'monaco-editor', 'esm')
const workerEntry = path.join(monacoDir, 'vs', 'editor', 'editor.worker.js')

const define = { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') }
const loader = { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' }

// ---------------------------------------------------------------------------
// 1. Worker bundle: the editor's base worker, embedded as a Blob URL source.
// ---------------------------------------------------------------------------
const workerBuild = await build({
  entryPoints: [workerEntry],
  outfile: path.join(root, '.build', 'editor.worker.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !dev,
  write: false,
  define,
  loader,
  logLevel: 'warning',
})
const workerJs = workerBuild.outputFiles.find((f) => f.path.endsWith('.js'))
if (!workerJs) throw new Error('build: worker bundle produced no js output')
const workerCode = workerJs.text

// The lightweight JSON language service's worker, routed by label.
const jsonWorkerEntry = path.join(monacoDir, 'vs', 'languages', 'features', 'json', 'json.worker.js')
const jsonWorkerBuild = await build({
  entryPoints: [jsonWorkerEntry],
  outfile: path.join(root, '.build', 'json.worker.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !dev,
  write: false,
  define,
  loader,
  logLevel: 'warning',
})
const jsonWorkerJs = jsonWorkerBuild.outputFiles.find((f) => f.path.endsWith('.js'))
if (!jsonWorkerJs) throw new Error('build: json worker bundle produced no js output')
const jsonWorkerCode = jsonWorkerJs.text

// ---------------------------------------------------------------------------
// 2. Main bundle: the client half, CJS body for the factory. `react` stays a
//    factory `require`; monaco and everything else is inlined.
// ---------------------------------------------------------------------------
const mainBuild = await build({
  entryPoints: [path.join(root, 'src', 'client.mjs')],
  outfile: path.join(root, '.build', 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: ['react'],
  write: false,
  sourcemap: false,
  minify: !dev,
  define,
  loader,
  logLevel: 'warning',
})
const mainJs = mainBuild.outputFiles.find((f) => f.path.endsWith('.js'))
const mainCss = mainBuild.outputFiles.find((f) => f.path.endsWith('.css'))
if (!mainJs) throw new Error('build: main bundle produced no js output')

// ---------------------------------------------------------------------------
// 3. Wrap into the loader factory shape shipped bundles use.
// ---------------------------------------------------------------------------
const q = (value) => JSON.stringify(value)
const banner = `/**
 * dsh-cursor-code — generated client bundle. DO NOT EDIT.
 * Source: src/client.mjs (+ monaco-editor inline). Rebuild: node build.mjs
 */
window.__ModuleLoader__.load({
\tid: ${q(id)},
\tfactory(require) {
\t\t// ---- injected assets (build.mjs): theme css + monaco worker environment ----
\t\t(function () {
\t\t\tif (typeof document === 'undefined' || !document.head) return;
\t\t\tvar css = ${q(`${mainCss ? mainCss.text : ''}\n.cursor-code-flash{background:rgba(255,213,0,.35);border-radius:2px;}\n`)};
\t\t\tvar hasCss = typeof document.getElementById === 'function' && document.getElementById('dsh-cursor-code-style');
\t\t\tif (css && !hasCss && typeof document.createElement === 'function') {
\t\t\t\tvar style = document.createElement('style');
\t\t\t\tstyle.id = 'dsh-cursor-code-style';
\t\t\t\tstyle.textContent = css;
\t\t\t\tdocument.head.appendChild(style);
\t\t\t}
\t\t\tif (typeof self !== 'undefined' && !self.MonacoEnvironment
\t\t\t\t\t&& typeof Worker === 'function' && typeof URL !== 'undefined'
\t\t\t\t\t&& typeof URL.createObjectURL === 'function' && typeof Blob === 'function') {
\t\t\t\tvar editorWorkerCode = ${q(workerCode)};
\t\t\t\tvar jsonWorkerCode = ${q(jsonWorkerCode)};
\t\t\t\tvar editorWorkerUrl = URL.createObjectURL(new Blob([editorWorkerCode], { type: 'text/javascript' }));
\t\t\t\tvar jsonWorkerUrl = URL.createObjectURL(new Blob([jsonWorkerCode], { type: 'text/javascript' }));
\t\t\t\tself.MonacoEnvironment = {
\t\t\t\t\tgetWorker: function (_moduleId, label) {
\t\t\t\t\t\treturn new Worker(label === 'json' ? jsonWorkerUrl : editorWorkerUrl);
\t\t\t\t\t},
\t\t\t\t};
\t\t\t}
\t\t})();
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const footer = `
\t\treturn module.exports;
\t},
})
`

const out = banner + mainJs.text + footer
writeFileSync(path.join(root, 'client.js'), out)

const mb = (Buffer.byteLength(out) / 1024 / 1024).toFixed(2)
console.log(`build: client.js written (${mb} MiB; worker ${(workerCode.length / 1024).toFixed(0)} KiB; css ${((mainCss?.text.length ?? 0) / 1024).toFixed(0)} KiB)`)
