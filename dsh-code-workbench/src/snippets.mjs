export function serializeSnippet(anchor, language, code) {
  const runs = code.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `\n<!-- code-workbench-snippet ${JSON.stringify({ anchor, language })} -->\n${fence}${language}\n${code}\n${fence}\n<!-- /code-workbench-snippet -->\n`
}

export function splitSnippets(text) {
  const parts = []
  const pattern = /<!--\s*code-workbench-snippet\s+([\s\S]*?)\s*-->\s*\r?\n\s*(`{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n\s*\2\s*\r?\n\s*<!--\s*\/code-workbench-snippet\s*-->/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    let metadata
    try { metadata = JSON.parse(match[1].trim()) } catch { continue }
    if (typeof metadata.anchor !== 'string') continue
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) })
    parts.push({ anchor: metadata.anchor, language: metadata.language, code: match[3] })
    offset = match.index + match[0].length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) })
  return parts
}
