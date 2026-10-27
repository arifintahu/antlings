import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { securityHeaders } from './app.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves the built web app. Public: the login page and its assets must load without a session. */
export async function registerStatic(app: FastifyInstance, dir: string, origin: string): Promise<void> {
  const root = resolve(dir);
  app.get('/*', { config: { public: true } }, async (req, reply) => {
    let path: string;
    try {
      path = decodeURIComponent((req.url.split('?')[0] ?? '/').split(String.fromCharCode(92)).join('/'));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (path.includes('\0') || path.startsWith('/api/') || path === '/ws')
      return reply.code(404).send({ error: 'not_found' });
    const wanted = normalize(join(root, path === '/' ? 'index.html' : path));
    if (wanted !== root && !wanted.startsWith(root + sep))
      return reply.code(404).send({ error: 'not_found' });
    let file = wanted;
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(path)) return reply.code(404).send({ error: 'not_found' });
      file = join(root, 'index.html'); // single-page app fallback
    }
    const ext = extname(file);
    reply.type(TYPES[ext] ?? 'application/octet-stream');
    reply.header(
      'Cache-Control',
      file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    if (ext === '.html') {
      // A fresh nonce per response, in the CSP header and in the page, so scripts can tag the <style> elements they create.
      const nonce = randomBytes(16).toString('base64url');
      reply.header('Content-Security-Policy', securityHeaders(origin, nonce)['Content-Security-Policy']!);
      return reply.send(readFileSync(file, 'utf8').replaceAll('__CSP_NONCE__', nonce));
    }
    return reply.send(readFileSync(file));
  });
}
