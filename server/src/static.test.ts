import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeKit, type Kit } from './testkit.js';

let kit: Kit;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

async function staticKit() {
  const dir = mkdtempSync(join(tmpdir(), 'antlings-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<meta name="csp-nonce" content="__CSP_NONCE__"><div id="app"></div>',
  );
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
  kit = await makeKit({}, { ANTLINGS_STATIC_DIR: dir });
}

const nonceOf = (csp: string) => /style-src 'self' 'nonce-([A-Za-z0-9_-]{16,})'/.exec(csp)?.[1];

describe('style nonce', () => {
  it('puts a fresh nonce in the page and the CSP of every index.html response', async () => {
    await staticKit();
    const a = await kit.call({ method: 'GET', url: '/' });
    const b = await kit.call({ method: 'GET', url: '/some/spa/route' });
    const na = nonceOf(a.headers['content-security-policy'] as string);
    const nb = nonceOf(b.headers['content-security-policy'] as string);
    expect(na).toBeDefined();
    expect(a.body).toContain(`content="${na}"`);
    expect(b.body).toContain(`content="${nb}"`);
    expect(a.body).not.toContain('__CSP_NONCE__');
    expect(na).not.toBe(nb);
  });

  it('keeps unsafe-inline out and leaves non-HTML responses on the plain policy', async () => {
    await staticKit();
    for (const url of ['/assets/a.js', '/health', '/api/me', '/nope.png']) {
      const csp = (await kit.call({ method: 'GET', url })).headers['content-security-policy'] as string;
      expect(csp, url).toContain("style-src 'self';");
      expect(csp, url).not.toContain('nonce');
    }
    const page = (await kit.call({ method: 'GET', url: '/' })).headers['content-security-policy'] as string;
    expect(page).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(page).toContain("script-src 'self';");
  });
});
