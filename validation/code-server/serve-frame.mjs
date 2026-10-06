import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('./frame.html', import.meta.url))
createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(18790, '127.0.0.1', () => console.log('Iframe validation: http://127.0.0.1:18790/'))
