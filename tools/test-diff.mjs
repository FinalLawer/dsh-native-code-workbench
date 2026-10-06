/**
 * Unit test for the line diff and its collapse pass.
 *
 * The helpers live in `dsh-cursor-code/src/diff.mjs` — the exact module the
 * bundle build inlines — so the test imports them directly.
 *
 *   node tools/test-diff.mjs
 */
import { diffLines, collapseDiff, diffStat } from '../dsh-cursor-code/src/diff.mjs'

let failures = 0
/** Assert one expectation. */
function check (label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

/** Render one row as `[kind, text]`. */
const shape = (rows) => rows.map((row) => [row.kind, row.text])

console.log('identical input')
check('produces only context rows', shape(diffLines(['a', 'b'], ['a', 'b'])).every(([kind]) => kind === 'ctx'))
check('has no changes', diffStatsEqual(diffLines(['a'], ['a']), 0, 0))

/** Compare a diff's stat to expected counts. */
function diffStatsEqual (rows, added, removed) {
  const stat = diffStat(rows)
  return stat.added === added && stat.removed === removed
}

console.log('\nsingle line change')
const changed = diffLines(['a', 'b', 'c'], ['a', 'B', 'c'])
check('reports one add and one del', diffStatsEqual(changed, 1, 1), diffStat(changed))
check('keeps the untouched context', shape(changed).filter(([kind]) => kind === 'ctx').length === 2)
check('numbers added lines on the new side', changed.find((row) => row.kind === 'add')?.newNo === 2)
check('numbers deleted lines on the old side', changed.find((row) => row.kind === 'del')?.oldNo === 2)

console.log('\ninsertion only')
const inserted = diffLines(['a', 'c'], ['a', 'b', 'c'])
check('one add, no del', diffStatsEqual(inserted, 1, 0), diffStat(inserted))
check('no deletion rows', !inserted.some((row) => row.kind === 'del'))

console.log('\ndeletion only')
const deleted = diffLines(['a', 'b', 'c'], ['a', 'c'])
check('one del, no add', diffStatsEqual(deleted, 0, 1), diffStat(deleted))

console.log('\nempty sides')
check('empty to content is all adds', diffStatsEqual(diffLines([], ['a', 'b']), 2, 0))
check('content to empty is all dels', diffStatsEqual(diffLines(['a', 'b'], []), 0, 2))
check('empty to empty is empty', diffLines([], []).length === 0)

console.log('\nnumbering covers every line')
const big = diffLines('one\ntwo\nthree\nfour\nfive\nsix\n'.split('\n'), 'one\nTWO\nthree\nfour\nfive\nsix\n'.split('\n'))
const maxOld = Math.max(...big.filter((row) => row.oldNo !== undefined).map((row) => row.oldNo))
const maxNew = Math.max(...big.filter((row) => row.newNo !== undefined).map((row) => row.newNo))
check('old numbering reaches the last baseline line', maxOld === 7, maxOld)
check('new numbering reaches the last proposed line', maxNew === 7, maxNew)

console.log('\ncollapse')
const long = diffLines(
  Array.from({ length: 60 }, (_, index) => `line ${index}`),
  Array.from({ length: 60 }, (_, index) => (index === 30 ? 'changed' : `line ${index}`)),
)
const collapsed = collapseDiff(long, 3)
check('introduces a gap row', collapsed.some((row) => row.kind === 'gap'), collapsed.length)
check('shows the changed line', collapsed.some((row) => row.text === 'changed'))
check('keeps 3 context lines before the change', collapsed.filter((row) => row.kind === 'ctx').length === 6,
  collapsed.filter((row) => row.kind === 'ctx').length)
const gapCount = collapsed.filter((row) => row.kind === 'gap').reduce((sum, row) => sum + row.count, 0)
check('gap accounts for every hidden line', gapCount + collapsed.filter((row) => row.kind !== 'gap').length === long.length,
  { gapCount, shown: collapsed.filter((row) => row.kind !== 'gap').length, total: long.length })

console.log('\nlarge-input fallback')
const wide = diffLines(Array.from({ length: 2100 }, (_, i) => `a${i}`), Array.from({ length: 2100 }, (_, i) => `b${i}`))
check('falls back without hanging', wide.length === 4200, wide.length)
check('fallback reports every line', diffStatsEqual(wide, 2100, 2100))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
