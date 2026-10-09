/**
 * dsh-code-workbench — Host half.
 *
 * Two mutation paths, both narrow: `POST /api/code-workbench/write`, a
 * version-guarded write inside the Session's workspace — and
 * `POST /api/code-workbench/update-apply`, which lands a published release over
 * this package's own directory and touches nothing else. Everything else the
 * panel does is read-only through the shipped `ctx.remote.workspaceFiles`.
 *
 * Every mechanism here is the shipped one:
 *  - routing + authentication → `ctx.connection.fetch.register` — the same seam
 *    `/api/file` (`dsh-api-session-controller`) and the session-log export use;
 *    the Connection service supplies the Host/Origin fence and the signed
 *    browser cookie, and this handler re-checks admission defensively.
 *  - the write itself → `ctx.fs.writeText(target, text, intent)` with a
 *    `{ kind: 'replaceIfVersion', version }` intent, so a concurrent change on
 *    disk fails with `FS_STALE_VERSION` instead of silently clobbering it.
 *  - the workspace root → the Session header (`sessions.get(id).header.cwd`),
 *    the same scope derivation `dsh-api-workspace-files` uses; writes are
 *    confined to that root with `fs.contains`.
 *  - traceability → each accepted write records a Session remark through
 *    `sessionFeedback.record`, so the edit is visible in the session record
 *    even though a human (not the agent) performed it.
 *
 * @module dsh-code-workbench
 */

// Vendored: @deepseek-ai/schemastery 3.18.4 (+ @deepseek-ai/cosmokit), both MIT.
// Bundled by esbuild so the installed package has zero runtime dependencies —
// no registry fetch can fail behind a restrictive network.
import z from './vendor/schemastery.mjs'
import * as disk from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fimEndpoint, completeFim } from './completion-api.mjs'
import { COMPLETION_PREFIX_CHARS, COMPLETION_SUFFIX_CHARS } from './src/completion-window.mjs'

/** The endpoint DeepSeek documents for fill-in-the-middle completion. */
const DEFAULT_COMPLETION_BASE_URL = 'https://api.deepseek.com/beta'
/** One of the two models that endpoint accepts. */
const DEFAULT_COMPLETION_MODEL = 'deepseek-flash'

export const Config = z.object({
  autoSave: z.boolean().default(false).volatile(),
  completionEnabled: z.boolean().default(true).volatile(),
  completionBaseUrl: z.string().default(DEFAULT_COMPLETION_BASE_URL).volatile(),
  completionApiKey: z.string().default('').role('secret').volatile(),
  completionApiModel: z.string().default(DEFAULT_COMPLETION_MODEL).volatile(),
})

/** Refuse absurd payloads early; the editor sends ordinary source files. */
const MAX_TEXT_CHARS = 8 * 1024 * 1024
/** Route this half owns. The client half posts to the exact same string. */
const WRITE_PATH = '/api/code-workbench/write'
/** The codebase search route (@codebase retrieval). */
const SEARCH_PATH = '/api/code-workbench/search'
/** The save journal (save checkpoints): list and roll back saves. */
const HISTORY_PATH = '/api/code-workbench/history'
const ROLLBACK_PATH = '/api/code-workbench/rollback'
/** The route answering whether a newer release of this package is published. */
const UPDATE_CHECK_PATH = '/api/code-workbench/update-check'
/** The route that installs the published release over this installation. */
const UPDATE_APPLY_PATH = '/api/code-workbench/update-apply'
/** The route answering this installation's own version and repository (the About panel). */
const ABOUT_PATH = '/api/code-workbench/about'
/**
 * Journal caps: entries retained per file, bytes retained per side, and the
 * bounds on the journal as a whole.
 *
 * The whole-journal bounds are not decoration: a session that edits thousands
 * of files would otherwise keep every one of them — 20 entries of up to 200k
 * characters each, per file — for the life of the Host, since nothing here
 * expires on its own.
 */
const JOURNAL_CAPS = { perFile: 20, sideChars: 200_000, files: 64, chars: 4_000_000 }
/** Characters currently retained across the whole journal. */
let journalChars = 0
/** In-memory save journal: every accepted write keeps its before/after for rollback. */
const journal = new Map() // `${sessionId}\0${path}` -> entries, newest first

/** The characters one journal entry retains. */
function journalEntryChars(entry) {
  return entry.before === null ? 0 : entry.before.length
}

/**
 * Drop the oldest entry of the least recently written file. The map iterates in
 * write order, so its first key is the coldest file, and re-inserting a key on
 * every write is what keeps that ordering meaningful.
 * @returns whether an entry was dropped.
 */
function journalDropColdest() {
  const coldest = journal.keys().next().value
  if (coldest === undefined) return false
  const entries = journal.get(coldest)
  journalChars -= journalEntryChars(entries.pop())
  if (entries.length === 0) journal.delete(coldest)
  return true
}

/** Record one accepted write in the journal. */
function journalWrite(sessionId, path, note, outcome, text) {
  const key = `${sessionId}\u0000${path}`
  // Re-insert rather than update in place: this moves the key to the end, which
  // is what marks the file as most recently written for the eviction above.
  const existing = journal.get(key)
  if (existing !== undefined) journal.delete(key)
  const entries = existing ?? []
  const before = outcome.before === null || outcome.before === undefined
    ? null
    : String(outcome.before).slice(0, JOURNAL_CAPS.sideChars)
  const entry = {
    id: `${Date.now()}-${entries.length}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    operation: outcome.operation,
    note: typeof note === 'string' ? note.slice(0, 300) : '',
    version: outcome.version,
    before,
    beforeTruncated: before !== null && String(outcome.before).length > JOURNAL_CAPS.sideChars,
    lines: text.split('\n').length,
  }
  entries.unshift(entry)
  journalChars += journalEntryChars(entry)
  while (entries.length > JOURNAL_CAPS.perFile) journalChars -= journalEntryChars(entries.pop())
  journal.set(key, entries)
  while (journal.size > JOURNAL_CAPS.files) if (!journalDropColdest()) break
  while (journalChars > JOURNAL_CAPS.chars) if (!journalDropColdest()) break
}
/** The Tab-completion route: short ghost-text continuations at the caret. */
const COMPLETE_PATH = '/api/code-workbench/complete'
/** The read-only route reporting which credential the completion route would use. */
const COMPLETION_STATUS_PATH = '/api/code-workbench/completion-status'
/** Caps on one completion request. The window is shared with the client half. */
const COMPLETE_CAPS = { prefix: COMPLETION_PREFIX_CHARS, suffix: COMPLETION_SUFFIX_CHARS, maxTokens: 128 }

/**
 * The credential-store reference holding a DeepSeek platform key.
 *
 * `credentialRef` from `@deepseek-ai/dsh-credentials` is an identity function at
 * runtime — it validates the name and returns the same string — so passing the
 * literal keeps this package free of a runtime dependency on that package.
 */
const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'
/** Caps keeping one search bounded on a pathological tree. */
const SEARCH_CAPS = {
  files: 4000,
  depth: 12,
  fileBytes: 1_000_000,
  matches: 300,
  lineChars: 4000,
  budgetMs: 4000,
  queryChars: 500,
}

/** Directory names never worth walking into. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.output',
  'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.turbo', '.pnpm-store',
])

/** File extensions that are never text source. */
const IGNORED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.node',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.mov', '.avi',
  '.class', '.jar', '.pyc', '.pyo', '.obj', '.o', '.a', '.lib', '.wasm',
  '.db', '.sqlite', '.lock',
])

/** JSON response helper. */
function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** An error this layer answers with a chosen status and code rather than a default. */
function requestFailure(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** Status for every failure the official service can raise. Anything else is a 500. */
const FILE_FAILURE_STATUS = {
  FS_STALE_VERSION: 409,
  FS_NOT_OBSERVED: 409,
  FS_AMBIGUOUS_EDIT: 409,
  FS_EDIT_NOT_FOUND: 404,
  FS_NOT_FOUND: 404,
  FS_SANDBOX_DENIED: 403,
  FS_PERMISSION_DENIED: 403,
  FS_TOO_LARGE: 413,
  FS_NOT_TEXT: 413,
  FS_NOT_REGULAR_FILE: 400,
  FS_NOT_DIRECTORY: 400,
  FS_ABORTED: 408,
  FS_IO_ERROR: 500,
}

/**
 * The answer for each POSIX failure the name-level operations can raise.
 *
 * These errno come from `node:fs/promises` — see {@link handleFileOperation} —
 * and are translated rather than passed through, so this route speaks one
 * vocabulary: a destination that exists is `ALREADY_EXISTS` whether the check
 * refused it or `mkdir` raised `EEXIST`. A raw `ENOENT` beside the route's own
 * codes would leave the editor matching two spellings of the same event, and
 * the native text — `ENOENT: no such file or directory, rm 'C:/…'` — is not
 * something to show a person.
 */
const NODE_FAILURE = {
  ENOENT: { status: 404, code: 'NOT_FOUND', message: '目标不存在（可能已被移动或删除）' },
  EEXIST: { status: 409, code: 'ALREADY_EXISTS', message: '目标已存在，禁止覆盖' },
  ENOTEMPTY: { status: 409, code: 'NOT_EMPTY', message: '目录非空，无法删除' },
  EACCES: { status: 403, code: 'PERMISSION_DENIED', message: '没有权限修改这个路径' },
  EPERM: { status: 403, code: 'PERMISSION_DENIED', message: '没有权限修改这个路径' },
  EROFS: { status: 403, code: 'READ_ONLY_DISK', message: '所在磁盘是只读的' },
  ENOTDIR: { status: 400, code: 'BAD_REQUEST', message: '路径中有一级不是目录' },
  EISDIR: { status: 400, code: 'BAD_REQUEST', message: '这是一个目录，不能当作文件处理' },
  EINVAL: { status: 400, code: 'BAD_REQUEST', message: '路径不合法' },
  ENAMETOOLONG: { status: 400, code: 'BAD_REQUEST', message: '路径过长' },
  ENOSPC: { status: 507, code: 'NO_SPACE', message: '磁盘空间不足' },
}

/**
 * Read one failure into the status, code and message to answer with.
 *
 * Three sources arrive here and they must not produce three different answers
 * for the same event: this layer's own refusals (which carry `status`
 * already), the official service's typed `FS_*` codes, and POSIX errno. Before
 * this existed each route mapped its own subset, so a missing file was a 404 on
 * one route and a 500 on another.
 * @param error - the thrown error, optionally carrying `status` and `code`.
 * @returns the status, code and message to answer with.
 */
function fileFailure(error) {
  if (typeof error?.status === 'number') {
    return { status: error.status, code: error.code ?? 'BAD_REQUEST', message: error.message }
  }
  const code = typeof error?.code === 'string' ? error.code : 'IO_ERROR'
  return NODE_FAILURE[code] ?? {
    status: FILE_FAILURE_STATUS[code] ?? 500,
    code,
    message: error?.message ?? String(error),
  }
}

/**
 * Handle one write request.
 * @param scope - injected Host services (`connection`, `fs`, `sessions`).
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleWrite(scope, request) {
  // Defense in depth: the shared /api channel already admitted the request, but
  // a mutation endpoint re-checks rather than assumes.
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path, text, expectedVersion } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof text !== 'string') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'text is required' } })
  if (text.length > MAX_TEXT_CHARS) return json(413, { ok: false, error: { code: 'TOO_LARGE', message: `text exceeds ${MAX_TEXT_CHARS} chars` } })

  // Scope: the Session's workspace root, exactly as workspace-files derives it.
  const session = scope.sessions.get(sessionId)
  const header = session?.header
  const workspaceRoot = header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return json(404, { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'session has no workspace root' } })
  }

  try {
    const rootTarget = await scope.fs.resolve(workspaceRoot)
    const target = await scope.fs.resolve(path, { cwd: workspaceRoot })
    if (!scope.fs.contains(rootTarget, target)) {
      return json(403, { ok: false, error: { code: 'OUTSIDE_WORKSPACE', message: 'path is outside the session workspace' } })
    }

    // Version guard. The editor hands back the version its read observed; a
    // write with no observed version is guarded against whatever is on disk now
    // (or created when the file is absent).
    let intent
    if (expectedVersion !== undefined && expectedVersion !== null) {
      intent = { kind: 'replaceIfVersion', version: expectedVersion }
    } else {
      const info = await scope.fs.stat(target)
      intent = info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }
    }

    // The sandbox fence. `dsh-tool-fs` stamps every mutation with the session's
    // standing policy (`sandboxPolicy.resolve({ session })` — mode plus the
    // session cwd as workspace root); without it `ctx.fs.writeText` falls back
    // to the deployment policy and denies with FS_SANDBOX_DENIED.
    const sandboxPolicy = scope.get('sandboxPolicy')?.resolve({ session })

    const outcome = await scope.fs.writeText(target, text, intent, undefined, sandboxPolicy)

    // Traceability: the session record shows the edit even though the agent did
    // not perform it. Fire-and-forget; a remark failure must not fail the save.
    const note = typeof body?.note === 'string' && body.note !== '' ? body.note.slice(0, 300) : ''
    journalWrite(sessionId, path, note, outcome, text)
    try {
      scope.get('sessionFeedback')?.record({
        sessionId,
        text: `[code-workbench] 手动保存 ${path}（${outcome.operation}，${text.split('\n').length} 行）${note === '' ? '' : ` — ${note}`}`,
      })
    } catch { /* remark is best-effort */ }

    return json(200, { ok: true, version: outcome.version, operation: outcome.operation })
  } catch (error) {
    const failure = fileFailure(error)
    return json(failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
  }
}

/**
 * Record one skipped or failed completion in the Host log, never in the editor.
 *
 * This is the only place a skipped completion is ever explained: the route
 * answers the editor with an empty success on purpose, so nothing in the GUI
 * says why Tab did nothing. The context fields are what make the line worth
 * having. They separate the ordinary causes — no credential, provider refusing —
 * from the ones that are not ordinary, and the distinguishing detail for the
 * last real bug here was exactly the context: a prompt of a few characters
 * behaves differently from a full buffer, and knowing the client called the file
 * plain text rather than code is most of the diagnosis.
 *
 * The file's name only, not its path: the name is what a person recognises in
 * their own log, and dropping the directories keeps the line from carrying the
 * shape of someone's disk when it is pasted into a report. The counts are
 * counts — the buffer itself never reaches the log.
 * @param scope - injected Host services.
 * @param reason - why the attempt was skipped.
 * @param context - the file, the claimed language, and the context sizes.
 * @param error - the underlying failure, when there is one.
 */
function logCompletionFailure(scope, reason, context, error) {
  const logger = scope?.logger
  if (logger === undefined || typeof logger.warn !== 'function') return
  const detail = [
    context?.file === '' ? undefined : context.file,
    context?.language === '' ? undefined : context.language,
    context === undefined ? undefined : `${context.prefixChars}+${context.suffixChars} chars`,
  ].filter((field) => field !== undefined).join(' · ')
  if (error === undefined) logger.warn('code-workbench: completion skipped — %s [%s]', reason, detail)
  else logger.warn('code-workbench: completion skipped — %s (%s) [%s]', reason, error?.message ?? String(error), detail)
}

/**
 * The response for a completion this Host declines to attempt: an ordinary
 * success carrying no text, so the editor shows no suggestion and no error.
 *
 * Deliberately the same shape as a real answer rather than an error. This
 * plugin speaks only FIM, so a failure here has no alternative route to fall
 * back to — it is a configuration state rather than something the person
 * typing can act on. The reason goes to the Host log and the settings page
 * instead of into the editor.
 * @param scope - injected Host services, used for the Host-side record.
 * @param reason - why the attempt was skipped.
 * @param context - what was being completed, for the log line.
 * @param error - the underlying failure, when there is one.
 * @returns an empty completion response.
 */
function silentCompletion(scope, reason, context, error) {
  logCompletionFailure(scope, reason, context, error)
  return json(200, { ok: true, text: '' })
}

/**
 * Handle one Tab-completion request: the ghost-text continuation at the caret,
 * answered in a single response.
 *
 * Only a malformed request is rejected with JSON, because only that means our
 * own client half is broken. Everything that depends on configuration — an
 * unusable address, no usable credential, the provider refusing — answers with
 * {@link silentCompletion}, leaving the editor quiet.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the completion text, or a JSON rejection.
 */
async function handleComplete(scope, request, config, settings) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path, prefix, suffix } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof prefix !== 'string' || prefix.trim() === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'prefix is required' } })

  // What the client says it is completing. Nothing here changes the request —
  // the model gets only the caret window — but a skipped completion is silent in
  // the editor, so this is what the one log line has to say for itself.
  const context = {
    file: String(path).split(/[\\/]/).at(-1) ?? '',
    language: typeof body?.language === 'string' ? body.language : '',
    prefixChars: prefix.length,
    suffixChars: typeof suffix === 'string' ? suffix.length : 0,
  }

  const liveSettings = settings?.describe?.({ redactSecrets: false })
    ?.find((entry) => entry.ns === 'code-workbench')?.value
  const preference = (field) => liveSettings?.[field] ?? config?.[field]?.get?.() ?? config?.[field]
  const baseUrl = preference('completionBaseUrl') || DEFAULT_COMPLETION_BASE_URL
  const model = preference('completionApiModel') || DEFAULT_COMPLETION_MODEL

  let endpoint
  try {
    endpoint = fimEndpoint(baseUrl)
  } catch (error) {
    return silentCompletion(scope, 'the configured base URL is not a usable HTTP(S) address', context, error)
  }

  const credential = await resolveCompletionCredential(scope, preference, baseUrl)
  if (credential === undefined) return silentCompletion(scope, 'no completion credential is available', context)

  const upstream = credential.apiKey === undefined
    ? { baseUrl, accountToken: credential.accountToken }
    : { baseUrl, apiKey: credential.apiKey }
  const describe = `${endpoint} · ${model} · 凭据 ${credential.source}`
  try {
    const text = await completeFim(upstream, {
      model,
      prompt: prefix.slice(-COMPLETE_CAPS.prefix),
      suffix: typeof suffix === 'string' ? suffix.slice(0, COMPLETE_CAPS.suffix) : '',
      maxTokens: COMPLETE_CAPS.maxTokens,
      signal: request.signal,
    })
    return json(200, { ok: true, text })
  } catch (error) {
    return silentCompletion(scope, `the provider request failed [${describe}]`, context, error)
  }
}

/**
 * Resolve the credential for one FIM call, in preference order: the key the
 * person pasted into the settings form, then `DEEPSEEK_API_KEY` in the DSH
 * credential store, then the signed-in account's grant.
 *
 * Every source is optional and none of them is an error — a machine with none
 * simply gets no suggestion. The account half is the interesting one: that
 * service is Host-only, and `resolveToken` returns a value only for the
 * inference origin it trusts, so passing the configured base URL is what
 * performs that check.
 * @param scope - injected Host services.
 * @param preference - reads one live setting.
 * @param baseUrl - the configured endpoint, used for the account origin check.
 * @returns `{source, apiKey}` or `{source, accountToken}`, or undefined.
 */
async function resolveCompletionCredential(scope, preference, baseUrl) {
  const manual = preference('completionApiKey')
  if (typeof manual === 'string' && manual.trim() !== '') return { source: 'manual', apiKey: manual.trim() }

  const credentials = scope.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(DEEPSEEK_API_KEY_REF)
      if (typeof resolved?.value === 'string' && resolved.value !== '') return { source: 'store', apiKey: resolved.value }
    } catch { /* an unreadable store must not block the account route */ }
  }

  const account = scope.get('deepseekAccount')
  if (account !== undefined) {
    try {
      const token = await account.resolveToken(baseUrl)
      if (typeof token === 'string' && token !== '') return { source: 'account', accountToken: token }
    } catch { /* signed out, or a destination the account service does not trust */ }
  }

  return undefined
}

/**
 * Where a completion would be sent, and with which credential. The value is
 * never included — only which source it came from — so the settings page can
 * explain a quiet editor without ever handling a secret.
 * @param scope - injected Host services.
 * @param preference - reads one live setting.
 * @returns the status payload the client half renders.
 */
async function completionStatus(scope, preference) {
  const baseUrl = preference('completionBaseUrl') || DEFAULT_COMPLETION_BASE_URL
  const model = preference('completionApiModel') || DEFAULT_COMPLETION_MODEL
  let endpoint = ''
  try {
    endpoint = fimEndpoint(baseUrl)
  } catch {
    return { mode: 'fim', endpoint: '', addressValid: false, model, source: 'none' }
  }
  const credential = await resolveCompletionCredential(scope, preference, baseUrl)
  return { mode: 'fim', endpoint, addressValid: true, model, source: credential?.source ?? 'none' }
}

/**
 * Answer one completion-status read. Read-only: it resolves a credential in
 * order to name its source, and never returns the value.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the status payload as JSON.
 */
async function handleCompletionStatus(scope, request, config, settings) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })
  const liveSettings = settings?.describe?.({ redactSecrets: false })
    ?.find((entry) => entry.ns === 'code-workbench')?.value
  const preference = (field) => liveSettings?.[field] ?? config?.[field]?.get?.() ?? config?.[field]
  return json(200, { ok: true, ...await completionStatus(scope, preference) })
}

/** Unbounded quantifiers — a `{n,}` with no upper bound repeats forever. */
const UNBOUNDED_QUANTIFIER = /^\{\d+,\}/

/**
 * Whether a pattern can backtrack exponentially, letting one line of input hold
 * the Host's event loop for minutes inside a single `exec`.
 *
 * No budget check can interrupt a regex once the engine is inside it, so the
 * only place to stop this is before the first match. The shape is a quantified
 * group whose body is itself unbounded — `(a+)+`, `(.*)*`, `(\w+\s?)*`: every
 * further character multiplies the ways to split it, so measured against this
 * engine a 24-character line already costs ~142 ms and 26 characters ~575 ms —
 * doubling with each character added, while the line cap permits 4000.
 *
 * This is a scan rather than a parse: it flags an unbounded quantifier inside a
 * group that is itself quantified, which is the accident a person actually
 * types. An overlapping alternation like `(a|a)*` grows just as fast without
 * nesting and is not caught here, which is why {@link searchWorkspace} also
 * re-checks its time budget inside the line loop.
 * @param source - the pattern text, as typed, without delimiters.
 * @returns whether the pattern is refused.
 */
function canBacktrackExponentially(source) {
  /** One flag per open group: does its body hold an unbounded quantifier? */
  const open = []
  let escaped = false
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const character = source[i]
    if (escaped) { escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (inClass) { if (character === ']') inClass = false; continue }
    if (character === '[') { inClass = true; continue }
    if (character === '(') { open.push(false); continue }
    if (character === '*' || character === '+') {
      if (open.length > 0) open[open.length - 1] = true
      continue
    }
    if (character === '{' && UNBOUNDED_QUANTIFIER.test(source.slice(i))) {
      if (open.length > 0) open[open.length - 1] = true
      continue
    }
    if (character !== ')') continue
    const inner = open.pop() ?? false
    const tail = source.slice(i + 1)
    const repeated = tail.startsWith('*') || tail.startsWith('+') || UNBOUNDED_QUANTIFIER.test(tail)
    if (inner && repeated) return true
    // A quantified group is itself an unbounded quantifier to its parent.
    if (open.length > 0 && (inner || repeated)) open[open.length - 1] = true
  }
  return false
}

/**
 * Build the line matcher for one search request.
 * @param query - user query text.
 * @param regex - whether `query` is a regular expression.
 * @param caseSensitive - matching case-sensitively.
 * @returns a global RegExp over single lines.
 * @throws SyntaxError when a user regex does not compile, or an error carrying
 *   `code: 'REGEX_UNSAFE'` when it would backtrack exponentially.
 */
function buildMatcher(query, regex, caseSensitive) {
  if (regex && canBacktrackExponentially(query)) {
    const error = new Error('这个正则存在指数回溯风险（量词套在含量词的分组上），会长时间占住 Host；请改写为等价的线性写法，例如把 (a+)+ 改成 a+')
    error.code = 'REGEX_UNSAFE'
    throw error
  }
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source, caseSensitive ? 'g' : 'gi')
}

/**
 * Walk the workspace collecting candidate text files, bounded by the caps so a
 * pathological tree cannot stall the Host.
 * @param scope - injected Host services.
 * @param rootTarget - the workspace root.
 * @param signal - cancellation.
 * @returns the candidate file targets.
 */
async function collectFiles(scope, rootTarget, signal) {
  const files = []
  const queue = [{ target: rootTarget, depth: 0 }]
  while (queue.length > 0 && files.length < SEARCH_CAPS.files) {
    const { target, depth } = queue.shift()
    let entries
    try {
      entries = await scope.fs.listDir(target, signal)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.type === 'directory') {
        if (depth >= SEARCH_CAPS.depth || IGNORED_DIRS.has(entry.name)) continue
        queue.push({ target: entry.target, depth: depth + 1 })
      } else if (entry.type === 'file') {
        const dot = entry.name.lastIndexOf('.')
        if (dot >= 0 && IGNORED_EXT.has(entry.name.slice(dot).toLowerCase())) continue
        if (typeof entry.size === 'number' && entry.size > SEARCH_CAPS.fileBytes) continue
        files.push(entry.target)
      }
    }
  }
  return files
}

/**
 * Run one bounded workspace search.
 * @param scope - injected Host services.
 * @param workspaceRoot - the session workspace root.
 * @param params - `{ query, regex, caseSensitive, limit, mode }`; `mode: 'terms'`
 *   matches lines containing ANY whitespace-separated term (retrieval-style),
 *   the default matches the query as one literal/regex.
 * @param signal - cancellation.
 * @returns the match report.
 */
async function searchWorkspace(scope, workspaceRoot, params, signal) {
  const matchers = params.mode === 'terms'
    ? params.query.split(/\s+/).filter((term) => term !== '').map((term) => buildMatcher(term, false, false))
    : [buildMatcher(params.query, params.regex === true, params.caseSensitive === true)]
  const limit = params.limit
  const started = Date.now()
  const matches = []
  let filesScanned = 0
  let truncated = false
  const rootTarget = await scope.fs.resolve(workspaceRoot)
  const files = await collectFiles(scope, rootTarget, signal)
  for (const target of files) {
    if (Date.now() - started > SEARCH_CAPS.budgetMs) {
      truncated = true
      break
    }
    let text
    try {
      text = await scope.fs.readText(target, signal)
    } catch {
      continue
    }
    filesScanned++
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      // The budget is re-checked inside the file, not only between files: a
      // user regex can be slow without being catastrophic, and one pathological
      // line used to be able to run past every check. Sampled every 64 lines,
      // because `Date.now()` per line would cost more than the match itself.
      if ((i & 63) === 0 && Date.now() - started > SEARCH_CAPS.budgetMs) {
        truncated = true
        break
      }
      const line = lines[i]
      if (line.length > SEARCH_CAPS.lineChars) continue
      let hit = null
      for (const matcher of matchers) {
        matcher.lastIndex = 0
        const candidate = matcher.exec(line)
        if (candidate !== null && (hit === null || candidate.index < hit.index)) hit = candidate
      }
      if (hit === null) continue
      matches.push({
        path: target.displayPath,
        line: i + 1,
        column: hit.index + 1,
        length: hit[0].length,
        text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
      })
      if (matches.length >= limit) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  return { matches, truncated, filesScanned, elapsedMs: Date.now() - started }
}

/**
 * Handle one codebase search: bounded walk + line matching. This is the
 * retrieval behind `@codebase`; results are plain
 * `{ path, line, column, length, text }` rows the editor can jump to.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON match report.
 */
async function handleSearch(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, query, regex, caseSensitive, maxMatches } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof query !== 'string' || query.trim() === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'query is required' } })
  if (query.length > SEARCH_CAPS.queryChars) return json(413, { ok: false, error: { code: 'TOO_LARGE', message: `query exceeds ${SEARCH_CAPS.queryChars} chars` } })

  try {
    buildMatcher(query, regex === true, caseSensitive === true)
  } catch (error) {
    const code = error?.code === 'REGEX_UNSAFE' ? 'REGEX_UNSAFE' : 'REGEX_INVALID'
    return json(400, { ok: false, error: { code, message: error?.message ?? 'invalid regular expression' } })
  }

  const session = scope.sessions.get(sessionId)
  const workspaceRoot = session?.header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return json(404, { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'session has no workspace root' } })
  }

  const limit = typeof maxMatches === 'number' && Number.isInteger(maxMatches) && maxMatches > 0
    ? Math.min(maxMatches, SEARCH_CAPS.matches)
    : SEARCH_CAPS.matches

  try {
    let searchRoot = workspaceRoot
    if (typeof body.directory === 'string' && body.directory !== '') {
      const root = await scope.fs.resolve(workspaceRoot)
      const directory = await scope.fs.resolve(body.directory, { cwd: workspaceRoot })
      if (!scope.fs.contains(root, directory)) return json(403, { ok: false, error: { message: '搜索目录必须位于工作区内' } })
      searchRoot = directory.displayPath
    }
    const report = await searchWorkspace(scope, searchRoot, { query, regex, caseSensitive, limit }, request.signal)
    return json(200, { ok: true, ...report })
  } catch (error) {
    return json(500, { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'FS_IO_ERROR', message: error?.message ?? String(error) } })
  }
}

/** Rank one search's matches for retrieval: multi-term coverage first. */
function rankMatches(query, matches) {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  const scored = matches.map((match) => {
    const haystack = `${match.path} ${match.text}`.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
    return { ...match, score }
  })
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  return scored
}

/**
 * The Agent-facing retrieval tool (the `@codebase` tool): ranked snippets for a
 * natural query, complementary to the shipped `grep` (exact regex lines).
 * @param scope - injected Host services.
 * @returns the registry-ready tool definition.
 */
function codebaseSearchTool(scope) {
  return {
    name: 'codebase_search',
    description: 'Ranked codebase retrieval: find the code most relevant to a natural query (e.g. "where is the retry backoff implemented"). Multi-term queries rank snippets that cover more terms higher. Complementary to grep: use this to FIND relevant code, grep for exact patterns.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'What to look for, as words or a phrase. Every term contributes to the ranking.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum snippets to return (default 8, capped at 30).',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                line: { type: 'number' },
                score: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['path', 'line', 'text'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['results'],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No matches.'
          : value.results.map((row) => `${row.path}:${row.line}: ${row.text}`).join('\n'),
      }],
    },
    timeoutMs: 15000,
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('codebase_search: query is required')
      const limit = typeof args?.maxResults === 'number' && Number.isFinite(args.maxResults)
        ? Math.max(1, Math.min(30, Math.floor(args.maxResults)))
        : 8
      const workspaceRoot = exec.agent?.session?.header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        throw new Error('codebase_search: the session has no workspace root')
      }
      const report = await searchWorkspace(scope, workspaceRoot, {
        query,
        mode: 'terms',
        limit: SEARCH_CAPS.matches,
      }, exec.signal)
      const ranked = rankMatches(query, report.matches).slice(0, limit)
      const prefix = `${workspaceRoot.replace(/[\\/]+$/, '')}`
      return {
        results: ranked.map((row) => ({
          path: row.path.startsWith(prefix) ? row.path.slice(prefix.length).replace(/^[\\/]+/, '') : row.path,
          line: row.line,
          score: row.score,
          text: row.text.trim(),
        })),
        truncated: report.truncated,
      }
    },
  }
}

/**
 * Handle one journal listing: the saves of one file, newest first.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON entry list (no file contents).
 */
async function handleHistory(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })

  const entries = journal.get(`${sessionId}\u0000${path}`) ?? []
  return json(200, {
    ok: true,
    entries: entries.map((entry) => ({
      id: entry.id,
      at: entry.at,
      operation: entry.operation,
      note: entry.note,
      lines: entry.lines,
      rollbackable: entry.before !== null && !entry.beforeTruncated,
    })),
  })
}

/**
 * Handle one rollback: restore the content one save replaced. The rollback is
 * itself journaled, so it is reversible like any other save.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleRollback(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false, error: { code: 'UNAUTHORIZED' } })

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'body must be JSON' } })
  }
  const { sessionId, path, id } = body ?? {}
  if (typeof sessionId !== 'string' || sessionId === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId is required' } })
  if (typeof path !== 'string' || path === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'path is required' } })
  if (typeof id !== 'string' || id === '') return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'id is required' } })

  const entries = journal.get(`${sessionId}\u0000${path}`) ?? []
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) return json(404, { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: 'no such journal entry' } })
  if (entry.before === null || entry.beforeTruncated) {
    return json(409, { ok: false, error: { code: 'NOT_ROLLBACKABLE', message: 'this save has no retained before content' } })
  }

  const session = scope.sessions.get(sessionId)
  const workspaceRoot = session?.header?.cwd ?? scope.get('sandboxPolicy')?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return json(404, { ok: false, error: { code: 'UNKNOWN_SESSION', message: 'session has no workspace root' } })
  }

  try {
    const rootTarget = await scope.fs.resolve(workspaceRoot)
    const target = await scope.fs.resolve(path, { cwd: workspaceRoot })
    if (!scope.fs.contains(rootTarget, target)) {
      return json(403, { ok: false, error: { code: 'OUTSIDE_WORKSPACE', message: 'path is outside the session workspace' } })
    }
    const info = await scope.fs.stat(target)
    const intent = info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }
    const sandboxPolicy = scope.get('sandboxPolicy')?.resolve({ session })
    const outcome = await scope.fs.writeText(target, entry.before, intent, undefined, sandboxPolicy)
    const note = `回滚：恢复到 ${new Date(entry.at).toISOString()} 保存前的内容`
    journalWrite(sessionId, path, note, outcome, entry.before)
    try {
      scope.get('sessionFeedback')?.record({ sessionId, text: `[code-workbench] ${note}（${path}）` })
    } catch { /* remark is best-effort */ }
    return json(200, { ok: true, version: outcome.version, operation: outcome.operation })
  } catch (error) {
    const failure = fileFailure(error)
    return json(failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
  }
}

/**
 * Handle one name-level filesystem operation: create, rename, copy, delete.
 *
 * This is the only place the plugin touches the disk itself, and deliberately
 * so. The official filesystem service offers reads, listings and text writes —
 * `resolve`, `contains`, `stat`, `lstat`, `readText`, `listDir`, `writeText`,
 * `editText` — and no operation that creates a directory, deletes, renames or
 * copies; the sandboxing backend adds none either. So there is nothing to
 * compose here, and what the official path would have supplied is owed
 * explicitly instead:
 *
 *  - containment, checked against the session workspace root after `resolve`
 *    has followed symlinks, and refused for the root itself;
 *  - the session's standing sandbox mode, which gates every operation before
 *    dispatch; file *contents* are still written through `ctx.fs.writeText`,
 *    which stamps the policy per call;
 *  - no silent overwrite: a destination that exists is refused rather than
 *    replaced;
 *  - a copy can never land inside its own source.
 *
 * `createFile` is the exception that proves the rule — it is a text write, so
 * it goes through `ctx.fs.writeText` with a `createIfAbsent` intent like every
 * other write, and `writeText` creates any missing parent directories itself.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleFileOperation(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false })
  try {
    const body = await request.json()
    if (!['createFile', 'createDirectory', 'rename', 'copy', 'delete'].includes(body?.operation)
      || typeof body.path !== 'string' || body.path === ''
      || typeof body.sessionId !== 'string' || body.sessionId === '') {
      throw requestFailure(400, 'BAD_REQUEST', '无效的文件操作')
    }

    const session = scope.sessions.get(body.sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') throw requestFailure(404, 'UNKNOWN_SESSION', '会话没有工作区')
    const policy = scope.get('sandboxPolicy')?.resolve({ session })
    if (!['workspace-write', 'danger-full-access'].includes(policy?.mode)) {
      throw requestFailure(403, 'READ_ONLY_SESSION', '当前会话为只读，无法修改文件；请在对话区将文件权限切换为允许工作区写入后重试')
    }

    const root = await scope.fs.resolve(cwd)
    const target = await scope.fs.resolve(body.path, { cwd })
    if (!scope.fs.contains(root, target) || target.targetKey === root.targetKey || target.displayPath === root.displayPath) {
      throw requestFailure(403, 'OUTSIDE_WORKSPACE', '不允许操作工作区外路径或工作区根目录')
    }

    if (body.operation === 'createFile') {
      await scope.fs.writeText(target, '', { kind: 'createIfAbsent' }, request.signal, policy)
      return json(200, { ok: true })
    }
    if (body.operation === 'createDirectory') {
      // Not recursive: a missing parent is a mistake worth reporting, not one
      // worth silently papering over with a whole chain of directories.
      await disk.mkdir(target.displayPath)
      return json(200, { ok: true })
    }
    if (body.operation === 'delete') {
      await disk.rm(target.displayPath, { recursive: true })
      return json(200, { ok: true })
    }

    if (typeof body.destination !== 'string' || body.destination === '') throw requestFailure(400, 'BAD_REQUEST', '缺少目标路径')
    const destination = await scope.fs.resolve(body.destination, { cwd })
    if (!scope.fs.contains(root, destination) || scope.fs.contains(target, destination)) {
      throw requestFailure(403, 'OUTSIDE_WORKSPACE', '目标必须在工作区内且不能位于源目录内')
    }
    // `lstat`, not `stat`: a dangling symlink still occupies the destination
    // name, and publishing over it is exactly what must not happen. Written as
    // a refusal result rather than a throw, so the check reads as a question.
    const taken = await disk.lstat(destination.displayPath).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false
      throw error
    })
    if (taken) throw requestFailure(409, 'ALREADY_EXISTS', '目标已存在，禁止覆盖')

    if (body.operation === 'rename') await disk.rename(target.displayPath, destination.displayPath)
    else await disk.cp(target.displayPath, destination.displayPath, { recursive: true, force: false, errorOnExist: true, dereference: false })
    return json(200, { ok: true })
  } catch (error) {
    const failure = fileFailure(error)
    return json(failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
  }
}

// ---------------------------------------------------------------------------
// Update check and apply
//
// A panel that can tell its own installation a newer release exists — and land
// it — is the difference between "upgrade" and "uninstall it and type the URL
// again". Nothing here invents a channel: the bytes are the ones the release
// already published, and the swap works only because the shipped client-module
// registry reads a row's `client.js` from disk on demand and re-publishes the
// row when its revision changes — the same transport `dsh-client-hmr` documents
// as the way a development rebuild supplies bundle changes.
//
// GitHub is read through the REST API rather than a raw-content host because the
// raw host is not reachable from every machine this runs on while
// `api.github.com` is; files past the contents API's 1 MB inline limit come from
// the blob API it names in their place.
// ---------------------------------------------------------------------------

/** The published repository an update comes from. */
const UPDATE_REPOSITORY = 'FinalLawer/dsh-native-code-workbench'
/** The package inside that repository; the repository root carries no package.json. */
const UPDATE_SUBDIR = 'dsh-code-workbench'
/** The released manifest naming every shipped file and its SHA-256. */
const UPDATE_MANIFEST = 'update.json'
/** The directory this half is installed in — the only thing an update writes to. */
const INSTALL_DIR = dirname(fileURLToPath(import.meta.url))
/** Tags scanned newest-first: a release published without a manifest must fall through, not fail. */
const UPDATE_TAG_SCAN = 5
/**
 * Files the running Host already has in memory.
 *
 * `index.js` and everything it imports are loaded once, at boot, so replacing
 * them is necessary but not sufficient: the process keeps running the old code
 * until DSH restarts, and the caller has to say so rather than report an update
 * that is not in effect yet. Everything else in the package either gets read off
 * disk on demand — `client.js`, which the shipped module registry re-publishes
 * the moment its revision changes — or is inert once loaded: the build inputs
 * under `src/`, `build.mjs`, the licence, the readme.
 */
const UPDATE_BOOT_FILES = new Set([
  'index.js',
  'completion-api.mjs',
  'vendor/schemastery.mjs',
  'src/completion-window.mjs',
  'cordis.patch.yml',
])
/** Caps: the manifest, one shipped file, and the two request budgets. */
const UPDATE_MANIFEST_BYTES = 256 * 1024
const UPDATE_FILE_BYTES = 32 * 1024 * 1024
const UPDATE_META_TIMEOUT_MS = 15_000
const UPDATE_BLOB_TIMEOUT_MS = 120_000
/** One check is two small reads; hold the answer briefly so a reopened panel is free. */
const UPDATE_CACHE_MS = 5 * 60 * 1000
/**
 * A relative path this half is willing to write.
 *
 * An update writes inside this package's own directory, so what a hostile or
 * corrupt manifest must not be able to say is the whole point: no absolute path,
 * no `.` or `..` segment, no backslash, no empty segment.
 */
const UPDATE_SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
/** The newest release carrying a manifest, held for {@link UPDATE_CACHE_MS}. */
let updateCache = { at: 0, release: null }

/** GitHub accepts anonymous REST reads; the version header pins the response shape. */
const UPDATE_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-code-workbench',
}

/**
 * Parse `v1.2.3`, `1.2.3` or `1.2.3-rc.1` into comparable parts.
 * @param text - a tag name or a package version.
 * @returns the parts, or null when the text is not a version this understands.
 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(text).trim())
  if (match === null) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
}

/**
 * Order two versions, with a pre-release below its release (`1.0.0-rc.1 < 1.0.0`).
 * Unparseable text compares equal, so it can never win the "is it newer?" test.
 * @returns a negative number, zero, or a positive number.
 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * One bounded GitHub read.
 * @param url - the REST URL.
 * @param timeoutMs - the bound, independent of the caller's own deadline.
 * @param signal - the caller's cancellation, or undefined.
 * @returns the parsed body.
 * @throws {Error} when the request fails, the bound expires, or the body is not JSON.
 */
async function readGithub(url, timeoutMs, signal) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, {
    headers: UPDATE_HEADERS,
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
  })
  if (!response.ok) throw requestFailure(502, 'UPDATE_GITHUB', `GitHub 返回 ${response.status}`)
  return response.json()
}

/** This installation's own version, read from the manifest beside this file. */
async function installedVersion() {
  const manifest = JSON.parse(await disk.readFile(join(INSTALL_DIR, 'package.json'), 'utf8'))
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * The file list a manifest is allowed to name.
 * @param manifest - the parsed manifest.
 * @returns the paths, relative to the package directory.
 * @throws {Error} when the manifest is not one this half will act on.
 */
function manifestNames(manifest) {
  const files = manifest?.files
  if (files === null || typeof files !== 'object') throw requestFailure(502, 'UPDATE_MANIFEST', '清单没有文件表')
  const names = Object.keys(files)
  if (names.length === 0 || names.length > 64) throw requestFailure(502, 'UPDATE_MANIFEST', '清单的文件数不合理')
  for (const name of names) {
    if (!UPDATE_SAFE_PATH.test(name)) throw requestFailure(502, 'UPDATE_MANIFEST', `清单包含不安全的路径：${name}`)
    if (typeof files[name] !== 'string' || !/^[0-9a-f]{64}$/.test(files[name])) throw requestFailure(502, 'UPDATE_MANIFEST', `清单的摘要不合法：${name}`)
  }
  return names.sort()
}

/**
 * The newest published tag that carries a manifest.
 *
 * Tags are ordered here rather than trusted: `/tags` promises no order, and a
 * release published without a manifest has to fall through to the one below it
 * instead of failing the whole check — which is exactly the case for every tag
 * older than this feature.
 * @param signal - the caller's cancellation.
 * @returns `{ tag, version, manifest, names }`, or null when no scanned tag carries one.
 */
async function newestRelease(signal) {
  const tags = await readGithub(`https://api.github.com/repos/${UPDATE_REPOSITORY}/tags?per_page=100`, UPDATE_META_TIMEOUT_MS, signal)
  if (!Array.isArray(tags)) return null
  const ranked = tags
    .map((entry) => entry?.name)
    .filter((name) => typeof name === 'string' && parseVersion(name) !== null)
    .sort((left, right) => compareVersions(right, left))
    .slice(0, UPDATE_TAG_SCAN)
  for (const tag of ranked) {
    const listing = await readGithub(
      `https://api.github.com/repos/${UPDATE_REPOSITORY}/contents/${UPDATE_SUBDIR}/${UPDATE_MANIFEST}?ref=${encodeURIComponent(tag)}`,
      UPDATE_META_TIMEOUT_MS, signal,
    ).catch(() => null)
    if (listing === null || typeof listing.content !== 'string' || listing.encoding !== 'base64') continue
    if (!Number.isFinite(listing.size) || listing.size > UPDATE_MANIFEST_BYTES) throw requestFailure(502, 'UPDATE_MANIFEST', '清单超出允许的大小')
    const manifest = JSON.parse(Buffer.from(listing.content, 'base64').toString('utf8'))
    if (typeof manifest?.version !== 'string' || parseVersion(manifest.version) === null) continue
    return { tag, version: manifest.version, manifest, names: manifestNames(manifest) }
  }
  return null
}

/** The newest release, held briefly: reopening the panel must not cost another two reads. */
async function cachedRelease(signal) {
  if (Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.release
  const release = await newestRelease(signal)
  updateCache = { at: Date.now(), release }
  return release
}

/**
 * LF-normalised bytes: the form these text files are stored in.
 * @param bytes - the file as it is on disk.
 * @returns the same bytes with every CRLF reduced to LF.
 */
function normalisedLineEndings(bytes) {
  if (!bytes.includes(0x0d)) return bytes
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1')
}

/**
 * SHA-256 of an installed file, over normalised bytes, or null when it is missing.
 *
 * The digest has to describe the file, not the way it was checked out. Git holds
 * every one of these files with LF, a Windows working tree with
 * `core.autocrlf=true` hands them over as CRLF, and a tarball packed from that
 * tree keeps it — one source, three byte streams. Normalising here and in
 * `tools/make-update-manifest.py` makes the comparison about content, so an
 * installation made from a locally packed tarball is not perpetually "outdated".
 */
async function localDigest(path) {
  try {
    return createHash('sha256').update(normalisedLineEndings(await disk.readFile(path))).digest('hex')
  } catch {
    return null
  }
}

/** Which of a release's files differ from what is installed. */
async function changedFiles(release) {
  const changed = []
  for (const name of release.names) if (await localDigest(join(INSTALL_DIR, name)) !== release.manifest.files[name]) changed.push(name)
  return changed
}

/**
 * One shipped file, straight from the tag's own blob.
 *
 * The contents API inlines files up to 1 MB and answers with the blob's name for
 * anything larger, so the 5 MB bundle costs one extra read instead of a second
 * protocol.
 * @param tag - the release tag.
 * @param name - the path inside the package.
 * @param signal - the caller's cancellation.
 * @returns the bytes.
 */
async function readReleaseFile(tag, name, signal) {
  const listing = await readGithub(
    `https://api.github.com/repos/${UPDATE_REPOSITORY}/contents/${UPDATE_SUBDIR}/${name}?ref=${encodeURIComponent(tag)}`,
    UPDATE_META_TIMEOUT_MS, signal,
  )
  if (typeof listing?.content === 'string' && listing.encoding === 'base64') {
    const inline = Buffer.from(listing.content, 'base64')
    if (inline.length !== listing.size) throw requestFailure(502, 'UPDATE_TRUNCATED', `下载不完整：${name}`)
    return inline
  }
  if (typeof listing?.sha !== 'string') throw requestFailure(502, 'UPDATE_GITHUB', `无法定位 ${name}`)
  if (!Number.isFinite(listing.size) || listing.size > UPDATE_FILE_BYTES) throw requestFailure(502, 'UPDATE_TOO_LARGE', `${name} 超出允许的大小`)
  const blob = await readGithub(`https://api.github.com/repos/${UPDATE_REPOSITORY}/git/blobs/${listing.sha}`, UPDATE_BLOB_TIMEOUT_MS, signal)
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') throw requestFailure(502, 'UPDATE_GITHUB', `无法读取 ${name}`)
  const bytes = Buffer.from(blob.content, 'base64')
  if (bytes.length !== listing.size) throw requestFailure(502, 'UPDATE_TRUNCATED', `下载不完整：${name}`)
  return bytes
}

/**
 * Publish one file over the installed copy.
 *
 * `rename` and not a write: an installed tree is pnpm's, where every file is
 * hard-linked into the content store, so writing through the name would edit the
 * store copy other profiles share. Renaming a fresh file onto the name replaces
 * the directory entry instead — atomically, and without touching the store.
 * @param name - the path inside the package.
 * @param bytes - the verified bytes to publish.
 */
async function replaceFile(name, bytes) {
  const target = join(INSTALL_DIR, name)
  await disk.mkdir(dirname(target), { recursive: true })
  const staging = `${target}.update-${process.pid}-${Date.now()}`
  await disk.writeFile(staging, bytes)
  try {
    await disk.rename(staging, target)
  } catch (error) {
    await disk.rm(staging, { force: true })
    throw error
  }
}

/**
 * Answer whether a newer release is published.
 *
 * A courtesy, not a report: a machine that cannot reach GitHub, a repository
 * with no manifest, and an installation already at the newest version all answer
 * the same quiet "nothing to do". Only a well-formed answer about a real release
 * is worth the panel's attention.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleUpdateCheck(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false })
  try {
    const current = await installedVersion()
    const release = await cachedRelease(request.signal)
    if (release === null || compareVersions(release.version, current) <= 0) {
      return json(200, { ok: true, current, latest: release?.version ?? null, hasUpdate: false })
    }
    const changed = await changedFiles(release)
    return json(200, {
      ok: true,
      current,
      latest: release.version,
      hasUpdate: changed.length > 0,
      changed,
      needsRestart: changed.some((name) => UPDATE_BOOT_FILES.has(name)),
    })
  } catch (error) {
    const logger = scope?.logger
    if (typeof logger?.warn === 'function') logger.warn('code-workbench: update check skipped — %s', error?.message ?? String(error))
    return json(200, { ok: false, error: { code: 'UPDATE_UNAVAILABLE' } })
  }
}

/**
 * Answer the About panel: this installation's own version and repository.
 *
 * Read-only and local: it reads the manifest beside this file — the same file
 * an update rewrites — and nothing else, so the panel cannot outlive the truth
 * about what is actually running.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome.
 */
async function handleAbout(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false })
  try {
    return json(200, { ok: true, version: await installedVersion(), repository: `https://github.com/${UPDATE_REPOSITORY}` })
  } catch (error) {
    const logger = scope?.logger
    if (typeof logger?.warn === 'function') logger.warn('code-workbench: about skipped — %s', error?.message ?? String(error))
    return json(200, { ok: false, error: { code: 'ABOUT_UNAVAILABLE' } })
  }
}

/**
 * Install the published release over this installation.
 *
 * The manifest is read again here rather than taken from the caller: the request
 * only ever says "now", never which files or which digests. Every file is
 * checked against the digest the release published before it lands, and each one
 * lands atomically, so a failure part-way through leaves a working tree of mixed
 * — but individually valid — versions rather than a half-written file.
 * @param scope - injected Host services.
 * @param request - the buffered Fetch request the Connection dispatched.
 * @returns the JSON outcome; `needsRestart` is true when a file this process
 * already loaded was among those replaced.
 */
async function handleUpdateApply(scope, request) {
  const admission = scope.connection.admit(request)
  if ('rejection' in admission) return json(admission.rejection, { ok: false })
  try {
    const current = await installedVersion()
    const release = await newestRelease(request.signal)
    if (release === null || compareVersions(release.version, current) <= 0) {
      return json(200, { ok: true, applied: false, reason: 'up-to-date', current })
    }
    const changed = await changedFiles(release)
    if (changed.length === 0) return json(200, { ok: true, applied: false, reason: 'up-to-date', current, version: release.version })
    for (const name of changed) {
      // Normalised once, then verified and written: what lands on disk has to be
      // the file the digest describes, or the next check would report the same
      // file as changed again for a line-ending it never chose.
      const bytes = normalisedLineEndings(await readReleaseFile(release.tag, name, request.signal))
      if (createHash('sha256').update(bytes).digest('hex') !== release.manifest.files[name]) {
        throw requestFailure(502, 'UPDATE_DIGEST', `${name} 的摘要与清单不符`)
      }
      await replaceFile(name, bytes)
    }
    // The answer just changed under the cache: the next check must read the tree again.
    updateCache = { at: 0, release: null }
    return json(200, {
      ok: true,
      applied: true,
      version: release.version,
      changed,
      needsRestart: changed.some((name) => UPDATE_BOOT_FILES.has(name)),
    })
  } catch (error) {
    const failure = typeof error?.status === 'number'
      ? { code: error.code, message: error.message }
      : { code: 'UPDATE_FAILED', message: `更新失败：${error?.message ?? error}` }
    const logger = scope?.logger
    if (typeof logger?.warn === 'function') logger.warn('code-workbench: update failed — %s', failure.message)
    return json(200, { ok: false, error: failure })
  }
}

export function apply(ctx, config) {
  const runtime = { settings: undefined }
  if (ctx.fiber) {
    ctx.inject(['settings'], (scope) => {
      runtime.settings = scope.settings
      scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'code-workbench: settings')
    })
  }
  ctx.inject(['connection', 'fs', 'sessions', 'tools'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/code-workbench/file-operation', methods: ['POST'], requestBody: 'buffered',
      fetch: (request) => handleFileOperation(scope, request),
    }), 'code-workbench: file operations')
    scope.effect(() => scope.connection.fetch.register({
      path: WRITE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleWrite(scope, request),
    }), 'code-workbench: POST /api/code-workbench/write')
    scope.effect(() => scope.connection.fetch.register({
      path: COMPLETE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleComplete(scope, request, config, runtime.settings),
    }), 'code-workbench: POST /api/code-workbench/complete')
    scope.effect(() => scope.connection.fetch.register({
      path: COMPLETION_STATUS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleCompletionStatus(scope, request, config, runtime.settings),
    }), 'code-workbench: POST /api/code-workbench/completion-status')
    scope.effect(() => scope.connection.fetch.register({
      path: SEARCH_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleSearch(scope, request),
    }), 'code-workbench: POST /api/code-workbench/search')
    scope.effect(() => scope.connection.fetch.register({
      path: HISTORY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleHistory(scope, request),
    }), 'code-workbench: POST /api/code-workbench/history')
    scope.effect(() => scope.connection.fetch.register({
      path: ROLLBACK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRollback(scope, request),
    }), 'code-workbench: POST /api/code-workbench/rollback')
    scope.effect(() => scope.connection.fetch.register({
      path: UPDATE_CHECK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleUpdateCheck(scope, request),
    }), 'code-workbench: POST /api/code-workbench/update-check')
    scope.effect(() => scope.connection.fetch.register({
      path: UPDATE_APPLY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleUpdateApply(scope, request),
    }), 'code-workbench: POST /api/code-workbench/update-apply')
    scope.effect(() => scope.connection.fetch.register({
      path: ABOUT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleAbout(scope, request),
    }), 'code-workbench: POST /api/code-workbench/about')
    scope.effect(() => scope.tools.register(codebaseSearchTool(scope)), 'code-workbench: codebase_search tool')
  })
}
