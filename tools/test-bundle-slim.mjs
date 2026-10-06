/**
 * Bundle-slimming test.
 *
 * The stock monaco entry drags in 81 grammars and the 12 MB TypeScript
 * language service. The slim entry (`src/monaco-entry.mjs`) keeps every editor
 * contribution and a curated grammar set; this pins what must stay, what must
 * be gone, and that the payload actually shrank.
 *
 *   node tools/test-bundle-slim.mjs
 */
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../dsh-cursor-code/client.js', import.meta.url), 'utf8')
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
check('multicursor ships', source.includes('multicursor') || source.includes('addCursor'))
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
