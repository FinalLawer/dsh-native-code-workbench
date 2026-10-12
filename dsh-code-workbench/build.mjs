/**
 * dsh-code-workbench — build.
 *
 * Two jobs, in one script:
 *
 *  1. **Transpile the Host half.** `index.ts`, `completion-api.mts` and the
 *     three `src/*.mts` modules the Host imports are emitted one-for-one as
 *     ESM, with no bundling: `index.js` is loaded by DSH at boot, and
 *     `update.json` ships each of those files separately. The import specifiers
 *     are written to survive verbatim, which is why the sources sit next to
 *     their outputs and name each other with the emitted extension
 *     (`./completion-api.mjs`).
 *
 *  2. **Bundle the client half.** The DSH client module runtime loads each
 *     plugin as one self-contained classic script:
 *     `window.__ModuleLoader__.load({ id, factory(require) { … } })`. The
 *     factory may `require` only baseline table modules (`react`, `react-dom`,
 *     `@deepseek-ai/cordis`, …); everything else must be inlined. Monaco is not
 *     in that table, so this script bundles it in:
 *
 *       src/client.ts ──esbuild(cjs, external react)──► factory body
 *       monaco editor.worker ──esbuild(iife, minified)──► embedded Blob worker
 *       monaco *.css + codicon.ttf ──esbuild(css, dataurl)──► injected <style>
 *
 *     Output: client.js (the artifact the Loader serves and HMR rewrites on).
 *
 * This file stays JavaScript on purpose. It is the tool that compiles the
 * TypeScript; writing it in TypeScript would make the build depend on a build
 * already having run, for no gain — nothing here is shipped to a browser or
 * loaded by DSH. Type checking is a separate gate: `npm run typecheck`.
 *
 * Usage:  node build.mjs [--dev]
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
// 0. Host half: transpile only, one output per source, specifiers preserved.
//
//    `tsc -p tsconfig.build.json`, not esbuild, and for one reason: esbuild
//    drops every comment, which took 136 documented blocks out of the installed
//    `index.js` — the file a person reads when they are debugging an installed
//    copy. `noEmitOnError` is on there, so a type error fails the build here
//    rather than landing in a shipped artifact.
//
//    The sources sit next to their outputs and are named `.mts` so that
//    `index.ts`'s `./completion-api.mjs` resolves to a real file, and so that
//    tsc emits `.mjs` rather than `.js`. That is also why `src/client.ts` — the
//    one input that is *bundled* rather than transpiled — is excluded there:
//    its own output is `client.js`, produced below.
// ---------------------------------------------------------------------------
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const hostBuild = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
})
if (hostBuild.error) throw hostBuild.error
if (hostBuild.status !== 0) throw new Error(`build: the Host half did not compile (tsc exit ${hostBuild.status})`)
console.log('build: host half transpiled (index.js, completion-api.mjs, src/*.mjs)')

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
  entryPoints: [path.join(root, 'src', 'client.ts')],
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
 * dsh-code-workbench — generated client bundle. DO NOT EDIT.
 * Source: src/client.ts (+ monaco-editor inline). Rebuild: node build.mjs
 */
window.__ModuleLoader__.load({
\tid: ${q(id)},
\tfactory(require) {
\t\t// ---- injected assets (build.mjs): theme css + monaco worker environment ----
\t\t(function () {
\t\t\tif (typeof document === 'undefined' || !document.head) return;
\t\t\tvar css = ${q(`${mainCss ? mainCss.text : ''}\n.code-workbench-flash{background:rgba(255,213,0,.35);border-radius:2px;}\n`)};
\t\t\tvar hasCss = typeof document.getElementById === 'function' && document.getElementById('dsh-code-workbench-style');
\t\t\tif (css && hasCss) hasCss.textContent = css;
\t\t\tif (css && !hasCss && typeof document.createElement === 'function') {
\t\t\t\tvar style = document.createElement('style');
\t\t\t\tstyle.id = 'dsh-code-workbench-style';
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
