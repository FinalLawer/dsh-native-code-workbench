#!/usr/bin/env node
/**
 * Why is Tab completion silent?
 *
 * The plugin's Host half answers that from inside DSH (the settings page shows a
 * 「当前补全链路」 block backed by `/api/code-workbench/completion-status`). This
 * is the same answer from outside: it walks the credential chain in the exact
 * order `resolveCompletionCredential` does, prints which source would win, and —
 * with `--live` — actually asks the endpoint with each available credential.
 *
 * It resolves references the way `@deepseek-ai/dsh-credentials-local` does:
 * the launching environment first, then `refs` in `$DSH_HOME/.credentials.yaml`,
 * then the `.env` fallback. Values are masked; nothing secret is printed.
 *
 * Usage:
 *   node tools/probe-completion-credential.mjs            # report only, no network
 *   node tools/probe-completion-credential.mjs --live      # + one real request per source
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { load as parseYaml } from '../ref/dsh/node_modules/js-yaml/dist/js-yaml.mjs'
import { fimEndpoint, ACCOUNT_TOKEN_HEADER } from '../dsh-code-workbench/completion-api.mjs'

const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'
const ACCOUNT_RECORD_KEY = 'deepseek-account-platform/default'

/** The settings the chain depends on, and their schema defaults. */
const BASE_URL = 'https://api.deepseek.com/beta'
const MODEL = 'deepseek-flash'

const live = process.argv.includes('--live')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** `sk-ab…len35` — enough to tell two keys apart, not enough to use one. */
const mask = (value) => (typeof value === 'string' && value !== ''
  ? `${value.slice(0, 4)}…len${value.length}`
  : '(empty)')

/** Read a reference the way the local credentials provider layers it. */
function resolveRef(ref, refs, dotenv) {
  const inherited = process.env[ref]
  if (typeof inherited === 'string' && inherited !== '') return { source: 'env', value: inherited }
  const stored = refs?.[ref]
  if (typeof stored === 'string' && stored !== '') return { source: 'file', value: stored }
  const fallback = dotenv?.[ref]
  if (typeof fallback === 'string' && fallback !== '') return { source: 'dotenv', value: fallback }
  return undefined
}

/**
 * The manual key lives in the profile's patch layer, which is where the settings
 * service writes it — the same file the settings page edits. Newest profile wins
 * if several exist, matching a single-profile machine; override with
 * `DSH_PROFILE` when you have more than one.
 */
function readManualKey() {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return undefined
  const names = process.env.DSH_PROFILE !== undefined
    ? [process.env.DSH_PROFILE]
    : readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  for (const name of names) {
    const patch = join(profilesDir, name, 'cordis.patch.yml')
    if (!existsSync(patch)) continue
    let entries
    try {
      entries = parseYaml(readFileSync(patch, 'utf8'))
    } catch {
      continue
    }
    const entry = Array.isArray(entries) ? entries.find((e) => e?.name === 'dsh-code-workbench') : undefined
    const value = entry?.config?.completionApiKey
    if (typeof value === 'string' && value.trim() !== '') return { profile: name, value: value.trim() }
  }
  return undefined
}

/** Parse `KEY=value` lines; the provider only needs the simple subset. */
function readDotenv(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Read the machine's stores.
// ---------------------------------------------------------------------------
const credentialsPath = join(dshHome, '.credentials.yaml')
let store
if (existsSync(credentialsPath)) {
  try {
    store = parseYaml(readFileSync(credentialsPath, 'utf8'))
  } catch (error) {
    console.log(`FAIL  ${credentialsPath} exists but does not parse: ${error.message}`)
    process.exit(1)
  }
} else {
  store = {}
}
const dotenv = { ...readDotenv(join(process.cwd(), '.env')), ...readDotenv(join(dshHome, '.env')) }

// ---------------------------------------------------------------------------
// 2. Walk the chain in `resolveCompletionCredential`'s order.
// ---------------------------------------------------------------------------
const manual = readManualKey()
const key = resolveRef(DEEPSEEK_API_KEY_REF, store.refs, dotenv)
const grant = store.records?.[ACCOUNT_RECORD_KEY]?.payload?.token

const candidates = []
if (manual !== undefined) {
  candidates.push({ source: 'manual', label: `设置页填写的 API Key（profile ${manual.profile}）`, apiKey: manual.value })
}
if (key !== undefined) {
  candidates.push({ source: 'store', label: `凭据库 ${DEEPSEEK_API_KEY_REF}（source: ${key.source}）`, apiKey: key.value })
}
if (typeof grant === 'string' && grant !== '') {
  candidates.push({ source: 'account', label: 'DSH 登录账号的凭据授权', accountToken: grant })
}

let endpoint
try {
  endpoint = fimEndpoint(BASE_URL)
} catch (error) {
  console.log(`FAIL  the default base URL does not resolve: ${error.message}`)
  process.exit(1)
}

console.log('DSH Code Workbench — completion credential chain\n')
console.log(`  DSH home       ${dshHome}`)
console.log(`  endpoint       ${endpoint}`)
console.log(`  model          ${MODEL}`)
console.log(`  credentials    ${existsSync(credentialsPath) ? credentialsPath : '(absent)'}`)
console.log()
console.log('  -- candidates, in priority order ---------------------------------')
if (candidates.length === 0) {
  console.log('  (none)  → completion answers an empty stream: the editor stays quiet.')
} else {
  for (const [index, candidate] of candidates.entries()) {
    const note = index === 0 ? '  ← would be used' : ''
    const secret = candidate.apiKey === undefined
      ? `grant ${mask(candidate.accountToken)} (header ${ACCOUNT_TOKEN_HEADER})`
      : `key ${mask(candidate.apiKey)} (header authorization: Bearer)`
    console.log(`  ${index + 1}. ${candidate.source.padEnd(8)} ${secret}${note}`)
    console.log(`     ${candidate.label}`)
  }
}

if (!live || candidates.length === 0) {
  if (!live) console.log('\n  (pass --live to actually call the endpoint with each candidate)')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 3. `--live`: one tiny request per candidate. Costs a handful of tokens.
// ---------------------------------------------------------------------------
console.log('\n  -- live check, one request per candidate -------------------------')
for (const candidate of candidates) {
  const headers = { 'content-type': 'application/json' }
  if (candidate.apiKey === undefined) headers[ACCOUNT_TOKEN_HEADER] = candidate.accountToken
  else headers.authorization = `Bearer ${candidate.apiKey}`

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        prompt: 'function add(a, b) {\n  return a + ',
        suffix: '\n}\n',
        stream: false,
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    console.log(`  ${candidate.source.padEnd(8)} SKIP  the request never completed: ${error?.message ?? error}`)
    continue
  }

  const text = await response.text()
  if (response.status !== 200) {
    console.log(`  ${candidate.source.padEnd(8)} FAIL  HTTP ${response.status} — ${text.slice(0, 160)}`)
    continue
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    console.log(`  ${candidate.source.padEnd(8)} FAIL  HTTP 200 but the body is not JSON`)
    continue
  }
  const choice = payload?.choices?.[0]
  const completion = choice?.text ?? choice?.delta?.content ?? choice?.message?.content
  console.log(`  ${candidate.source.padEnd(8)} PASS  HTTP 200, completed ${JSON.stringify(completion ?? null)}`)
}
