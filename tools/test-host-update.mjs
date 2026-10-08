/**
 * Host-half update test (`/api/code-workbench/update-check` + `/update-apply`).
 *
 * The pair exists so an installation can tell you a newer release is published
 * and then land it, instead of "uninstall it and type the URL again". Each half
 * of that claim is pinned here:
 *
 *  - the check reads the published tag rather than trusting it — tags arrive in
 *    no particular order, a release without a manifest has to fall through to
 *    the one below it, and a pre-release must not outrank its own release;
 *  - the check is a courtesy, not a report: an unreachable GitHub, an
 *    installation already at the newest version, and a newer version whose
 *    files are all identical all answer the same quiet "nothing to do", and a
 *    check never writes;
 *  - the apply verifies every file against the digest the release published
 *    *before* it lands, byte for byte, and touches nothing the request names —
 *    the request only ever says "now".
 *
 * The routes are driven against a throwaway copy of the package, because
 * `INSTALL_DIR` follows `import.meta.url`: the real installation is never a
 * test fixture, and every write in this file lands in a temporary directory.
 *
 *   node tools/test-host-update.mjs
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(HERE, '..', 'dsh-code-workbench')
const REPO = 'https://api.github.com/repos/FinalLawer/dsh-native-code-workbench'

let failures = 0
/** Assert one expectation. */
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

/**
 * SHA-256 of a text file as the release manifest computes it.
 *
 * Over LF-normalised bytes, for the reason `tools/make-update-manifest.py`
 * gives: git holds these files with LF, a Windows working tree hands them over
 * as CRLF, and one manifest has to describe all of them.
 */
function digestOf(text) {
  return createHash('sha256').update(text.replace(/\r\n/gu, '\n'), 'utf8').digest('hex')
}

/** The package manifest an installation is given, in the shape the updater reads. */
function packageManifest(version) {
  return `${JSON.stringify({ name: 'dsh-code-workbench', version, type: 'module', private: true }, null, 2)}\n`
}

/** Every temporary installation, removed before the summary. */
const temporaries = []

/**
 * A throwaway installation: the modules the Host half imports, a `package.json`
 * at the version under test, and whatever else a case needs on disk.
 * @param options - `{ version, files }`.
 * @returns readers over the directory, and a loader for its `index.js`.
 */
async function makeInstall(options) {
  const dir = await mkdtemp(join(tmpdir(), 'code-workbench-update-'))
  temporaries.push(dir)
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'vendor'), { recursive: true })
  for (const name of ['index.js', 'completion-api.mjs']) await cp(join(PACKAGE_DIR, name), join(dir, name))
  await cp(join(PACKAGE_DIR, 'src', 'completion-window.mjs'), join(dir, 'src', 'completion-window.mjs'))
  await cp(join(PACKAGE_DIR, 'vendor', 'schemastery.mjs'), join(dir, 'vendor', 'schemastery.mjs'))
  await writeFile(join(dir, 'package.json'), packageManifest(options.version))
  for (const [name, text] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  let generation = 0
  return {
    dir,
    read: (name) => readFile(join(dir, name), 'utf8'),
    exists: async (name) => {
      try { await readFile(join(dir, name)); return true } catch { return false }
    },
    /**
     * A fresh module instance, so each case starts with an empty update cache.
     *
     * Modules are cached by URL, so the same file has to be asked for by a
     * different name each time; the query is ignored by `fileURLToPath`, which
     * is how `INSTALL_DIR` is derived, so the copy under test is the same one.
     */
    load: () => import(`${pathToFileURL(join(dir, 'index.js')).href}?case=${generation++}`),
  }
}

/**
 * The stub scope; `logger.warn` is recorded so the silent paths can be checked
 * for having said something to the log rather than nothing at all.
 */
function makeScope(options = {}) {
  const calls = { routes: [], warnings: [] }
  const scope = {
    effect: (callback) => callback(),
    logger: { warn: (...args) => calls.warnings.push(args.join(' ')), info: () => {}, error: () => {} },
    connection: {
      admit: () => (options.denied === true ? { rejection: 403 } : { peer: {} }),
      fetch: {
        register(route) {
          calls.routes.push(route)
          return () => {}
        },
      },
    },
    sessions: { get: () => ({ header: { cwd: 'C:\\work\\repo' } }) },
    fs: {},
    tools: { register: () => () => {} },
    get: () => undefined,
  }
  return { scope, calls, route: (path) => calls.routes.find((r) => r.path === path) }
}

/** Apply the Host half to a stub scope and hand back its registered routes. */
function registered(module, options = {}) {
  const { scope, calls, route } = makeScope(options)
  module.apply({ inject: (names, callback) => callback(scope) })
  return { calls, route }
}

/** Build one JSON POST request. */
function makeRequest(body) {
  return new Request('http://127.0.0.1/api/code-workbench/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/**
 * Stand in for the GitHub REST surface the updater reads.
 *
 * Only the four reads the updater makes exist here: the tag list, a file in the
 * package at a tag (`update.json` included), and the blob API a file past the
 * contents API's inline limit is fetched from. A release marked unpublished
 * simply has no `update.json`, which is what every tag older than this feature
 * looks like from here.
 * @param options - `{ tags, releases }`; each release is
 * `{ tag, version, files: { name: { text, digest?, blob?, listedSize? } } }`.
 * @returns the two lookup tables the fake `fetch` answers from.
 */
function githubServer(options) {
  const table = {}
  const blobs = new Map()
  for (const release of options.releases) {
    const files = {}
    const digests = {}
    for (const [name, entry] of Object.entries(release.files)) {
      const bytes = Buffer.from(entry.text, 'utf8')
      digests[name] = entry.digest ?? digestOf(entry.text)
      files[name] = { bytes, blob: entry.blob === true, listedSize: entry.listedSize }
      blobs.set(`blob-${release.tag}-${name}`, bytes)
    }
    if (release.published !== false) {
      // The manifest never names itself, exactly as the release tooling writes it.
      const listed = release.oversized === true ? 300 * 1024 : undefined
      files['update.json'] = {
        bytes: Buffer.from(`${JSON.stringify({ version: release.version, files: digests }, null, 2)}\n`, 'utf8'),
        blob: false,
        listedSize: listed,
      }
    }
    table[release.tag] = { files }
  }
  /** Resolve one URL to `{ status?, body }`. */
  const answer = (url) => {
    if (url === `${REPO}/tags?per_page=100`) return { body: options.tags }
    const prefix = `${REPO}/contents/dsh-code-workbench/`
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length)
      const cut = rest.indexOf('?ref=')
      const name = rest.slice(0, cut)
      const tag = decodeURIComponent(rest.slice(cut + '?ref='.length))
      const file = table[tag]?.files[name]
      if (file === undefined) return { status: 404, body: { message: 'Not Found' } }
      const size = file.listedSize ?? file.bytes.length
      if (file.blob) return { body: { type: 'file', name, encoding: 'none', size, sha: `blob-${tag}-${name}` } }
      return { body: { type: 'file', name, encoding: 'base64', size, content: file.bytes.toString('base64') } }
    }
    const blobPrefix = `${REPO}/git/blobs/`
    if (url.startsWith(blobPrefix)) {
      const bytes = blobs.get(url.slice(blobPrefix.length))
      if (bytes === undefined) return { status: 404, body: { message: 'Not Found' } }
      return { body: { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length } }
    }
    return { status: 404, body: { message: 'Not Found' } }
  }
  return { answer }
}

/** Run `body` with the named (or unreachable) server answering `fetch`. */
async function withFetch(server, body) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const text = String(url)
    calls.push(text)
    if (server === null) throw new TypeError('fetch failed')
    const { status, body: data } = server.answer(text)
    return { ok: status === undefined, status: status ?? 200, json: async () => data }
  }
  try {
    return await body(calls)
  } finally {
    globalThis.fetch = previous
  }
}

/** Post one body to a route and read the JSON answer. */
async function post(route, body) {
  return (await route.fetch(makeRequest(body))).json()
}

console.log('a newer release is reported, naming the files that differ')
{
  const install = await makeInstall({ version: '0.4.3', files: { 'client.js': 'old bundle\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', files: { 'client.js': { text: 'new bundle\n' } } }],
  })
  const before = await install.read('client.js')
  const answer = await withFetch(server, () => post(route('/api/code-workbench/update-check')))
  check('the check answers ok', answer.ok === true, answer)
  check('it reports both versions', answer.current === '0.4.3' && answer.latest === '0.4.4', answer)
  check('it says there is an update, and names the file',
    answer.hasUpdate === true && answer.changed?.join() === 'client.js', answer)
  check('a bundle-only change needs no restart', answer.needsRestart === false, answer)
  check('and the check wrote nothing', (await install.read('client.js')) === before)
}

console.log('\nnothing to say when there is nothing to do')
{
  // One install, a fresh module per case: the release cache is deliberately
  // five minutes long, so a case that wants a different repository has to start
  // from a module that has never answered a check.
  const install = await makeInstall({ version: '0.4.4', files: { 'client.js': 'same\n' } })
  const check_ = (module) => registered(module).route('/api/code-workbench/update-check')

  const current = await withFetch(githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', files: { 'client.js': { text: 'same\n' } } }],
  }), async () => post(check_(await install.load())))
  check('an installation at the published version is up to date',
    current.ok === true && current.hasUpdate === false && current.latest === '0.4.4', current)

  const identical = await withFetch(githubServer({
    tags: [{ name: 'v0.4.5' }],
    releases: [{ tag: 'v0.4.5', version: '0.4.5', files: { 'client.js': { text: 'same\n' } } }],
  }), async () => post(check_(await install.load())))
  check('a newer version whose files are all identical is not an update',
    identical.ok === true && identical.hasUpdate === false && identical.latest === '0.4.5', identical)
  check('and it reports no changed files', identical.changed?.length === 0, identical.changed)

  const nothing = await withFetch(githubServer({
    tags: [{ name: 'v0.4.4' }, { name: 'v0.4.3' }],
    releases: [
      { tag: 'v0.4.4', version: '0.4.4', published: false, files: { 'client.js': { text: 'x\n' } } },
      { tag: 'v0.4.3', version: '0.4.3', published: false, files: { 'client.js': { text: 'x\n' } } },
    ],
  }), async () => post(check_(await install.load())))
  check('a repository where no tag carries a manifest is quiet, not an error',
    nothing.ok === true && nothing.hasUpdate === false && nothing.latest === null, nothing)
}

console.log('\nline endings are not a difference')
// Git holds every one of these files with LF, a Windows working tree with
// `core.autocrlf=true` hands them over as CRLF, and a tarball packed from that
// tree keeps that — one source, three byte streams. The manifest is written over
// normalised bytes for both reasons below: an installation from a locally packed
// tarball must not report every file as changed forever, and what an update
// lands must be the file the digest describes rather than the checkout's habit.
{
  const install = await makeInstall({
    version: '0.4.4',
    files: { 'client.js': 'line one\r\nline two\r\n' },
  })
  const module = await install.load()
  const { route } = registered(module)
  const answer = await withFetch(githubServer({
    tags: [{ name: 'v0.4.5' }],
    releases: [{ tag: 'v0.4.5', version: '0.4.5', files: { 'client.js': { text: 'line one\r\nline two\r\n' } } }],
  }), () => post(route('/api/code-workbench/update-check')))
  check('a checkout that stores CRLF is not reported as changed',
    answer.ok === true && answer.hasUpdate === false, answer)
}
{
  const install = await makeInstall({ version: '0.4.4', files: { 'client.js': 'old\r\nbundle\r\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    tags: [{ name: 'v0.4.5' }],
    releases: [{ tag: 'v0.4.5', version: '0.4.5', files: { 'client.js': { text: 'new\r\nbundle\r\n' } } }],
  })
  const answer = await withFetch(server, () => post(route('/api/code-workbench/update-apply')))
  check('the CRLF update is applied', answer.ok === true && answer.applied === true, answer)
  check('and it lands the line endings the manifest describes, not the checkout\'s',
    (await install.read('client.js')) === 'new\nbundle\n', JSON.stringify(await install.read('client.js')))
  const again = await withFetch(server, () => post(route('/api/code-workbench/update-check')))
  check('so the next check does not offer the same file again',
    again.hasUpdate === false, again)
}

console.log('\nan unreachable GitHub is a warning, not a failure')
{
  const install = await makeInstall({ version: '0.4.4', files: { 'client.js': 'same\n' } })
  const module = await install.load()
  const { route, calls } = registered(module)
  const response = await withFetch(null, async () => route('/api/code-workbench/update-check').fetch(makeRequest()))
  const answer = await response.json()
  check('the check still answers 200', response.status === 200, response.status)
  check('with a negative that says nothing about a release',
    answer.ok === false && answer.error?.code === 'UPDATE_UNAVAILABLE', answer)
  check('and the reason reached the host log',
    calls.warnings.some((line) => line.includes('update check skipped')), calls.warnings)
}

console.log('\nthe published tags are ordered here, not trusted')
{
  const install = await makeInstall({ version: '0.4.4', files: { 'client.js': 'old bundle\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    // Ascending, with an unparseable name and a tag that carries no manifest:
    // /tags promises no order, and the newest tag is not the first one listed.
    tags: [{ name: 'v0.4.6' }, { name: 'nightly' }, { name: 'v0.5.1' }, { name: 'v0.5.0' }, { name: 'v0.4.4-rc.9' }],
    releases: [
      { tag: 'v0.4.6', version: '0.4.6', files: { 'client.js': { text: 'new bundle\n' } } },
      { tag: 'v0.5.1', version: '0.5.1', published: false, files: { 'client.js': { text: 'new bundle\n' } } },
      { tag: 'v0.5.0', version: '0.5.0', files: { 'client.js': { text: 'new bundle\n' } } },
    ],
  })
  const answer = await withFetch(server, async (calls) => {
    const body = await post(route('/api/code-workbench/update-check'))
    return { body, calls }
  })
  check('the newest tag wins, not the first one listed', answer.body.latest === '0.5.0', answer.body)
  check('the newest tag is the one tried first',
    answer.calls[1]?.includes('ref=v0.5.1') && answer.calls[2]?.includes('ref=v0.5.0'),
    answer.calls.slice(0, 4))
  check('a tag with no manifest falls through instead of failing the check',
    answer.body.ok === true && answer.body.hasUpdate === true, answer.body)
}

console.log('\na pre-release does not outrank its own release')
{
  const install = await makeInstall({ version: '0.4.4', files: { 'client.js': 'old bundle\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const answer = await withFetch(githubServer({
    tags: [{ name: 'v0.4.4-rc.9' }],
    releases: [{ tag: 'v0.4.4-rc.9', version: '0.4.4-rc.9', files: { 'client.js': { text: 'new bundle\n' } } }],
  }), () => post(route('/api/code-workbench/update-check')))
  check('an rc of the installed version is not an update',
    answer.ok === true && answer.hasUpdate === false, answer)
}

console.log('\nthe request only ever says "now"')
{
  const install = await makeInstall({
    version: '0.4.3',
    files: { 'client.js': 'old bundle\n', 'src/workbench.css': 'old css\n' },
  })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{
      tag: 'v0.4.4',
      version: '0.4.4',
      // Both are read fresh on every use, so a release that only touches them
      // takes effect without a restart.
      files: {
        'client.js': { text: 'new bundle\n', blob: true },
        'package.json': { text: packageManifest('0.4.4') },
      },
    }],
  })
  let fetched = []
  const answer = await withFetch(server, (calls) => {
    fetched = calls
    return post(route('/api/code-workbench/update-apply'), {
      tag: 'v9.9.9',
      version: '99.0.0',
      files: { 'evil.js': '0'.repeat(64) },
    })
  })
  check('the update is applied', answer.ok === true && answer.applied === true, answer)
  check('at the version the release published, not the one the request named',
    answer.version === '0.4.4', answer)
  check('every changed file is named', answer.changed?.join() === 'client.js,package.json', answer.changed)
  check('a release that touches only live files needs no restart', answer.needsRestart === false, answer)
  check('nothing the request named was written', (await install.exists('evil.js')) === false)
  check('the bundle landed byte for byte', (await install.read('client.js')) === 'new bundle\n')
  check('the manifest beside it now reports the new version',
    JSON.parse(await install.read('package.json')).version === '0.4.4')
  check('the oversized bundle came from the blob API, not a second protocol',
    fetched.some((url) => url === `${REPO}/git/blobs/blob-v0.4.4-client.js`),
    fetched.filter((url) => url.includes('/git/blobs/')))
  check('no staging file was left behind',
    (await readdir(install.dir)).every((name) => !name.includes('.update-')),
    await readdir(install.dir))

  const again = await withFetch(server, () => post(route('/api/code-workbench/update-apply')))
  check('applying again finds nothing to do', again.ok === true && again.applied === false, again)
  check('and a check afterwards agrees',
    (await withFetch(server, () => post(route('/api/code-workbench/update-check')))).hasUpdate === false)
}

console.log('\na file that is only a build input needs no restart')
// `src/workbench.css` is bundled into `client.js` at build time and nothing reads
// it while the panel runs, so replacing it is no reason to ask anyone to restart
// DSH — which is what makes an ordinary release a hot update rather than a
// restart. `src/completion-window.mjs` looks just as much like a build input and
// is not: the Host imports it at boot, and that is the next block.
{
  const install = await makeInstall({ version: '0.4.3', files: { 'src/workbench.css': 'old css\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', files: { 'src/workbench.css': { text: 'new css\n' } } }],
  })
  const check_ = await withFetch(server, () => post(route('/api/code-workbench/update-check')))
  check('a build input is still reported as an update', check_.hasUpdate === true, check_)
  check('a file that is only a build input needs no restart', check_.needsRestart === false, check_)
  const answer = await withFetch(server, () => post(route('/api/code-workbench/update-apply')))
  const landed = await install.read('src/workbench.css')
  check('and it lands without one', answer.applied === true && landed === 'new css\n', { answer, landed })
}

console.log('\nreplacing a host-half file is reported as needing a restart')
{
  const install = await makeInstall({ version: '0.4.3', files: { 'client.js': 'old bundle\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{
      tag: 'v0.4.4',
      version: '0.4.4',
      files: {
        'client.js': { text: 'new bundle\n' },
        'src/completion-window.mjs': { text: 'export const COMPLETION_PREFIX_CHARS = 1\n' },
      },
    }],
  })
  const check_ = await withFetch(server, () => post(route('/api/code-workbench/update-check')))
  check('the check already says so', check_.needsRestart === true, check_)
  const answer = await withFetch(server, () => post(route('/api/code-workbench/update-apply')))
  check('and the apply repeats it rather than claiming the update took effect',
    answer.applied === true && answer.needsRestart === true, answer)
  check('a file in a subdirectory landed too',
    (await install.read('src/completion-window.mjs')) === 'export const COMPLETION_PREFIX_CHARS = 1\n')
}

console.log('\na file that does not match the published digest is refused')
{
  const install = await makeInstall({
    version: '0.4.3',
    files: { 'aaa.css': 'old css\n' },
  })
  const module = await install.load()
  const { route, calls } = registered(module)
  const hostIndex = await install.read('index.js')
  const server = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{
      tag: 'v0.4.4',
      version: '0.4.4',
      files: {
        // Sorts before index.js, so the failure comes after a file has landed:
        // the tree is left mixed, but every file in it is one a release published.
        'aaa.css': { text: 'new css\n' },
        'index.js': { text: 'not what the manifest describes\n', digest: '0'.repeat(64) },
      },
    }],
  })
  const answer = await withFetch(server, () => post(route('/api/code-workbench/update-apply')))
  check('the apply reports the mismatch', answer.ok === false && answer.error?.code === 'UPDATE_DIGEST', answer)
  check('the file that failed was not written', (await install.read('index.js')) === hostIndex)
  check('the file before it did land', (await install.read('aaa.css')) === 'new css\n')
  check('and the apply failure reached the host log',
    calls.warnings.some((line) => line.includes('update failed')), calls.warnings)
}

console.log('\na truncated download is refused rather than written short')
{
  const install = await makeInstall({ version: '0.4.3', files: { 'client.js': 'old bundle\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const server = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', files: { 'client.js': { text: 'new bundle\n', listedSize: 4096 } } }],
  })
  const answer = await withFetch(server, () => post(route('/api/code-workbench/update-apply')))
  check('the short read is reported', answer.ok === false && answer.error?.code === 'UPDATE_TRUNCATED', answer)
  check('and the installed file is untouched', (await install.read('client.js')) === 'old bundle\n')
}

console.log('\na manifest this half will not act on is refused')
{
  const install = await makeInstall({ version: '0.4.3', files: { 'client.js': 'old bundle\n' } })
  const module = await install.load()
  const { route } = registered(module)
  const apply = route('/api/code-workbench/update-apply')
  const check_ = route('/api/code-workbench/update-check')

  const escaping = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', files: { '../escape.js': { text: 'pwned\n' } } }],
  })
  const escape = await withFetch(escaping, () => post(apply))
  check('a path outside the package is refused',
    escape.ok === false && escape.error?.code === 'UPDATE_MANIFEST', escape)
  check('and nothing was written outside it', (await install.exists('../escape.js')) === false)
  const quiet = await withFetch(escaping, () => post(check_))
  check('the check treats it as nothing to say', quiet.ok === false, quiet)

  const malformed = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', files: { 'client.js': { text: 'new bundle\n', digest: 'not-a-digest' } } }],
  })
  const broken = await withFetch(malformed, () => post(apply))
  check('a digest that is not one is refused too',
    broken.ok === false && broken.error?.code === 'UPDATE_MANIFEST', broken)

  const oversized = githubServer({
    tags: [{ name: 'v0.4.4' }],
    releases: [{ tag: 'v0.4.4', version: '0.4.4', oversized: true, files: { 'client.js': { text: 'new bundle\n' } } }],
  })
  const huge = await withFetch(oversized, () => post(apply))
  check('and a manifest past the size cap',
    huge.ok === false && huge.error?.code === 'UPDATE_MANIFEST', huge)
}

console.log('\na request the Connection refuses is refused here too')
{
  const install = await makeInstall({ version: '0.4.4', files: { 'client.js': 'same\n' } })
  const module = await install.load()
  const { route } = registered(module, { denied: true })
  for (const path of ['/api/code-workbench/update-check', '/api/code-workbench/update-apply']) {
    const response = await route(path).fetch(makeRequest())
    check(`${path} answers 403`, response.status === 403, response.status)
  }
}

for (const dir of temporaries) await rm(dir, { recursive: true, force: true }).catch(() => {})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
