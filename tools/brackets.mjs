// Precise bracket tracker: skips comments, string literals, template literals
// (including interpolations), and regex-ish contexts, and prints the running
// depth so a missing closer is visible as a depth that never returns to zero.
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve(process.argv[2])
const from = Number(process.argv[3] ?? 1)
const to = Number(process.argv[4] ?? Number.MAX_SAFE_INTEGER)
const source = fs.readFileSync(file, 'utf8')

let line = 1
let i = 0
const stack = []
let state = 'code'
const templateStack = []

/** Handle one code-mode character. */
function code(c, next) {
  if (c === '/' && next === '/') { state = 'line'; return 1 }
  if (c === '/' && next === '*') { state = 'block'; return 1 }
  if (c === "'") { state = 'single'; return 0 }
  if (c === '"') { state = 'double'; return 0 }
  if (c === '`') { state = 'template'; return 0 }
  if ('([{'.includes(c)) { stack.push({ c, line }); return 0 }
  if (')]}'.includes(c)) {
    const want = c === ')' ? '(' : c === ']' ? '[' : '{'
    const top = stack[stack.length - 1]
    if (top === undefined) return -1 // stray closer
    if (top.c === want) stack.pop()
    else return -2 // mismatched
  }
  return 0
}

const failures = []
while (i < source.length) {
  const c = source[i]
  const next = source[i + 1]
  if (c === '\n') {
    line++
    if (state === 'line') state = 'code'
    i++
    if (line >= from && line <= to) {
      console.log(`${String(line).padStart(4)}  d=${String(stack.length).padStart(3)}  ${source.split('\n')[line - 1]?.trim().slice(0, 80) ?? ''}`)
    }
    continue
  }
  if (state === 'line') { i++; continue }
  if (state === 'block') {
    if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
    i++
    continue
  }
  if (state === 'single' || state === 'double') {
    const quote = state === 'single' ? "'" : '"'
    if (c === '\\') { i += 2; continue }
    if (c === quote) state = 'code'
    i++
    continue
  }
  if (state === 'template') {
    if (c === '\\') { i += 2; continue }
    if (c === '`') {
      const outer = templateStack.pop()
      state = outer === undefined ? 'code' : 'template'
      i++
      continue
    }
    if (c === '$' && next === '{') { templateStack.push('template'); state = 'code'; i += 2; continue }
    i++
    continue
  }
  if (state === 'code') {
    if (c === '}' && templateStack.length > 0) {
      // Closing an interpolation returns to the template.
      templateStack.pop()
      state = 'template'
      i++
      continue
    }
    const outcome = code(c, next)
    if (outcome < 0) failures.push({ line, kind: outcome === -1 ? 'stray closer' : 'mismatch', c })
    if (outcome === 1) { i += 2; continue }
    i++
    continue
  }
  i++
}

console.log('\n--- summary ---')
console.log(`final depth: ${stack.length}`)
for (const entry of stack.slice(-6)) console.log(`  still open: ${entry.c} from line ${entry.line}`)
for (const failure of failures.slice(0, 6)) console.log(`  ${failure.kind}: ${failure.c} at line ${failure.line}`)
