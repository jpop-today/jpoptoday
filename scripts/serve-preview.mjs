/** Local built-artifact server. Real Pages HTTP behavior is verified separately. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('dist');
const redirects = (await readFile(path.join(root, '_redirects'), 'utf8')).trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    for (const [from, to, code] of redirects) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(':guide', '([^/]+)');
      const match = new RegExp('^' + escaped + '$').exec(url.pathname);
      if (match) { response.writeHead(Number(code), { Location: to.replace(':guide', match[1] ?? '') + url.search }); response.end(); return; }
    }
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error('Invalid path');
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = path.join(file, 'index.html');
    const bytes = await readFile(file).catch(() => null);
    response.writeHead(bytes ? 200 : 404, { 'Content-Type': bytes ? types[path.extname(file)] ?? 'application/octet-stream' : types['.html'], 'X-Robots-Tag': 'noindex, nofollow' });
    response.end(bytes ?? await readFile(path.join(root, '404.html')));
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(4321, '127.0.0.1', () => console.log('Built preview http://127.0.0.1:4321'));
