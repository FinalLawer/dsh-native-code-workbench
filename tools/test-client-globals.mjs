/**
 * The client bundle must reach the render smoke suite's Monaco seam through
 * `globalThis`, never as a bare identifier.
 *
 * `__CODE_WORKBENCH_TEST_MONACO__` exists only inside `test-client-smoke.mjs`,
 * which installs it on `globalThis` *before* it evaluates the bundle. That
 * ordering is why the smoke suite cannot catch this: the seam is always there
 * when it runs, so a bare reference resolves. In a real page nothing defines
 * the name, a bare reference is a `ReferenceError` rather than `undefined`, and
 * the tab body crashes — the shell logs
 *
 *   slot entry crashed in "sidebar.right.pane.tab":
 *   ReferenceError: __CODE_WORKBENCH_TEST_MONACO__ is not defined
 *
 * and the right panel renders blank. That shipped once, from a `declare var`
 * that made the bare form type-check while leaving it undefined at runtime.
 * This suite is the check the smoke suite structurally cannot make.
 *
 *   node tools/test-client-globals.mjs
 */
import fs from 'node:fs'

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const source = fs.readFileSync(new URL('../dsh-code-workbench/client.js', import.meta.url), 'utf8')

// Read the artifact, not the source: this is about what the browser executes.
check('the bundle is the client module the loader expects', source.includes('__ModuleLoader__.load'), {
  bytes: source.length,
})

const SEAM = '__CODE_WORKBENCH_TEST_MONACO__'
const total = source.split(SEAM).length - 1
const prefixed = source.split(`globalThis.${SEAM}`).length - 1
const bare = total - prefixed

check('the bundle still reads the test seam at all', prefixed > 0, { prefixed })
check('every reference to it goes through globalThis', bare === 0, { bare, total })

if (failures === 0) console.log('\nALL PASS')
else console.log(`\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
