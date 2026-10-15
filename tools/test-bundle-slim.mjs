/**
 * Bundle-slimming test.
 *
 * The stock monaco entry drags in 81 grammars and the 12 MB TypeScript
 * language service. The slim entry (`src/monaco-entry.mjs`) keeps every editor
 * contribution and a curated grammar set; this pins what must stay, what must
 * be gone, that the payload actually shrank, and that the one baseline UI
 * library the tree renders with is required from the shell rather than bundled
 * in.
 *
 *   node tools/test-bundle-slim.mjs
 */
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../dsh-code-workbench/client.js', import.meta.url), 'utf8')
const bytes = Buffer.byteLength(source)

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

console.log('payload size')
check(`bundle stays under 5.5 MiB (now ${(bytes / 1024 / 1024).toFixed(2)} MiB, was 10.36)`, bytes < 5.5 * 1024 * 1024, bytes)

console.log('\nwhat must stay')
check('find widget ships', source.includes('findWidget'))
check('suggest widget ships', source.includes('suggestWidget'))
check('inline completions ship (Tab ghost text)', source.includes('inlineCompletions'))
check('multi-selection support ships', source.includes('multicursor') || source.includes('addCursor'))
check('json tokenization ships', source.includes('delimiter.bracket.json'))
check('worker routing serves the json worker by label', source.includes("label === 'json'"))
// Grammar markers: language alias strings survive minification (identifiers do not).
for (const [grammar, marker] of [
  ['typescript', 'TypeScript'],
  ['javascript', 'JavaScript'],
  ['python', 'Python'],
  ['powershell', 'PowerShell'],
  ['dockerfile', 'Dockerfile'],
  ['markdown', 'Markdown'],
  ['yaml', 'YAML'],
]) {
  check(`grammar "${grammar}" ships`, source.includes(marker), marker)
}

console.log('\nwhat must be gone')
check('the TypeScript language service is dropped', !source.includes('tsMode_exports'), 'tsMode found')
check('exotic grammars are dropped', !source.includes('ABAP') && !source.includes('Q#'), 'exotic grammar found')

// The tree's file glyphs are the platform's, and they must stay the platform's.
//
// `@deepseek-ai/dsh-client-ui-primitives` is a baseline module the shell seeds
// into its frozen module table; the bundle is supposed to `require` it. The
// tempting alternative — pulling the package in as a real dependency so esbuild
// bundles it — also "works", and is worse in three ways at once: the bundle
// gains a few hundred components' worth of bytes, the icons stop tracking the
// product, and the copy silently ages. So the require is pinned by name, and the
// artwork is pinned as absent: `data-file-type-mark` is the attribute the
// package's own glyphs carry, and `M8.48924 28H19.5108` is the opening of its
// file-body path. Either one appearing here means it was inlined.
console.log('\nthe baseline modules are required, not inlined')
const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
check('the factory requires the baseline UI library by name',
  requires.includes('@deepseek-ai/dsh-client-ui-primitives'), requires)
check('the factory requires react by name', requires.includes('react'), requires)
check('the factory requires nothing else',
  requires.length === 2 && new Set(requires).size === 2, requires)
check('no file-type artwork was inlined',
  !source.includes('data-file-type-mark') && !source.includes('M8.48924 28H19.5108'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
