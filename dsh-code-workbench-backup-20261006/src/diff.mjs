/**
 * Line diff for the inline rewrite review (pure, no dependencies).
 *
 * `diffLines` is a classic LCS over lines: when the DP table would exceed
 * `FALLBACK_CELLS` cells it degrades to "delete everything, insert everything"
 * rather than hanging the UI thread — an editor panel must stay responsive on a
 * pathological pair of large files.
 *
 * Row shape:
 *   { kind: 'ctx',  text, oldNo, newNo }
 *   { kind: 'del',  text, oldNo }
 *   { kind: 'add',  text, newNo }
 *   { kind: 'gap',  count, text }        — only produced by collapseDiff
 */

/** Above this many DP cells, report whole-file replacement instead of diffing. */
const FALLBACK_CELLS = 4_000_000

/**
 * Compare two line arrays.
 * @param oldLines - baseline lines.
 * @param newLines - proposed lines.
 * @returns the ordered diff rows.
 */
export function diffLines(oldLines, newLines) {
  const n = oldLines.length
  const m = newLines.length
  if (n === 0 && m === 0) return []
  if (n === 0) return newLines.map((text, i) => ({ kind: 'add', text, newNo: i + 1 }))
  if (m === 0) return oldLines.map((text, i) => ({ kind: 'del', text, oldNo: i + 1 }))
  if (n * m > FALLBACK_CELLS) {
    return [
      ...oldLines.map((text, i) => ({ kind: 'del', text, oldNo: i + 1 })),
      ...newLines.map((text, i) => ({ kind: 'add', text, newNo: i + 1 })),
    ]
  }

  // LCS length table, one flat typed array row-major over (n+1) x (m+1).
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ kind: 'ctx', text: oldLines[i], oldNo: i + 1, newNo: j + 1 })
      i++; j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: 'del', text: oldLines[i], oldNo: i + 1 })
      i++
    } else {
      rows.push({ kind: 'add', text: newLines[j], newNo: j + 1 })
      j++
    }
  }
  while (i < n) rows.push({ kind: 'del', text: oldLines[i], oldNo: i + 1 }), i++
  while (j < m) rows.push({ kind: 'add', text: newLines[j], newNo: j + 1 }), j++
  return rows
}

/**
 * Count the added and removed lines of one diff.
 * @param rows - diff rows from `diffLines`.
 * @returns `{ added, removed }`.
 */
export function diffStat(rows) {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  return { added, removed }
}

/**
 * Fold unchanged regions longer than twice the context into one `gap` row.
 * @param rows - diff rows from `diffLines`.
 * @param context - untouched rows to keep around every change.
 * @returns the collapsed rows; `gap.count` accounts for the hidden rows.
 */
export function collapseDiff(rows, context) {
  const keep = new Array(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'ctx') continue
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true
  }
  const out = []
  let i = 0
  while (i < rows.length) {
    if (keep[i]) {
      out.push(rows[i])
      i++
      continue
    }
    let j = i
    while (j < rows.length && !keep[j]) j++
    out.push({ kind: 'gap', count: j - i, text: `⋯ ${j - i} 行未改动` })
    i = j
  }
  return out
}
