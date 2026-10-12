/**
 * The `<!-- code-workbench-snippet … -->` fence codec.
 *
 * An "Add to Chat" chip expands to a marker plus a fenced code block, and the
 * transcript decorates that same text back into a chip. One codec, both
 * directions, so what the model receives and what the transcript renders can
 * never be two different spellings of the same reference.
 */

/**
 * The plain text between two snippets.
 *
 * The `undefined`-typed optional members are load-bearing: they are what lets
 * the consumer tell the two arms apart with `piece.anchor === undefined` while
 * still reading `piece.text` as a `string`. A bare `{ text: string }` would
 * force every call site onto an `in` check instead.
 */
export interface SnippetText {
  text: string
  anchor?: undefined
  language?: undefined
  code?: undefined
}

/** One extracted snippet. */
export interface SnippetCode {
  /** `path:line` or `path:start-end`, workspace-relative. */
  anchor: string
  /**
   * The language the snippet was captured under.
   *
   * `unknown`, not `string`, and deliberately so: this is read straight out of
   * the marker's JSON and never validated — the parser only insists on `anchor`
   * — so promising a `string` here would be a claim the code does not keep.
   * Nothing reads it back out; the chat renderer uses `anchor` and `code`.
   */
  language: unknown
  code: string
  text?: undefined
}

/** One piece of a message: a snippet, or the text around it. */
export type SnippetPart = SnippetText | SnippetCode

/**
 * Wrap one code range in a snippet marker.
 *
 * The fence is chosen from the code itself: the longest backtick run inside it
 * decides the delimiter, so a snippet that already contains a fence still
 * round-trips. `Math.max(3, …)` is what makes a code block with no backticks
 * use the ordinary triple fence.
 *
 * @param anchor - `path:line` or `path:start-end`.
 * @param language - the language id to tag the fence with.
 * @param code - the code to wrap.
 * @returns the marker, the fenced code, and the closing marker.
 */
export function serializeSnippet(anchor: string, language: string, code: string): string {
  const runs = code.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `\n<!-- code-workbench-snippet ${JSON.stringify({ anchor, language })} -->\n${fence}${language}\n${code}\n${fence}\n<!-- /code-workbench-snippet -->\n`
}

/** The marker, fence and body of one snippet, in one pass. */
const SNIPPET_PATTERN = /<!--\s*code-workbench-snippet\s+([\s\S]*?)\s*-->\s*\r?\n\s*(`{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n\s*\2\s*\r?\n\s*<!--\s*\/code-workbench-snippet\s*-->/g

/** The marker's JSON, as far as this codec reads it. */
interface SnippetMetadata {
  anchor?: unknown
  language?: unknown
}

/**
 * Split a message back into its snippets and the text around them.
 *
 * A marker whose JSON does not parse, or that carries no string `anchor`, is
 * skipped rather than fatal: the surrounding text is then emitted as one run,
 * which is exactly what the message looked like before any snippet was added.
 *
 * @param text - the message as it was submitted.
 * @returns the parts, in order.
 */
export function splitSnippets(text: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let offset = 0
  for (const match of text.matchAll(SNIPPET_PATTERN)) {
    // The pattern's capture groups are all mandatory, so these fallbacks are
    // unreachable; they exist because indexed access is checked.
    const whole = match[0] ?? ''
    const index = match.index
    let metadata: SnippetMetadata
    try { metadata = JSON.parse((match[1] ?? '').trim()) as SnippetMetadata } catch { continue }
    if (typeof metadata.anchor !== 'string') continue
    if (index > offset) parts.push({ text: text.slice(offset, index) })
    parts.push({ anchor: metadata.anchor, language: metadata.language, code: match[3] ?? '' })
    offset = index + whole.length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) })
  return parts
}
