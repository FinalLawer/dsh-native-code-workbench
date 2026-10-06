// Minimal, exact asar reader/extractor for the DSH archive.
//   node tools/asar.mjs list [prefix]
//   node tools/asar.mjs ls <prefix>        (top level of a directory)
//   node tools/asar.mjs cat <path>         (print one file)
//   node tools/asar.mjs extract <prefix> <destDir>
import fs from 'node:fs'
import path from 'node:path'

const ASAR = 'D:/Deepseek/resources/app.asar'

function open () {
  const fd = fs.openSync(ASAR, 'r')
  const first = Buffer.alloc(16)
  fs.readSync(fd, first, 0, 16, 0)
  // Pickle layout: [0]=pickle size, [4]=header size, [8]=string size, [12]=pad.
  // The header JSON begins at byte 16 and ends at (8 + headerSize), which is
  // exactly where file data begins.
  const headerSize = first.readUInt32LE(4)
  const jsonSize = first.readUInt32LE(8)
  const jsonBytes = Buffer.alloc(jsonSize)
  fs.readSync(fd, jsonBytes, 0, jsonSize, 16)
  // The declared size includes alignment padding; scan to the matching close brace.
  let end = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < jsonBytes.length; i++) {
    const c = jsonBytes[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b) depth++
    else if (c === 0x7d) {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error('unterminated asar header json')
  const header = JSON.parse(jsonBytes.subarray(0, end).toString('utf8'))
  // Data begins at 8 + headerSize (== 16 + actual JSON length).
  return { fd, header, dataOffset: 8 + headerSize }
}

const { fd, header, dataOffset } = open()

function walk (node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: child.size, offset: Number(child.offset), unpacked: !!child.unpacked })
  }
}

const all = []
walk(header, '', all)

function readFile (entry) {
  if (entry.unpacked) {
    return fs.readFileSync('D:/Deepseek/resources/app.asar.unpacked' + entry.path)
  }
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + entry.offset)
  return buf
}

const [cmd, a1, a2] = process.argv.slice(2)

if (cmd === 'list') {
  const prefix = a1 || ''
  const rows = all.filter(f => f.path.startsWith(prefix))
  console.log('count=' + rows.length)
  for (const f of rows) console.log(f.size + '\t' + f.path + (f.unpacked ? '  [unpacked]' : ''))
} else if (cmd === 'ls') {
  const prefix = (a1 || '').replace(/\/$/, '')
  const direct = new Map()
  for (const f of all) {
    if (!f.path.startsWith(prefix + '/')) continue
    const rest = f.path.slice(prefix.length + 1)
    const [head, ...tail] = rest.split('/')
    if (tail.length === 0) direct.set(head, 'file:' + f.size)
    else direct.set(head + '/', 'dir')
  }
  for (const [k, v] of [...direct].sort()) console.log(v + '\t' + k)
} else if (cmd === 'cat') {
  const entry = all.find(f => f.path === a1)
  if (!entry) { console.error('not found: ' + a1); process.exit(1) }
  if (entry.size > 400000) { console.error('too big: ' + entry.size); process.exit(1) }
  process.stdout.write(readFile(entry))
} else if (cmd === 'extract') {
  const prefix = a1.replace(/\/$/, '')
  const dest = a2
  const rows = all.filter(f => f.path.startsWith(prefix + '/'))
  let n = 0
  for (const f of rows) {
    const target = path.join(dest, f.path.slice(prefix.length + 1))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readFile(f))
    n++
  }
  console.log('extracted ' + n + ' files to ' + dest)
} else {
  console.error('usage: list|ls|cat|extract')
  process.exit(2)
}
fs.closeSync(fd)
